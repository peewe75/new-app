package it.seguito.app

import java.net.URI

/**
 * Indirizzo del server di Seguito. HTTPS sempre ammesso; HTTP solo verso reti
 * private (Wi-Fi dello studio) o Tailscale, perché la password viaggia in ogni
 * richiesta e su Internet senza HTTPS sarebbe leggibile.
 */
object ServerUrl {
    sealed interface Result {
        data class Valid(val baseUrl: String, val insecureLan: Boolean) : Result
        data class Invalid(val message: String) : Result
    }

    fun validate(input: String): Result {
        val text = input.trim().trimEnd('/')
        if (text.isEmpty()) return Result.Invalid("Indicare l'indirizzo di Seguito, per esempio http://192.168.1.20:3000.")
        val uri = try {
            URI(if (text.contains("://")) text else "http://$text")
        } catch (e: Exception) {
            return Result.Invalid("Indirizzo non valido.")
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase() ?: return Result.Invalid("Indirizzo non valido: manca il nome del computer.")
        if (uri.userInfo != null) return Result.Invalid("Non inserire nome utente o password nell'indirizzo.")
        if (!uri.rawQuery.isNullOrEmpty() || !uri.rawFragment.isNullOrEmpty()) {
            return Result.Invalid("Indicare solo l'indirizzo di Seguito, senza parametri.")
        }
        val path = (uri.rawPath ?: "").trimEnd('/')
        val port = if (uri.port == -1) "" else ":${uri.port}"
        val base = "$scheme://${if (host.contains(':')) "[$host]" else host}$port$path"
        return when (scheme) {
            "https" -> Result.Valid(base, insecureLan = false)
            "http" ->
                if (isPrivateHost(host)) {
                    Result.Valid(base, insecureLan = true)
                } else {
                    Result.Invalid(
                        "Con HTTP sono ammessi solo indirizzi della rete dello studio (192.168.x.x, 10.x.x.x) o di Tailscale: " +
                            "per Internet serve HTTPS.",
                    )
                }
            else -> Result.Invalid("L'indirizzo deve iniziare con http:// o https://.")
        }
    }

    /** Reti private IPv4, Tailscale (100.64.0.0/10 e *.ts.net) e nomi locali (.lan, .local). */
    fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']')
        if (h.endsWith(".ts.net") || h.endsWith(".lan") || h.endsWith(".local") || h.endsWith(".home.arpa")) return true
        val parts = h.split('.').map { it.toIntOrNull() ?: return false }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return false
        val (a, b) = parts
        return a == 10 ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) ||
            (a == 100 && b in 64..127)
    }
}
