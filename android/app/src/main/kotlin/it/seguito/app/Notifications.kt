package it.seguito.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Notifiche: conferma dell'invio, proposta pronta, errori. Mai testi della conversazione. */
object Notifications {
    private const val CHANNEL_NEW = "nuove"
    private const val CHANNEL_READY = "proposte"
    private const val CHANNEL_ERRORS = "errori"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_NEW, "Nuove registrazioni", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Chiede se inviare a Seguito una chiamata appena registrata."
                },
                NotificationChannel(CHANNEL_READY, "Proposte pronte", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Avvisa quando la proposta di una chiamata è pronta da approvare."
                },
                NotificationChannel(CHANNEL_ERRORS, "Errori", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Invii o elaborazioni non riusciti."
                },
            ),
        )
    }

    fun askToSend(context: Context, entry: RecEntry) {
        val send = actionIntent(context, NotificationActionReceiver.ACTION_SEND, entry.docId)
        val skip = actionIntent(context, NotificationActionReceiver.ACTION_SKIP, entry.docId)
        val builder = base(context, CHANNEL_NEW)
            .setContentTitle("Chiamata registrata: ${entry.info.label}")
            .setContentText("Inviarla a Seguito per la trascrizione e la proposta di azioni?")
            // Con il telefono bloccato l'invio chiede prima lo sblocco.
            .addAction(NotificationCompat.Action.Builder(0, "Invia a Seguito", send).setAuthenticationRequired(true).build())
            .addAction(0, "Non inviare", skip)
            .setContentIntent(openApp(context))
        notify(context, idFor(entry.docId), builder)
    }

    fun proposalReady(context: Context, entry: RecEntry, url: String) {
        val open = PendingIntent.getActivity(
            context,
            idFor(entry.docId),
            Intent(Intent.ACTION_VIEW, Uri.parse(url)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = base(context, CHANNEL_READY)
            .setContentTitle("Proposta pronta: ${entry.info.label}")
            .setContentText("Tocca per rivedere e approvare le azioni in Seguito.")
            .setContentIntent(open)
        notify(context, idFor(entry.docId), builder)
    }

    fun failed(context: Context, entry: RecEntry, message: String) {
        val builder = base(context, CHANNEL_ERRORS)
            .setContentTitle("Registrazione non elaborata: ${entry.info.label}")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(openApp(context))
        notify(context, idFor(entry.docId), builder)
    }

    fun cancel(context: Context, docId: String) {
        NotificationManagerCompat.from(context).cancel(idFor(docId))
    }

    fun canNotify(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun base(context: Context, channel: String) = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_stat_seguito)
        .setAutoCancel(true)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)

    private fun notify(context: Context, id: Int, builder: NotificationCompat.Builder) {
        if (!canNotify(context)) return
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build())
        } catch (e: SecurityException) {
            // Permesso revocato nel frattempo: la registrazione resta visibile nell'app.
        }
    }

    private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun actionIntent(context: Context, action: String, docId: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        (action + docId).hashCode(),
        Intent(context, NotificationActionReceiver::class.java).setAction(action).putExtra(NotificationActionReceiver.EXTRA_DOC, docId),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun idFor(docId: String): Int = docId.hashCode()
}
