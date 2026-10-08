package it.seguito.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallFileTest {
    @Test
    fun leggeINomiDeiFileSamsung() {
        assertEquals(
            CallFileInfo("Mario Rossi", null, "2026-10-08T10:15"),
            CallFile.parse("Chiamata Mario Rossi_261008_101530.m4a"),
        )
        assertEquals(
            CallFileInfo(null, "+393331234567", "2026-10-08T09:15"),
            CallFile.parse("Call recording +39 333 123 4567_261008_091500.m4a"),
        )
        assertEquals(
            CallFileInfo(null, "+821012345678", "2026-06-01T14:30"),
            CallFile.parse("+821012345678_20260601143022.m4a"),
        )
        assertEquals(
            CallFileInfo("Laura Neri", "+39021234567", "2026-10-05T12:15"),
            CallFile.parse("Laura Neri@+39 02 1234567_20261005121533.amr"),
        )
        assertEquals(CallFileInfo("Paolo Verdi", null, null), CallFile.parse("Paolo Verdi.m4a"))
        assertNull(CallFile.parse("Chiamata Paolo Verdi_260230_101530.m4a").startedLocal)
    }

    @Test
    fun riconosceIFileAudio() {
        assertTrue(CallFile.isAudio("Chiamata Mario Rossi_261008_101530.m4a"))
        assertTrue(CallFile.isAudio("x.AMR"))
        assertFalse(CallFile.isAudio("note.txt"))
        assertEquals("audio/mp4", CallFile.mimeType("a.m4a"))
        assertEquals("application/octet-stream", CallFile.mimeType("a.xyz"))
    }

    @Test
    fun riconosceLeCartelleDiChiamateERegistrazioniVocali() {
        assertTrue(CallFile.isCallFolder("Call"))
        assertTrue(CallFile.isCallFolder("call recordings"))
        assertFalse(CallFile.isCallFolder("Voice Recorder"))
        assertFalse(CallFile.isCallFolder("Recordings"))
        assertEquals(RecKind.CHIAMATA, CallFile.folderKind("Call"))
        assertEquals(RecKind.VOCALE, CallFile.folderKind("Voice Recorder"))
        assertNull(CallFile.folderKind("Recordings"))
        assertNull(CallFile.folderKind("WhatsApp Audio"))
        assertTrue(CallFile.isHidden(".393857"))
        assertTrue(CallFile.isHidden(".pending-1760000000-Voce 001.m4a"))
        assertFalse(CallFile.isHidden("Voce 260822_181740.m4a"))
    }

    @Test
    fun titolaLeRegistrazioniVocali() {
        assertEquals("Registrazione vocale", CallFile.voiceLabel("Voce 260822_181740.m4a", null))
        assertEquals("Registrazione vocale", CallFile.voiceLabel("Voice 001.m4a", " "))
        assertEquals("Riunione team", CallFile.voiceLabel("Riunione team.m4a", null))
        assertEquals("Riunione con Rossi", CallFile.voiceLabel("Voce 001.m4a", "Riunione con Rossi"))
    }
}

class Mp4Test {
    private fun box(type: String, payload: Int): ByteArray {
        val size = 8 + payload
        return byteArrayOf((size ushr 24).toByte(), (size ushr 16).toByte(), (size ushr 8).toByte(), size.toByte()) +
            type.toByteArray(Charsets.ISO_8859_1) + ByteArray(payload)
    }

    private fun complete(bytes: ByteArray) = Mp4.isComplete(bytes.size.toLong()) { pos, buffer ->
        val n = minOf(buffer.size, bytes.size - pos.toInt())
        System.arraycopy(bytes, pos.toInt(), buffer, 0, n)
        n
    }

    @Test
    fun riconosceUnFileSalvatoDaUnoInScrittura() {
        val saved = box("ftyp", 16) + box("mdat", 100) + box("moov", 40)
        assertTrue(complete(saved))
        // In scrittura: nessun indice, oppure blocco audio «fino alla fine» (dimensione 0) o più lungo del file.
        assertFalse(complete(box("ftyp", 16) + box("mdat", 100)))
        val open = box("ftyp", 16) + byteArrayOf(0, 0, 0, 0) + "mdat".toByteArray() + ByteArray(50)
        assertFalse(complete(open))
        val truncated = box("ftyp", 16) + box("mdat", 100).copyOf(60)
        assertFalse(complete(truncated))
        assertTrue(Mp4.applies("Voce 001.m4a"))
        assertFalse(Mp4.applies("nota.amr"))
    }
}

class ExclusionsTest {
    private fun info(contact: String?, phone: String? = null) = CallFileInfo(contact, phone, null)

    @Test
    fun escludeIColleghiSalvatiComeAvvocati() {
        for (name in listOf("Avv. Giulia Bianchi", "avv Bianchi", "Avvocato Neri", "Studio Legale Rossi")) {
            assertEquals(name, Exclusions.Reason.COLLEGA, Exclusions.reason(info(name), true, emptyList()))
        }
        assertNull(Exclusions.reason(info("Avv. Giulia Bianchi"), false, emptyList()))
        assertNull(Exclusions.reason(info("Avvenire Srl"), true, emptyList()))
        assertNull(Exclusions.reason(info("Mario Rossi"), true, emptyList()))
    }

    @Test
    fun escludeNomiENumeriDellElenco() {
        val rules = Exclusions.parseRules("Bianchi\n+39 333 123 4567, Procura")
        assertEquals(listOf("Bianchi", "+39 333 123 4567", "Procura"), rules)
        assertEquals(Exclusions.Reason.ELENCO, Exclusions.reason(info("Giulia Bianchi"), true, rules))
        assertEquals(Exclusions.Reason.ELENCO, Exclusions.reason(info(null, "3331234567"), true, rules))
        assertEquals(Exclusions.Reason.ELENCO, Exclusions.reason(info(null, "+393331234567"), true, rules))
        assertNull(Exclusions.reason(info(null, "+393339999999"), true, rules))
    }

    @Test
    fun registrazioniVocaliSoloConINomiDellElenco() {
        val rules = Exclusions.parseRules("Bianchi\n+39 333 123 4567")
        assertEquals(Exclusions.Reason.ELENCO, Exclusions.voiceReason("Riunione Bianchi.m4a", null, rules))
        assertEquals(Exclusions.Reason.ELENCO, Exclusions.voiceReason("Voce 001.m4a", "Incontro con Bianchi", rules))
        assertNull(Exclusions.voiceReason("Voce 260822_181740.m4a", null, rules))
    }

    @Test
    fun riconosceINumeriCortiConIlPrefisso() {
        val rules = listOf("06 123456")
        assertEquals(Exclusions.Reason.ELENCO, Exclusions.reason(info(null, "+3906123456"), true, rules))
        assertNull(Exclusions.reason(info(null, "+3906654321"), true, rules))
    }
}

class ServerUrlTest {
    @Test
    fun accettaHttpsEReteDelloStudio() {
        assertEquals(
            ServerUrl.Result.Valid("https://seguito.example.it", false),
            ServerUrl.validate("https://seguito.example.it/"),
        )
        assertEquals(ServerUrl.Result.Valid("http://192.168.1.20:3000", true), ServerUrl.validate("192.168.1.20:3000"))
        assertEquals(ServerUrl.Result.Valid("http://100.101.102.103:3000", true), ServerUrl.validate("http://100.101.102.103:3000"))
        assertEquals(
            ServerUrl.Result.Valid("http://pc-studio.tail1234.ts.net:3000", true),
            ServerUrl.validate("http://pc-studio.tail1234.ts.net:3000"),
        )
    }

    @Test
    fun rifiutaHttpSuInternetECredenzialiNellIndirizzo() {
        assertTrue(ServerUrl.validate("http://seguito.example.it") is ServerUrl.Result.Invalid)
        assertTrue(ServerUrl.validate("http://8.8.8.8:3000") is ServerUrl.Result.Invalid)
        assertTrue(ServerUrl.validate("https://utente:password@seguito.example.it") is ServerUrl.Result.Invalid)
        assertTrue(ServerUrl.validate("ftp://192.168.1.2") is ServerUrl.Result.Invalid)
        assertTrue(ServerUrl.validate("") is ServerUrl.Result.Invalid)
        assertTrue(ServerUrl.validate("https://seguito.example.it/?x=1") is ServerUrl.Result.Invalid)
        assertFalse(ServerUrl.isPrivateHost("172.32.0.1"))
        assertTrue(ServerUrl.isPrivateHost("172.16.0.1"))
    }

    @Test
    fun riconosceGliIndirizziRisoltiDellaReteDelloStudio() {
        fun private(ip: String) = ServerUrl.isPrivateAddress(java.net.InetAddress.getByName(ip))
        assertTrue(private("192.168.1.20"))
        assertTrue(private("100.101.102.103"))
        assertTrue(private("fd7a:115c:a1e0::1"))
        assertFalse(private("8.8.8.8"))
        assertFalse(private("100.128.0.1"))
        assertFalse(private("2001:4860:4860::8888"))
        assertFalse(ServerUrl.isPrivateIpv4("pc-studio.lan"))
    }
}
