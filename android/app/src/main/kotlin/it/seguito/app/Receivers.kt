package it.seguito.app

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

class SeguitoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        RecordingStore.init(this)
        Notifications.createChannels(this)
        Jobs.schedulePeriodic(this)
        Jobs.armMediaTrigger(this)
    }
}

/** A fine chiamata cerca la nuova registrazione, dopo qualche secondo per lasciare al telefono il tempo di salvarla. */
class CallEndReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        val settings = AppSettings(context)
        val previous = settings.lastCallState
        settings.lastCallState = state
        if (state == TelephonyManager.EXTRA_STATE_IDLE && previous == TelephonyManager.EXTRA_STATE_OFFHOOK) {
            Jobs.syncNow(context, delaySeconds = 20)
        }
    }
}

/** Pulsanti «Invia a Seguito» e «Non inviare» della notifica. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val docId = intent.getStringExtra(EXTRA_DOC) ?: return
        RecordingStore.init(context)
        when (intent.action) {
            ACTION_SEND -> {
                RecordingStore.update(docId) { it.copy(status = RecStatus.IN_CODA, message = null) }
                Jobs.upload(context, docId)
            }
            ACTION_SKIP -> RecordingStore.update(docId) { it.copy(status = RecStatus.NON_INVIATA, message = null) }
        }
        Notifications.cancel(context, docId)
    }

    companion object {
        const val ACTION_SEND = "it.seguito.app.INVIA"
        const val ACTION_SKIP = "it.seguito.app.NON_INVIARE"
        const val EXTRA_DOC = "docId"
    }
}
