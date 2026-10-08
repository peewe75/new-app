package it.seguito.app

/**
 * Controllo che un file MP4/M4A sia completo: il registratore scrive l'indice
 * («moov») solo quando la registrazione è salvata. Un file ancora in scrittura
 * (o in pausa) non ha l'indice, oppure ha un blocco audio che supera la fine del file.
 */
object Mp4 {
    private val extensions = setOf("m4a", "mp4", "3gp", "3ga")

    /** true per i formati MP4, per i quali il controllo ha senso. */
    fun applies(fileName: String): Boolean = fileName.substringAfterLast('.', "").lowercase() in extensions

    /**
     * Scorre i blocchi principali del file. `read(posizione, buffer)` legge fino a
     * buffer.size byte dalla posizione indicata e restituisce quanti ne ha letti.
     */
    fun isComplete(size: Long, read: (Long, ByteArray) -> Int): Boolean {
        if (size < 8) return false
        val header = ByteArray(16)
        var pos = 0L
        var hasMoov = false
        var boxes = 0
        while (pos < size) {
            if (++boxes > MAX_BOXES || size - pos < 8) return false
            if (read(pos, header) < 8) return false
            var boxSize = u32(header, 0)
            val type = String(header, 4, 4, Charsets.ISO_8859_1)
            var headerSize = 8L
            when (boxSize) {
                0L -> return false // blocco «fino alla fine del file»: scrittura non conclusa
                1L -> {
                    if (read(pos, header) < 16) return false
                    boxSize = u64(header, 8)
                    headerSize = 16L
                }
            }
            if (boxSize < headerSize || boxSize > size - pos) return false
            if (type == "moov") hasMoov = true
            pos += boxSize
        }
        return hasMoov
    }

    private fun u32(b: ByteArray, at: Int): Long =
        ((b[at].toLong() and 0xFF) shl 24) or ((b[at + 1].toLong() and 0xFF) shl 16) or
            ((b[at + 2].toLong() and 0xFF) shl 8) or (b[at + 3].toLong() and 0xFF)

    private fun u64(b: ByteArray, at: Int): Long = (u32(b, at) shl 32) or u32(b, at + 4)

    private const val MAX_BOXES = 10_000
}
