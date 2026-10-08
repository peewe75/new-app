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
) {
    val info: CallFileInfo get() = CallFile.parse(name)
}

/**
 * Elenco delle registrazioni viste dall'app, in un file privato dell'app.
 * Interfaccia e lavori in background condividono la stessa istanza (stesso processo).
 */
object RecordingStore {
    private const val MAX_ENTRIES = 500
    private val lock = Any()
    private var file: File? = null
    private val state = MutableStateFlow<List<RecEntry>>(emptyList())
    val entries: StateFlow<List<RecEntry>> = state

    fun init(context: Context) = synchronized(lock) {
        if (file == null) {
            val f = File(context.applicationContext.filesDir, "registrazioni.json")
            file = f
            state.value = load(f)
        }
    }

    fun get(docId: String): RecEntry? = state.value.firstOrNull { it.docId == docId }

    fun all(): List<RecEntry> = state.value

    fun put(entry: RecEntry) = synchronized(lock) {
        save(listOf(entry) + state.value.filter { it.docId != entry.docId })
    }

    fun update(docId: String, change: (RecEntry) -> RecEntry): RecEntry? = synchronized(lock) {
        val current = state.value.firstOrNull { it.docId == docId } ?: return@synchronized null
        val updated = change(current)
        save(state.value.map { if (it.docId == docId) updated else it })
        updated
    }

    private fun save(list: List<RecEntry>) {
        val sorted = list.sortedByDescending { it.lastModified }.take(MAX_ENTRIES)
        state.value = sorted
        val f = file ?: return
        val array = JSONArray()
        sorted.forEach { array.put(toJson(it)) }
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeText(array.toString())
        if (!tmp.renameTo(f)) {
            f.writeText(array.toString())
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
        )
    }.getOrNull()

    private fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key)) null else optString(key)
}
