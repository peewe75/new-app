package it.seguito.app

/**
 * Chiamate da non inviare mai a Seguito. Per l'art. 38, comma 2, del Codice
 * deontologico forense le telefonate con i colleghi non si registrano: se
 * succede, l'app non le invia (contatti salvati come «Avv. …», «Avvocato …»,
 * «Studio legale …»), oltre ai nomi e ai numeri indicati dall'avvocato.
 */
object Exclusions {
    private val lawyerPrefixes = listOf("avv.", "avv ", "avvocato", "avvocata", "studio legale", "studio avv")

    enum class Reason { COLLEGA, ELENCO }

    /** Motivo dell'esclusione, oppure null se la chiamata si può inviare. */
    fun reason(info: CallFileInfo, excludeLawyers: Boolean, rules: List<String>): Reason? {
        val contact = info.contact?.trim()?.lowercase()
        if (excludeLawyers && contact != null && lawyerPrefixes.any { contact.startsWith(it) || contact == it.trim() }) {
            return Reason.COLLEGA
        }
        val digits = info.phoneNumber?.filter { it.isDigit() }
        for (rule in rules.map { it.trim() }.filter { it.isNotEmpty() }) {
            val ruleDigits = rule.filter { it.isDigit() }
            val looksLikeNumber = ruleDigits.length >= 6 && rule.all { it.isDigit() || it in "+ ()-." }
            if (looksLikeNumber) {
                // Confronto sulle ultime 9 cifre: stesso numero con o senza prefisso internazionale.
                if (digits != null && digits.takeLast(9) == ruleDigits.takeLast(9)) return Reason.ELENCO
            } else if (contact != null && contact.contains(rule.lowercase())) {
                return Reason.ELENCO
            }
        }
        return null
    }

    /** Regole da testo libero: una per riga o separate da virgole. */
    fun parseRules(text: String): List<String> =
        text.split('\n', ',', ';').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
}
