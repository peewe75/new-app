package it.seguito.app

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.FileNotFoundException
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Programmazione dei lavori in background. */
object Jobs {
    const val KEY_DOC = "docId"
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Controllo della cartella ogni 15 minuti (il minimo di Android), oltre a quello dopo ogni chiamata. */
    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("controllo", ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun syncNow(context: Context, delaySeconds: Long = 0) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>().setInitialDelay(delaySeconds, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("controllo-subito", ExistingWorkPolicy.REPLACE, request)
    }

    fun upload(context: Context, docId: String) {
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(workDataOf(KEY_DOC to docId))
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("invio-$docId", ExistingWorkPolicy.KEEP, request)
    }

    /** Annulla un invio ancora in coda. */
    fun cancelUpload(context: Context, docId: String) {
        WorkManager.getInstance(context).cancelUniqueWork("invio-$docId")
    }

    fun watchStatus(context: Context, docId: String, delayMinutes: Long = 1) {
        val request = OneTimeWorkRequestBuilder<StatusWorker>()
            .setInputData(workDataOf(KEY_DOC to docId))
            .setConstraints(network)
            .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 2, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("stato-$docId", ExistingWorkPolicy.KEEP, request)
    }

    /**
     * Avviso al prossimo cambiamento di un file audio (vedi MediaTriggerWorker).
     * `afterCurrent`: chiamato dal lavoro in esecuzione, che va sostituito dopo la fine.
     */
    fun armMediaTrigger(context: Context, afterCurrent: Boolean = false) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(10, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(1, TimeUnit.MINUTES)
            .build()
        val request = OneTimeWorkRequestBuilder<MediaTriggerWorker>().setConstraints(constraints).build()
        val policy = if (afterCurrent) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP
        WorkManager.getInstance(context).enqueueUniqueWork("avviso-audio", policy, request)
    }

    /** Indirizzo della proposta nell'interfaccia di Seguito. */
    fun proposalUrl(baseUrl: String, proposalId: String): String =
        "$baseUrl/#/p/${URLEncoder.encode(proposalId, "UTF-8").replace("+", "%20")}"
}

/**
 * Cerca le nuove registrazioni. Chiamate: invio automatico o conferma, secondo le
 * impostazioni. Registrazioni vocali: sempre conferma (il nome del file non dice
 * chi c'è nella registrazione), con un titolo facoltativo.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        RecordingStore.init(context)
        val settings = AppSettings(context)
        val tree = settings.treeUri ?: return@withContext Result.success()
        val includeVoice = settings.voiceEnabled
        val files = try {
            Scanner.scan(context, tree, includeVoice)
        } catch (e: SecurityException) {
            // Permesso sulla cartella revocato: l'app lo segnala nella schermata principale.
            return@withContext Result.success()
        }
        // Alla prima lettura (della cartella, o delle registrazioni vocali appena attivate)
        // quelle già presenti non si inviano.
        val firstCalls = !settings.baselineDone
        val firstVoice = includeVoice && !settings.voiceBaselineDone
        val rules = Exclusions.parseRules(settings.exclusionRules)
        val now = System.currentTimeMillis()
        var callStillWriting = false
        for (file in files) {
            if (RecordingStore.isKnown(file.docId, file.size, file.lastModified)) continue
            val firstScan = if (file.kind == RecKind.VOCALE) firstVoice else firstCalls
            if (!firstScan) {
                val age = now - file.lastModified
                // Un file modificato negli ultimi secondi può essere ancora in scrittura (una data futura no).
                if (age in 0 until SETTLE_MS) {
                    if (file.kind == RecKind.CHIAMATA) callStillWriting = true
                    continue
                }
                // Registrazione non ancora salvata (indice MP4 mancante): si riprova al prossimo controllo.
                // Dopo mezz'ora senza modifiche si accetta comunque, per non perdere file di formato insolito.
                if (age in 0 until INCOMPLETE_GRACE_MS && !Scanner.isComplete(context, file)) continue
            }
            val entry = classify(file, firstScan, settings, rules)
            RecordingStore.put(entry)
            when (entry.status) {
                RecStatus.IN_CODA -> Jobs.upload(context, entry.docId)
                RecStatus.DA_CONFERMARE -> Notifications.askToSend(context, entry)
                else -> Unit
            }
        }
        if (firstCalls) settings.baselineDone = true
        if (firstVoice) settings.voiceBaselineDone = true
        // Solo per le chiamate, brevi: una riunione in corso non va controllata ogni 30 secondi.
        if (callStillWriting) Jobs.syncNow(context, 30)
        // Riprende gli invii in coda e il controllo delle registrazioni già inviate (per esempio dopo un riavvio).
        RecordingStore.all().filter { it.status == RecStatus.IN_CODA }.forEach { Jobs.upload(context, it.docId) }
        RecordingStore.all().filter { it.status == RecStatus.INVIATA }.forEach { Jobs.watchStatus(context, it.docId, 0) }
        Jobs.armMediaTrigger(context)
        Result.success()
    }

    private fun classify(file: FoundFile, firstScan: Boolean, settings: AppSettings, rules: List<String>): RecEntry {
        val reason = if (file.kind == RecKind.VOCALE) {
            Exclusions.voiceReason(file.name, null, rules)
        } else {
            Exclusions.reason(CallFile.parse(file.name), settings.excludeLawyers, rules)
        }
        val status = when {
            firstScan -> RecStatus.PRECEDENTE
            reason != null -> RecStatus.ESCLUSA
            file.kind == RecKind.CHIAMATA && settings.mode == SendMode.AUTOMATICO -> RecStatus.IN_CODA
            else -> RecStatus.DA_CONFERMARE
        }
        val message = if (firstScan || reason == null) null else Exclusions.message(reason)
        return RecEntry(
            docId = file.docId,
            uri = file.uri.toString(),
            name = file.name,
            size = file.size,
            lastModified = file.lastModified,
            status = status,
            message = message,
            kind = file.kind,
        )
    }

    private companion object {
        const val SETTLE_MS = 15_000L
        const val INCOMPLETE_GRACE_MS = 30 * 60_000L
    }
}

/**
 * Avviso dal sistema quando cambia un file audio nella memoria del telefono (per
 * esempio il Registratore vocale salva una registrazione): fa partire subito il
 * controllo della cartella. Non serve alcun permesso: l'app non legge l'avviso,
 * lo usa solo come segnale. Si riprogramma a ogni esecuzione.
 */
class MediaTriggerWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        Jobs.syncNow(applicationContext)
        Jobs.armMediaTrigger(applicationContext, afterCurrent = true)
        // Sempre successo: con un errore il lavoro accodato dopo questo verrebbe annullato.
        return Result.success()
    }
}

/** Invia l'audio a Seguito. Dopo l'invio l'audio resta sul telefono: Seguito lo cancella dopo la trascrizione. */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        RecordingStore.init(context)
        val docId = inputData.getString(Jobs.KEY_DOC) ?: return@withContext Result.failure()
        val entry = RecordingStore.get(docId) ?: return@withContext Result.failure()
        // Solo le registrazioni in coda: una annullata («Non inviare») o già inviata non parte.
        if (entry.status != RecStatus.IN_CODA && entry.status != RecStatus.IN_INVIO) return@withContext Result.success()
        val settings = AppSettings(context)
        // Le esclusioni valgono anche per le registrazioni già in coda (regole aggiunte dopo),
        // salvo conferma esplicita dell'avvocato con «Invia comunque».
        if (!entry.forced) {
            val rules = Exclusions.parseRules(settings.exclusionRules)
            val reason = if (entry.kind == RecKind.VOCALE) {
                Exclusions.voiceReason(entry.name, entry.title, rules)
            } else {
                Exclusions.reason(entry.info, settings.excludeLawyers, rules)
            }
            if (reason != null) {
                RecordingStore.update(docId) { it.copy(status = RecStatus.ESCLUSA, message = Exclusions.message(reason)) }
                return@withContext Result.success()
            }
        }
        val baseUrl = settings.baseUrl
            ?: return@withContext fail(entry, "Indirizzo di Seguito mancante o non valido: correggerlo nelle impostazioni.")
        RecordingStore.update(docId) { it.copy(status = RecStatus.IN_INVIO, message = null) }
        val client = SeguitoClient(baseUrl, settings.password)
        val uri = Uri.parse(entry.uri)
        val response = try {
            val durationMs = durationOf(uri)
            context.contentResolver.openInputStream(uri)?.use { input ->
                client.upload(
                    input,
                    SeguitoClient.UploadMeta(
                        size = entry.size,
                        fileName = entry.name,
                        lastModified = entry.lastModified,
                        durationMs = durationMs,
                        mimeType = CallFile.mimeType(entry.name),
                        voice = entry.kind == RecKind.VOCALE,
                        title = entry.title,
                    ),
                )
            } ?: return@withContext fail(entry, MISSING_FILE)
        } catch (e: SecurityException) {
            return@withContext fail(entry, "Permesso sulla cartella delle registrazioni revocato: sceglierla di nuovo nell'app.")
        } catch (e: FileNotFoundException) {
            return@withContext fail(entry, MISSING_FILE)
        } catch (e: InsecureHostException) {
            return@withContext fail(entry, e.message ?: "Indirizzo di Seguito non sicuro.")
        } catch (e: IOException) {
            // Senza rete (per esempio fuori studio senza Tailscale) si riprova senza limite:
            // WorkManager allunga le attese fino a 5 ore e riparte quando torna la connessione.
            RecordingStore.update(entry.docId) {
                it.copy(status = RecStatus.IN_CODA, message = "Seguito non raggiungibile: nuovo tentativo appena c'è rete.")
            }
            return@withContext Result.retry()
        }
        when {
            response.ok -> {
                val json = response.json() ?: return@withContext fail(entry, "Risposta di Seguito non valida.")
                val serverId = json.optString("id").takeIf { it.isNotBlank() }
                    ?: return@withContext fail(entry, "Risposta di Seguito non valida.")
                val ready = json.optString("status") == "pronta"
                val proposalId = json.optString("proposalId").takeIf { ready && it.isNotBlank() && it != "null" }
                val updated = RecordingStore.update(docId) {
                    it.copy(
                        status = if (proposalId != null) RecStatus.PRONTA else RecStatus.INVIATA,
                        serverId = serverId,
                        proposalId = proposalId,
                        message = null,
                    )
                }
                if (proposalId != null && updated != null) {
                    Notifications.proposalReady(context, updated, Jobs.proposalUrl(baseUrl, proposalId))
                } else {
                    Jobs.watchStatus(context, docId)
                }
                Result.success()
            }
            response.code == 401 -> fail(entry, "Password di Seguito errata: correggerla nelle impostazioni dell'app.")
            response.code == 503 || response.code >= 500 ->
                retryOrFail(entry, response.error ?: "Seguito non è pronto a ricevere: nuovo tentativo più tardi.")
            else -> fail(entry, response.error ?: "Invio rifiutato da Seguito (codice ${response.code}).")
        }
    }

    /** Durata dell'audio, se il file la indica: serve al server quando il nome non contiene l'ora. */
    private fun durationOf(uri: Uri): Long? = runCatching {
        MediaMetadataRetriever().use { retriever ->
            retriever.setDataSource(applicationContext, uri)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        }
    }.getOrNull()

    private fun retryOrFail(entry: RecEntry, message: String): Result {
        if (runAttemptCount >= MAX_ATTEMPTS) return fail(entry, message)
        RecordingStore.update(entry.docId) { it.copy(status = RecStatus.IN_CODA, message = message) }
        return Result.retry()
    }

    private fun fail(entry: RecEntry, message: String): Result {
        val updated = RecordingStore.update(entry.docId) { it.copy(status = RecStatus.ERRORE, message = message) } ?: entry
        Notifications.failed(applicationContext, updated, message)
        return Result.failure()
    }

    private companion object {
        const val MAX_ATTEMPTS = 8
        const val MISSING_FILE = "Il file non è più disponibile sul telefono."
    }
}

/** Controlla su Seguito se la proposta è pronta e lo notifica. */
class StatusWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        RecordingStore.init(context)
        val docId = inputData.getString(Jobs.KEY_DOC) ?: return@withContext Result.failure()
        val entry = RecordingStore.get(docId) ?: return@withContext Result.success()
        val serverId = entry.serverId
        if (entry.status != RecStatus.INVIATA || serverId == null) return@withContext Result.success()
        val settings = AppSettings(context)
        val baseUrl = settings.baseUrl ?: return@withContext Result.success()
        val response = try {
            SeguitoClient(baseUrl, settings.password).status(serverId)
        } catch (e: IOException) {
            return@withContext again()
        }
        val json = response.json()
        val status = json?.optString("status")
        val message = json?.optString("message")?.takeIf { it.isNotBlank() && it != "null" }
        when {
            response.ok && status == "pronta" -> {
                val proposalId = json?.optString("proposalId")?.takeIf { it.isNotBlank() && it != "null" }
                val updated = RecordingStore.update(docId) { it.copy(status = RecStatus.PRONTA, proposalId = proposalId, message = null) }
                if (updated != null && proposalId != null) {
                    Notifications.proposalReady(context, updated, Jobs.proposalUrl(baseUrl, proposalId))
                }
                Result.success()
            }
            response.ok && status == "errore" -> {
                val reason = message ?: "Elaborazione non riuscita su Seguito."
                val updated = RecordingStore.update(docId) { it.copy(status = RecStatus.ERRORE, message = reason) }
                if (updated != null) Notifications.failed(context, updated, reason)
                Result.success()
            }
            response.ok -> {
                RecordingStore.update(docId) { it.copy(message = message) }
                again()
            }
            response.code == 404 -> {
                // Il server non la conosce più: «Riprova» invierà di nuovo l'audio.
                RecordingStore.update(docId) {
                    it.copy(
                        status = RecStatus.ERRORE,
                        serverId = null,
                        message = "Registrazione non trovata su Seguito: toccare «Riprova» per inviarla di nuovo.",
                    )
                }
                Result.success()
            }
            else -> again()
        }
    }

    /** Nuovo controllo più tardi; dopo molti tentativi ci pensa il controllo periodico. */
    private fun again(): Result = if (runAttemptCount >= MAX_ATTEMPTS) Result.success() else Result.retry()

    private companion object {
        const val MAX_ATTEMPTS = 30
    }
}
