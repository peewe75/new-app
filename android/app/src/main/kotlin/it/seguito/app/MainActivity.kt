package it.seguito.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        RecordingStore.init(this)
        setContent {
            SeguitoTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    MainScreen()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // All'apertura dell'app si cercano subito le registrazioni nuove.
        if (AppSettings(this).treeUri != null) Jobs.syncNow(this)
    }
}

@Composable
private fun SeguitoTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val colors = if (isSystemInDarkTheme()) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    MaterialTheme(colorScheme = colors, content = content)
}

@Composable
private fun MainScreen() {
    val context = LocalContext.current
    val settings = remember { AppSettings(context) }
    val entries by RecordingStore.entries.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current

    var serverUrl by remember { mutableStateOf(settings.serverUrl) }
    var password by remember { mutableStateOf(settings.password) }
    var connection by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    var treeUri by remember { mutableStateOf(settings.treeUri) }
    var mode by remember { mutableStateOf(settings.mode) }
    var excludeLawyers by remember { mutableStateOf(settings.excludeLawyers) }
    var rules by remember { mutableStateOf(settings.exclusionRules) }
    var sendingSaved by remember { mutableStateOf(false) }
    var notificationsGranted by remember { mutableStateOf(isGranted(context, Manifest.permission.POST_NOTIFICATIONS)) }
    var phoneGranted by remember { mutableStateOf(isGranted(context, Manifest.permission.READ_PHONE_STATE)) }
    var confirmExcluded by remember { mutableStateOf<RecEntry?>(null) }

    val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            settings.treeUri = uri
            // Le registrazioni già presenti nella nuova cartella non vengono inviate.
            settings.baselineDone = false
            treeUri = uri
            Jobs.syncNow(context)
        }
    }
    val notificationPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsGranted = it }
    val phonePermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { phoneGranted = it }

    fun saveConnection() {
        // Chiude la tastiera, che altrimenti coprirebbe l'esito della verifica.
        focusManager.clearFocus()
        when (val result = ServerUrl.validate(serverUrl)) {
            is ServerUrl.Result.Invalid -> connection = result.message
            is ServerUrl.Result.Valid -> {
                settings.serverUrl = result.baseUrl
                serverUrl = result.baseUrl
                settings.password = password
                testing = true
                scope.launch {
                    val outcome = withContext(Dispatchers.IO) { testConnection(result.baseUrl, password) }
                    connection = if (result.insecureLan) "$outcome\n$LAN_NOTE" else outcome
                    testing = false
                }
            }
        }
    }

    fun send(entry: RecEntry, forced: Boolean = false) {
        Notifications.cancel(context, entry.docId)
        val serverId = entry.serverId
        if (entry.status == RecStatus.ERRORE && serverId != null) {
            // Errore sul server (trascrizione o analisi): si ripete l'elaborazione senza reinviare l'audio.
            RecordingStore.update(entry.docId) { it.copy(status = RecStatus.INVIATA, message = "Nuovo tentativo in corso…") }
            scope.launch {
                val baseUrl = settings.baseUrl
                val outcome = withContext(Dispatchers.IO) {
                    if (baseUrl == null) null else runCatching { SeguitoClient(baseUrl, settings.password).retry(serverId) }.getOrNull()
                }
                if (outcome?.ok == true) {
                    Jobs.watchStatus(context, entry.docId)
                } else if (outcome?.code == 404) {
                    // Il server non la conosce più: si invia di nuovo l'audio.
                    RecordingStore.update(entry.docId) { it.copy(status = RecStatus.IN_CODA, serverId = null, message = null) }
                    Jobs.upload(context, entry.docId)
                } else {
                    RecordingStore.update(entry.docId) {
                        it.copy(status = RecStatus.ERRORE, message = outcome?.error ?: "Seguito non raggiungibile: riprovare più tardi.")
                    }
                }
            }
            return
        }
        RecordingStore.update(entry.docId) {
            it.copy(status = RecStatus.IN_CODA, message = null, serverId = null, forced = forced || it.forced)
        }
        Jobs.upload(context, entry.docId)
    }

    fun cancel(entry: RecEntry) {
        Jobs.cancelUpload(context, entry.docId)
        RecordingStore.update(entry.docId) { it.copy(status = RecStatus.NON_INVIATA, message = "Invio annullato.") }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().safeDrawingPadding(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Seguito", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "Invia a Seguito le chiamate registrate con il telefono: trascrizione, proposta di azioni e approvazione restano in Seguito.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        item {
            Section("1. Collegamento a Seguito") {
                OutlinedTextField(
                    value = serverUrl,
                    onValueChange = { serverUrl = it },
                    label = { Text("Indirizzo di Seguito") },
                    placeholder = { Text("http://192.168.1.20:3000") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password di Seguito (SEGUITO_PASSWORD)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { saveConnection() }, enabled = !testing) { Text("Salva e verifica") }
                    if (testing) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                connection?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
        }

        item {
            val folder = treeUri
            val permissionValid = folder != null &&
                context.contentResolver.persistedUriPermissions.any { it.uri == folder && it.isReadPermission }
            Section("2. Cartella delle registrazioni") {
                Text(
                    when {
                        folder == null -> "Nessuna cartella scelta."
                        !permissionValid -> "Il permesso sulla cartella non è più valido: sceglierla di nuovo."
                        else -> "Cartella: ${Scanner.describe(folder)}"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "Scegli «Recordings» (o «Recordings/Call») nella memoria interna. L'app legge solo le chiamate " +
                        "(cartella «Call», mai le note vocali) e non modifica né cancella le registrazioni. " +
                        "Quelle già presenti non vengono inviate.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = { folderPicker.launch(RECORDINGS_FOLDER) }) { Text("Scegli la cartella") }
            }
        }

        item {
            Section("3. Invio") {
                ChoiceRow("Chiedi conferma per ogni chiamata (consigliato)", mode == SendMode.CONFERMA) {
                    mode = SendMode.CONFERMA
                    sendingSaved = false
                }
                ChoiceRow("Invia in automatico", mode == SendMode.AUTOMATICO) {
                    mode = SendMode.AUTOMATICO
                    sendingSaved = false
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Switch(checked = excludeLawyers, onCheckedChange = {
                        excludeLawyers = it
                        sendingSaved = false
                    })
                    Text(
                        "Non inviare le chiamate con contatti «Avv.», «Avvocato» o «Studio legale» (art. 38, comma 2, CDF)",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                }
                OutlinedTextField(
                    value = rules,
                    onValueChange = {
                        rules = it
                        sendingSaved = false
                    },
                    label = { Text("Non inviare mai: nomi o numeri, uno per riga") },
                    supportingText = {
                        Text(
                            "Per chi è in rubrica scrivi il nome come è salvato: nel file della registrazione il Samsung " +
                                "mette solo il nome, non il numero.",
                        )
                    },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = {
                        focusManager.clearFocus()
                        settings.mode = mode
                        settings.excludeLawyers = excludeLawyers
                        settings.exclusionRules = rules
                        sendingSaved = true
                    }) { Text("Salva") }
                    if (sendingSaved) Text("Salvato.", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        if (!notificationsGranted || !phoneGranted) {
            item {
                Section("4. Permessi") {
                    if (!notificationsGranted) {
                        Text("Le notifiche servono per confermare l'invio e sapere quando la proposta è pronta.", style = MaterialTheme.typography.bodySmall)
                        OutlinedButton(onClick = { notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }) {
                            Text("Consenti le notifiche")
                        }
                    }
                    if (!phoneGranted) {
                        Text(
                            "Facoltativo: con questo permesso l'app sa quando finisce una chiamata e cerca subito la registrazione. " +
                                "Senza, controlla ogni 15 minuti e all'apertura.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        OutlinedButton(onClick = { phonePermission.launch(Manifest.permission.READ_PHONE_STATE) }) {
                            Text("Rileva la fine delle chiamate")
                        }
                    }
                }
            }
        }

        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { Jobs.syncNow(context) }, enabled = treeUri != null) { Text("Controlla ora") }
                OutlinedButton(onClick = { settings.baseUrl?.let { open(context, it) } }, enabled = settings.baseUrl != null) {
                    Text("Apri Seguito")
                }
            }
        }

        item { Text("Registrazioni", style = MaterialTheme.typography.titleLarge) }
        if (entries.isEmpty()) {
            item {
                Text(
                    "Nessuna registrazione ancora. Dopo una chiamata registrata comparirà qui.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(entries, key = { it.docId }) { entry ->
            EntryCard(
                entry = entry,
                onSend = { if (entry.status == RecStatus.ESCLUSA) confirmExcluded = entry else send(entry) },
                onCancel = { cancel(entry) },
                onSkip = {
                    Notifications.cancel(context, entry.docId)
                    RecordingStore.update(entry.docId) { it.copy(status = RecStatus.NON_INVIATA, message = null) }
                },
                onOpen = {
                    val baseUrl = settings.baseUrl
                    val proposalId = entry.proposalId
                    if (baseUrl != null && proposalId != null) open(context, Jobs.proposalUrl(baseUrl, proposalId))
                },
            )
        }
    }

    confirmExcluded?.let { entry ->
        AlertDialog(
            onDismissRequest = { confirmExcluded = null },
            title = { Text("Inviare comunque?") },
            text = {
                Text(
                    "${entry.message ?: "La chiamata è esclusa dall'invio."}\n\nSe la chiamata è con un collega, " +
                        "l'art. 38, comma 2, del Codice deontologico forense vieta di registrarla: in quel caso è meglio cancellarla.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmExcluded = null
                    send(entry, forced = true)
                }) { Text("Invia comunque") }
            },
            dismissButton = { TextButton(onClick = { confirmExcluded = null }) { Text("Annulla") } },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onSelect: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun EntryCard(entry: RecEntry, onSend: () -> Unit, onCancel: () -> Unit, onSkip: () -> Unit, onOpen: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(entry.info.label, style = MaterialTheme.typography.titleMedium)
            Text(
                formatDate(entry.lastModified),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                entry.status.label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = when (entry.status) {
                    RecStatus.ERRORE -> MaterialTheme.colorScheme.error
                    RecStatus.PRONTA -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurface
                },
            )
            entry.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (entry.status) {
                    RecStatus.DA_CONFERMARE -> {
                        Button(onClick = onSend) { Text("Invia a Seguito") }
                        OutlinedButton(onClick = onSkip) { Text("Non inviare") }
                    }
                    RecStatus.PRECEDENTE, RecStatus.NON_INVIATA -> OutlinedButton(onClick = onSend) { Text("Invia a Seguito") }
                    RecStatus.ESCLUSA -> OutlinedButton(onClick = onSend) { Text("Invia comunque") }
                    RecStatus.ERRORE -> Button(onClick = onSend) { Text("Riprova") }
                    RecStatus.PRONTA -> Button(onClick = onOpen) { Text("Apri la proposta") }
                    RecStatus.IN_CODA -> OutlinedButton(onClick = onCancel) { Text("Annulla l'invio") }
                    RecStatus.IN_INVIO, RecStatus.INVIATA -> Unit
                }
            }
        }
    }
}

private const val LAN_NOTE =
    "Connessione senza HTTPS: va bene sulla rete dello studio o con Tailscale, non su reti pubbliche."

/** Cartella proposta all'apertura del selettore: Recordings nella memoria interna. */
private val RECORDINGS_FOLDER: Uri =
    DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Recordings")

private val DATE_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("EEEE d MMMM yyyy, HH:mm", Locale.ITALIAN)

private fun formatDate(epochMs: Long): String =
    if (epochMs <= 0) "Data non disponibile" else DATE_FORMAT.format(Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()))

private fun isGranted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

private fun open(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Verifica del collegamento: password, raggiungibilità e ricezione dal telefono attiva sul server. */
private fun testConnection(baseUrl: String, password: String): String = try {
    val response = SeguitoClient(baseUrl, password).config()
    when {
        response.code == 401 -> "Password errata."
        !response.ok -> response.error ?: "Seguito ha risposto con il codice ${response.code}."
        else -> {
            val json = response.json()
            val studio = json?.optString("studioName").orEmpty().ifBlank { "Seguito" }
            if (json?.optBoolean("phoneAvailable") == true) {
                "Collegato a $studio: pronto a ricevere le registrazioni."
            } else {
                "Collegato a $studio, ma sul server la ricezione dal telefono non è attiva (servono la chiave di Claude e il servizio di trascrizione)."
            }
        }
    }
} catch (e: InsecureHostException) {
    e.message ?: "Indirizzo di Seguito non sicuro."
} catch (e: IOException) {
    "Seguito non raggiungibile: verificare l'indirizzo e la rete (Wi-Fi dello studio o Tailscale)."
}
