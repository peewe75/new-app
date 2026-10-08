package it.seguito.app

import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

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

    @Throws(IOException::class)
    fun upload(input: InputStream, size: Long, fileName: String, lastModified: Long, mimeType: String): Response {
        val query = "nome=${URLEncoder.encode(fileName, "UTF-8")}&modificato=$lastModified"
        val connection = open("POST", "/api/telefono/registrazioni?$query")
        try {
            connection.doOutput = true
            connection.readTimeout = 5 * 60_000
            connection.setRequestProperty("Content-Type", mimeType)
            if (size >= 0) connection.setFixedLengthStreamingMode(size) else connection.setChunkedStreamingMode(64 * 1024)
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
        val connection = URL("$baseUrl$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        val credentials = Base64.encodeToString("telefono:$password".toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        connection.setRequestProperty("Authorization", "Basic $credentials")
        connection.setRequestProperty("Accept", "application/json")
        return connection
    }

    private fun read(connection: HttpURLConnection): Response {
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        return Response(code, body)
    }
}
