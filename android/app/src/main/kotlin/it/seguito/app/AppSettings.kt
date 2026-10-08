package it.seguito.app

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Come inviare le nuove registrazioni. */
enum class SendMode { CONFERMA, AUTOMATICO }

/** Impostazioni dell'app; la password di Seguito è cifrata con una chiave del Keystore Android. */
class AppSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("seguito", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    var password: String
        get() = prefs.getString(KEY_PASSWORD, null)?.let(SecretBox::decrypt) ?: ""
        set(value) = prefs.edit().putString(KEY_PASSWORD, SecretBox.encrypt(value)).apply()

    var treeUri: Uri?
        get() = prefs.getString(KEY_TREE, null)?.let(Uri::parse)
        set(value) = prefs.edit().putString(KEY_TREE, value?.toString()).apply()

    var mode: SendMode
        get() = prefs.getString(KEY_MODE, null)?.let { runCatching { SendMode.valueOf(it) }.getOrNull() } ?: SendMode.CONFERMA
        set(value) = prefs.edit().putString(KEY_MODE, value.name).apply()

    var excludeLawyers: Boolean
        get() = prefs.getBoolean(KEY_EXCLUDE_LAWYERS, true)
        set(value) = prefs.edit().putBoolean(KEY_EXCLUDE_LAWYERS, value).apply()

    var exclusionRules: String
        get() = prefs.getString(KEY_RULES, "") ?: ""
        set(value) = prefs.edit().putString(KEY_RULES, value).apply()

    /** false finché la cartella scelta non è stata letta una prima volta (le registrazioni già presenti non si inviano). */
    var baselineDone: Boolean
        get() = prefs.getBoolean(KEY_BASELINE, false)
        set(value) = prefs.edit().putBoolean(KEY_BASELINE, value).apply()

    /** Registrazioni del Registratore vocale (riunioni con clienti e team): proposte sempre con conferma. */
    var voiceEnabled: Boolean
        get() = prefs.getBoolean(KEY_VOICE, true)
        set(value) = prefs.edit().putBoolean(KEY_VOICE, value).apply()

    /** Come baselineDone, per le registrazioni vocali (attivate anche dopo la prima lettura della cartella). */
    var voiceBaselineDone: Boolean
        get() = prefs.getBoolean(KEY_VOICE_BASELINE, false)
        set(value) = prefs.edit().putBoolean(KEY_VOICE_BASELINE, value).apply()

    var lastCallState: String
        get() = prefs.getString(KEY_CALL_STATE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CALL_STATE, value).apply()

    /** Indirizzo valido di Seguito, oppure null. */
    val baseUrl: String?
        get() = (ServerUrl.validate(serverUrl) as? ServerUrl.Result.Valid)?.baseUrl

    val isConfigured: Boolean
        get() = baseUrl != null && password.isNotEmpty() && treeUri != null

    private companion object {
        const val KEY_SERVER = "serverUrl"
        const val KEY_PASSWORD = "password"
        const val KEY_TREE = "treeUri"
        const val KEY_MODE = "mode"
        const val KEY_EXCLUDE_LAWYERS = "excludeLawyers"
        const val KEY_RULES = "exclusionRules"
        const val KEY_BASELINE = "baselineDone"
        const val KEY_CALL_STATE = "lastCallState"
        const val KEY_VOICE = "voiceEnabled"
        const val KEY_VOICE_BASELINE = "voiceBaselineDone"
    }
}

/** Cifratura AES-GCM con una chiave che non esce dal Keystore del telefono. */
private object SecretBox {
    private const val ALIAS = "seguito-password"
    private const val IV_BYTES = 12

    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    /** null se il dato non si può decifrare (per esempio dopo il ripristino su un altro telefono). */
    fun decrypt(encoded: String): String? = runCatching {
        val sealed = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed.copyOfRange(0, IV_BYTES)))
        String(cipher.doFinal(sealed.copyOfRange(IV_BYTES, sealed.size)), Charsets.UTF_8)
    }.getOrNull()

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
