package it.seguito.app

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.nio.ByteBuffer

/** File audio nella cartella scelta dall'avvocato (permesso di sola lettura su quella cartella). */
data class FoundFile(
    val docId: String,
    val uri: Uri,
    val name: String,
    val size: Long,
    val lastModified: Long,
    val kind: RecKind,
)

object Scanner {
    private val projection = arrayOf(
        Document.COLUMN_DOCUMENT_ID,
        Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE,
        Document.COLUMN_LAST_MODIFIED,
    )

    /**
     * Registrazioni nella cartella scelta: se è «Recordings» si leggono le
     * sottocartelle «Call» (chiamate) e, se `includeVoice`, «Voice Recorder»
     * (registrazioni vocali); se è già una di queste, tutti i suoi file. File e
     * cartelle nascosti (registrazioni in corso, cestino) non si leggono mai.
     */
    fun scan(context: Context, treeUri: Uri, includeVoice: Boolean): List<FoundFile> {
        val resolver = context.contentResolver
        val found = mutableListOf<FoundFile>()

        fun visit(parentId: String, depth: Int, kind: RecKind?) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
            resolver.query(children, projection, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    if (CallFile.isHidden(name)) continue
                    val mime = cursor.getString(2)
                    if (mime == Document.MIME_TYPE_DIR) {
                        if (depth < 2) visit(id, depth + 1, kind ?: CallFile.folderKind(name))
                    } else if (kind != null && (kind == RecKind.CHIAMATA || includeVoice) && CallFile.isAudio(name)) {
                        found += FoundFile(
                            docId = id,
                            uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id),
                            name = name,
                            size = if (cursor.isNull(3)) -1 else cursor.getLong(3),
                            lastModified = if (cursor.isNull(4)) 0 else cursor.getLong(4),
                            kind = kind,
                        )
                    }
                }
            }
        }

        val rootId = DocumentsContract.getTreeDocumentId(treeUri)
        visit(rootId, 0, CallFile.folderKind(rootId.substringAfter(':').substringAfterLast('/')))
        return found
    }

    /** true se il file MP4 è completo (registrazione salvata); per gli altri formati sempre true. */
    fun isComplete(context: Context, file: FoundFile): Boolean {
        if (!Mp4.applies(file.name) || file.size <= 0) return true
        return runCatching {
            context.contentResolver.openFileDescriptor(file.uri, "r")?.let { pfd ->
                // Lo stream chiude il descrittore quando si chiude il canale.
                ParcelFileDescriptor.AutoCloseInputStream(pfd).channel.use { channel ->
                    Mp4.isComplete(file.size) { pos, buffer ->
                        channel.position(pos)
                        val read = channel.read(ByteBuffer.wrap(buffer))
                        if (read < 0) 0 else read
                    }
                }
            } ?: false
        }.getOrDefault(false)
    }

    /** true se la cartella scelta è solo quella delle chiamate: le registrazioni vocali non sono raggiungibili. */
    fun onlyCalls(treeUri: Uri): Boolean = runCatching {
        CallFile.isCallFolder(DocumentsContract.getTreeDocumentId(treeUri).substringAfter(':').substringAfterLast('/'))
    }.getOrDefault(false)
    }

    /** Percorso leggibile della cartella scelta, es. "Recordings/Call". */
    fun describe(treeUri: Uri): String =
        runCatching { DocumentsContract.getTreeDocumentId(treeUri).substringAfter(':').ifEmpty { "Memoria interna" } }
            .getOrDefault(treeUri.toString())
}
