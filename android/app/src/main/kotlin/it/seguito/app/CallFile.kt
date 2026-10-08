package it.seguito.app

/**
 * Informazioni ricavate dal nome del file di una chiamata registrata.
 * Samsung (One UI): "<prefisso> <contatto o numero>_aaMMgg_hhmmss.m4a", con il
 * prefisso nella lingua del telefono. Stessa logica del server di Seguito.
 */
data class CallFileInfo(
    val contact: String?,
    val phoneNumber: String?,
    /** "YYYY-MM-DDTHH:mm", ora locale del telefono. */
    val startedLocal: String?,
) {
    /** Nome da mostrare: contatto, numero o un testo generico. */
    val label: String
        get() = contact ?: phoneNumber ?: "Numero sconosciuto"
}

object CallFile {
    private val prefixes = listOf(
        "registrazione delle chiamate",
        "registrazione chiamata",
        "chiamata registrata",
        "call recording",
        "registrazione",
        "chiamata",
        "call",
    )
    private val shortStamp = Regex("""^(.*?)[ _-](\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$""")
    private val longStamp = Regex("""^(.*?)[ _-](\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})$""")
    private val phone = Regex("""^\+?[\d\s().-]{6,}$""")
    private val audioExtensions = setOf("m4a", "mp3", "amr", "3gp", "aac", "wav", "ogg", "opus", "mp4")

    fun isAudio(fileName: String): Boolean =
        fileName.substringAfterLast('.', "").lowercase() in audioExtensions

    /** Tipo MIME da inviare al server, dall'estensione. */
    fun mimeType(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
        "m4a", "mp4", "aac" -> "audio/mp4"
        "mp3" -> "audio/mpeg"
        "amr" -> "audio/amr"
        "3gp" -> "audio/3gpp"
        "wav" -> "audio/wav"
        "ogg", "opus" -> "audio/ogg"
        else -> "application/octet-stream"
    }

    fun parse(fileName: String): CallFileInfo {
        val base = fileName.substringAfterLast('/').replace(Regex("""\.[A-Za-z0-9]{1,5}$"""), "").trim()
        val short = shortStamp.find(base)
        val match = short ?: longStamp.find(base) ?: return counterpart(base, null)
        val g = match.groupValues
        val year = if (short != null) "20${g[2]}" else g[2]
        val local = "$year-${g[3]}-${g[4]}T${g[5]}:${g[6]}"
        return counterpart(g[1], local.takeIf { isValidLocal(year, g[3], g[4], g[5], g[6]) })
    }

    private fun counterpart(raw: String, startedLocal: String?): CallFileInfo {
        var text = raw.replace('_', ' ').replace(Regex("""\s+"""), " ").trim()
        val lower = text.lowercase()
        prefixes.firstOrNull { lower == it || lower.startsWith("$it ") }?.let { text = text.substring(it.length).trim() }
        if (text.isEmpty()) return CallFileInfo(null, null, startedLocal)
        val at = text.lastIndexOf('@')
        if (at > 0 && phone.matches(text.substring(at + 1).trim())) {
            return CallFileInfo(text.substring(0, at).trim().ifEmpty { null }, normalizePhone(text.substring(at + 1)), startedLocal)
        }
        if (phone.matches(text)) return CallFileInfo(null, normalizePhone(text), startedLocal)
        return CallFileInfo(text, null, startedLocal)
    }

    private fun normalizePhone(raw: String): String? {
        val trimmed = raw.trim()
        val digits = trimmed.filter { it.isDigit() }
        if (digits.length < 6) return null
        return (if (trimmed.startsWith("+")) "+" else "") + digits
    }

    private fun isValidLocal(year: String, month: String, day: String, hour: String, minute: String): Boolean {
        val y = year.toInt()
        val m = month.toInt()
        val d = day.toInt()
        if (m !in 1..12 || hour.toInt() > 23 || minute.toInt() > 59 || d < 1) return false
        val leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
        return d <= days[m - 1]
    }
}
