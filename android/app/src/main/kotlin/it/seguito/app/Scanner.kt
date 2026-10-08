package it.seguito.app

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document

/** File audio nella cartella scelta dall'avvocato (permesso di sola lettura su quella cartella). */
data class FoundFile(val docId: String, val uri: Uri, val name: String, val size: Long, val lastModified: Long)

object Scanner {
    private val projection = arrayOf(
        Document.COLUMN_DOCUMENT_ID,
        Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE,
        Document.COLUMN_LAST_MODIFIED,
    )

    /**
     * Chiamate registrate nella cartella scelta: se è «Recordings» si legge solo
     * la sottocartella «Call» (mai le note vocali); se è già «Call», tutti i suoi file.
     */
    fun scan(context: Context, treeUri: Uri): List<FoundFile> {
        val resolver = context.contentResolver
        val found = mutableListOf<FoundFile>()

        fun visit(parentId: String, depth: Int, inCalls: Boolean) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
            resolver.query(children, projection, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    val mime = cursor.getString(2)
                    if (mime == Document.MIME_TYPE_DIR) {
                        if (depth < 2) visit(id, depth + 1, inCalls || CallFile.isCallFolder(name))
                    } else if (inCalls && CallFile.isAudio(name)) {
                        found += FoundFile(
                            docId = id,
                            uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id),
                            name = name,
                            size = if (cursor.isNull(3)) -1 else cursor.getLong(3),
                            lastModified = if (cursor.isNull(4)) 0 else cursor.getLong(4),
                        )
                    }
                }
            }
        }

        val rootId = DocumentsContract.getTreeDocumentId(treeUri)
        visit(rootId, 0, CallFile.isCallFolder(rootId.substringAfter(':').substringAfterLast('/')))
        return found
    }

    /** Percorso leggibile della cartella scelta, es. "Recordings/Call". */
    fun describe(treeUri: Uri): String =
        runCatching { DocumentsContract.getTreeDocumentId(treeUri).substringAfter(':').ifEmpty { "Memoria interna" } }
            .getOrDefault(treeUri.toString())
}
