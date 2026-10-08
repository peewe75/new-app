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

/** chiamata: app Telefono (Recordings/Call); vocale: Registratore vocale (Recordings/Voice Recorder), per esempio riunioni. */
enum class RecKind { CHIAMATA, VOCALE }

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

    private val callFolder = Regex("""^calls?(\s*recordings?)?$""", RegexOption.IGNORE_CASE)
    private val voiceFolder = Regex("""^(voice\s*recorder|voice\s*recordings?|registratore(\s*vocale)?)$""", RegexOption.IGNORE_CASE)

    /** Nomi predefiniti del Registratore vocale, che non dicono nulla del contenuto (es. "Voce 260822_181740"). */
    private val genericVoiceName = Regex(
        """^(voce|voice|registrazione( vocale)?|nota vocale|nota|memo( vocale)?|recording|rec|audio|interview|intervista)?[ _-]*[\d _-]*$""",
        RegexOption.IGNORE_CASE,
    )

    /** Cartella delle chiamate registrate: sul Samsung «Recordings/Call». */
    fun isCallFolder(name: String): Boolean = callFolder.matches(name.trim())

    /** Cartella del Registratore vocale: sul Samsung «Recordings/Voice Recorder» (nome non tradotto). */
    fun isVoiceFolder(name: String): Boolean = voiceFolder.matches(name.trim())

    /** Tipo di registrazione secondo la cartella, oppure null per le cartelle da non leggere. */
    fun folderKind(name: String): RecKind? = when {
        isCallFolder(name) -> RecKind.CHIAMATA
        isVoiceFolder(name) -> RecKind.VOCALE
        else -> null
    }

    /**
     * File e cartelle nascosti (nome che inizia con il punto): registrazioni in corso,
     * file in attesa (".pending-…") o nel cestino (".trashed-…"). Non si leggono mai.
     */
    fun isHidden(name: String): Boolean = name.startsWith(".")

    /** Nome da mostrare per una registrazione vocale: il titolo scelto, il nome del file se dice qualcosa, oppure un testo generico. */
    fun voiceLabel(fileName: String, title: String?): String {
        title?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val base = fileName.substringAfterLast('/').replace(Regex("""\.[A-Za-z0-9]{1,5}$"""), "").replace('_', ' ').trim()
        return if (base.isEmpty() || genericVoiceName.matches(base)) "Registrazione vocale" else base
    }

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
