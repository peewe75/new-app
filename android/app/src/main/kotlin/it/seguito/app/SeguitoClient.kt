package it.seguito.app

import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.net.URLEncoder

/** HTTP verso un nome che non porta alla rete dello studio o a Tailscale: password e audio viaggerebbero in chiaro. */
class InsecureHostException(message: String) : IOException(message)

/** Chiamate al server di Seguito, con la password dello studio (autenticazione HTTP Basic). */
class SeguitoClient(private val baseUrl: String, private val password: String) {

    data class Response(val code: Int, val body: String) {
        val ok: Boolean get() = code in 200..299

        fun json(): JSONObject? = runCatching { JSONObject(body) }.getOrNull()

        /** Messaggio di errore del server (già in italiano), se presente. */
        val error: String? get() = json()?.optString("error")?.takeIf { it.isNotBlank() }
    }

    @Throws(IOException::class)
    fun config(): Response = request("GET", "/api/config")

    @Throws(IOException::class)
    fun status(serverId: String): Response =
        request("GET", "/api/telefono/registrazioni/${URLEncoder.encode(serverId, "UTF-8")}")

    /** Ripete l'elaborazione di una registrazione rimasta in errore sul server. */
    @Throws(IOException::class)
    fun retry(serverId: String): Response {
        val connection = open("POST", "/api/telefono/registrazioni/${URLEncoder.encode(serverId, "UTF-8")}/riprova")
        try {
            val body = "{}".toByteArray(Charsets.UTF_8)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            return read(connection)
        } finally {
            connection.disconnect()
        }
    }

    /** Dati della registrazione inviati con l'audio. */
    data class UploadMeta(
        val size: Long,
        val fileName: String,
        val lastModified: Long,
        val durationMs: Long?,
        val mimeType: String,
        /** Registrazione del Registratore vocale (riunione, appunto) invece di una chiamata. */
        val voice: Boolean = false,
        /** Titolo scelto dall'avvocato, per le registrazioni vocali. */
        val title: String? = null,
    )

    @Throws(IOException::class)
    fun upload(input: InputStream, meta: UploadMeta): Response {
        val query = buildString {
            append("nome=").append(URLEncoder.encode(meta.fileName, "UTF-8"))
            append("&modificato=").append(meta.lastModified)
            if (meta.durationMs != null && meta.durationMs > 0) append("&durata=").append(meta.durationMs)
            if (meta.voice) {
                append("&tipo=vocale")
                meta.title?.trim()?.takeIf { it.isNotEmpty() }?.let { append("&titolo=").append(URLEncoder.encode(it, "UTF-8")) }
            }
        }
        val connection = open("POST", "/api/telefono/registrazioni?$query")
        try {
            connection.doOutput = true
            connection.readTimeout = 5 * 60_000
            connection.setRequestProperty("Content-Type", meta.mimeType)
            if (meta.size >= 0) connection.setFixedLengthStreamingMode(meta.size) else connection.setChunkedStreamingMode(64 * 1024)
            connection.outputStream.use { out -> input.copyTo(out, 64 * 1024) }
            return read(connection)
        } finally {
            connection.disconnect()
        }
    }

    private fun request(method: String, path: String): Response {
        val connection = open(method, path)
        try {
            return read(connection)
        } finally {
            connection.disconnect()
        }
    }

    private fun open(method: String, path: String): HttpURLConnection {
        val url = URL("$baseUrl$path")
        checkCleartextTarget(url)
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        val credentials = Base64.encodeToString("telefono:$password".toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        connection.setRequestProperty("Authorization", "Basic $credentials")
        connection.setRequestProperty("Accept", "application/json")
        return connection
    }

    /**
     * Con HTTP un nome (es. pc-studio.lan) deve portare a un indirizzo privato o di
     * Tailscale: su una rete estranea un DNS ostile potrebbe indirizzarlo a Internet.
     */
    private fun checkCleartextTarget(url: URL) {
        if (url.protocol != "http") return
        val host = url.host.trim('[', ']')
        if (ServerUrl.isPrivateIpv4(host)) return
        val addresses = InetAddress.getAllByName(host)
        if (addresses.isEmpty() || !addresses.all { ServerUrl.isPrivateAddress(it) }) {
            throw InsecureHostException(
                "Il nome $host non porta alla rete dello studio o a Tailscale: invio bloccato per non mandare la password in chiaro. " +
                    "Usare l'indirizzo IP del computer o HTTPS.",
            )
        }
    }

    private fun read(connection: HttpURLConnection): Response {
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        return Response(code, body)
    }
}
