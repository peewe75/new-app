package it.seguito.app

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Stato di una registrazione trovata sul telefono. */
enum class RecStatus(val label: String) {
    PRECEDENTE("Già presente all'attivazione: non inviata"),
    DA_CONFERMARE("Da confermare"),
    IN_CODA("In attesa di invio"),
    IN_INVIO("Invio in corso"),
    INVIATA("Inviata: trascrizione e analisi in corso"),
    PRONTA("Proposta pronta da approvare"),
    ERRORE("Errore"),
    NON_INVIATA("Non inviata"),
    ESCLUSA("Esclusa"),
}

data class RecEntry(
    val docId: String,
    val uri: String,
    val name: String,
    val size: Long,
    val lastModified: Long,
    val status: RecStatus,
    val serverId: String? = null,
    val proposalId: String? = null,
    val message: String? = null,
    /** Invio confermato dall'avvocato nonostante l'esclusione («Invia comunque»). */
    val forced: Boolean = false,
    val kind: RecKind = RecKind.CHIAMATA,
    /** Titolo scelto dall'avvocato (registrazioni vocali), inviato a Seguito. */
    val title: String? = null,
) {
    val info: CallFileInfo get() = CallFile.parse(name)

    /** Nome da mostrare: contatto o numero per le chiamate, titolo o nome del file per le registrazioni vocali. */
    val label: String
        get() = if (kind == RecKind.VOCALE) CallFile.voiceLabel(name, title) else info.label
}

/**
 * Elenco delle registrazioni viste dall'app, in un file privato dell'app.
 * Interfaccia e lavori in background condividono la stessa istanza (stesso processo).
 *
 * L'elenco mostra le registrazioni più recenti; a parte resta l'insieme di
 * tutte quelle già viste, così una registrazione uscita dall'elenco non torna
 * a essere «nuova» (nessuna richiesta di invio per le chiamate vecchie).
 */
object RecordingStore {
    private const val MAX_ENTRIES = 500
    private const val MAX_SEEN = 50_000
    private val ACTIVE = setOf(RecStatus.DA_CONFERMARE, RecStatus.IN_CODA, RecStatus.IN_INVIO, RecStatus.INVIATA)
    private val lock = Any()
    private var file: File? = null
    private var seenFile: File? = null
    private val seen = LinkedHashSet<String>()
    private val state = MutableStateFlow<List<RecEntry>>(emptyList())
    val entries: StateFlow<List<RecEntry>> = state

    fun init(context: Context) = synchronized(lock) {
        if (file == null) {
            val dir = context.applicationContext.filesDir
            val f = File(dir, "registrazioni.json")
            file = f
            seenFile = File(dir, "registrazioni-viste.txt")
            state.value = load(f)
            seen += loadSeen()
            seen += state.value.map { it.docId }
        }
    }

    fun get(docId: String): RecEntry? = state.value.firstOrNull { it.docId == docId }

    /**
     * true se la registrazione è già stata vista, anche se non è più nell'elenco o è
     * stata rinominata (nuovo docId, stessi dimensione e data del file).
     */
    fun isKnown(docId: String, size: Long, lastModified: Long): Boolean =
        synchronized(lock) { docId in seen || fingerprint(size, lastModified) in seen }

    fun all(): List<RecEntry> = state.value

    /**
     * Registrazione rinominata dopo il rilevamento (nuovo docId, stessi dimensione e data,
     * vecchio file sparito): la voce esistente punta al nuovo file. Il docId resta la chiave
     * di lavori, notifiche ed elenco; cambiano solo indirizzo e nome.
     */
    fun relinkRenamed(file: FoundFile, presentUris: Set<String>): Boolean = synchronized(lock) {
        if (file.size <= 0 || file.docId in seen) return@synchronized false
        val old = state.value.firstOrNull {
            it.kind == file.kind && it.size == file.size && it.lastModified == file.lastModified && it.uri !in presentUris
        } ?: return@synchronized false
        seen.add(file.docId)
        while (seen.size > MAX_SEEN) seen.remove(seen.first())
        saveSeen()
        save(state.value.map { if (it.docId == old.docId) it.copy(uri = file.uri.toString(), name = file.name) else it })
        true
    }

    fun put(entry: RecEntry) = synchronized(lock) {
        val addedId = seen.add(entry.docId)
        val addedFingerprint = entry.size > 0 && seen.add(fingerprint(entry.size, entry.lastModified))
        if (addedId || addedFingerprint) {
            while (seen.size > MAX_SEEN) seen.remove(seen.first())
            saveSeen()
        }
        save(listOf(entry) + state.value.filter { it.docId != entry.docId })
    }

    fun update(docId: String, change: (RecEntry) -> RecEntry): RecEntry? = synchronized(lock) {
        val current = state.value.firstOrNull { it.docId == docId } ?: return@synchronized null
        val updated = change(current)
        save(state.value.map { if (it.docId == docId) updated else it })
        updated
    }

    private fun save(list: List<RecEntry>) {
        // Le registrazioni ancora in lavorazione restano nell'elenco anche oltre il limite.
        val sorted = list.sortedByDescending { it.lastModified }
            .filterIndexed { index, entry -> index < MAX_ENTRIES || entry.status in ACTIVE }
        state.value = sorted
        val f = file ?: return
        val array = JSONArray()
        sorted.forEach { array.put(toJson(it)) }
        writeAtomic(f, array.toString())
    }

    private fun fingerprint(size: Long, lastModified: Long) = "#$size:$lastModified"

    private fun saveSeen() {
        val f = seenFile ?: return
        writeAtomic(f, seen.joinToString("\n"))
    }

    private fun loadSeen(): List<String> = runCatching {
        val f = seenFile
        if (f == null || !f.exists()) emptyList() else f.readLines().filter { it.isNotBlank() }
    }.getOrDefault(emptyList())

    private fun writeAtomic(f: File, text: String) {
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(f)) {
            f.writeText(text)
            tmp.delete()
        }
    }

    private fun load(f: File): List<RecEntry> = runCatching {
        if (!f.exists()) return@runCatching emptyList()
        val array = JSONArray(f.readText())
        (0 until array.length()).mapNotNull { fromJson(array.getJSONObject(it)) }
    }.getOrDefault(emptyList())

    private fun toJson(e: RecEntry) = JSONObject()
        .put("docId", e.docId)
        .put("uri", e.uri)
        .put("name", e.name)
        .put("size", e.size)
        .put("lastModified", e.lastModified)
        .put("status", e.status.name)
        .put("serverId", e.serverId ?: JSONObject.NULL)
        .put("proposalId", e.proposalId ?: JSONObject.NULL)
        .put("message", e.message ?: JSONObject.NULL)
        .put("forced", e.forced)
        .put("kind", e.kind.name)
        .put("title", e.title ?: JSONObject.NULL)

    private fun fromJson(o: JSONObject): RecEntry? = runCatching {
        RecEntry(
            docId = o.getString("docId"),
            uri = o.getString("uri"),
            name = o.getString("name"),
            size = o.optLong("size", -1),
            lastModified = o.optLong("lastModified", 0),
            status = RecStatus.valueOf(o.getString("status")),
            serverId = o.optStringOrNull("serverId"),
            proposalId = o.optStringOrNull("proposalId"),
            message = o.optStringOrNull("message"),
            forced = o.optBoolean("forced", false),
            kind = runCatching { RecKind.valueOf(o.optString("kind", RecKind.CHIAMATA.name)) }.getOrDefault(RecKind.CHIAMATA),
            title = o.optStringOrNull("title"),
        )
    }.getOrNull()

    private fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key)) null else optString(key)
}
