package it.seguito.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.hasSetTextAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Prova di avvio sull'emulatore: l'app si apre, mostra le sezioni e valida l'indirizzo di Seguito. */
@RunWith(AndroidJUnit4::class)
class AvvioTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun mostraLeSezioniPrincipali() {
        compose.onNodeWithText("1. Collegamento a Seguito").assertIsDisplayed()
        compose.onNodeWithText("Salva e verifica").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Scegli la cartella"))
        compose.onNodeWithText("Scegli la cartella").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Registrazioni"))
        compose.onNodeWithText("Registrazioni").assertIsDisplayed()
    }

    @Test
    fun rifiutaUnIndirizzoHttpSuInternet() {
        compose.onAllNodes(hasSetTextAction())[0].performTextInput("http://seguito.example.it")
        compose.onNodeWithText("Salva e verifica").performClick()
        compose.waitForIdle()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("per Internet serve HTTPS", substring = true))
        compose.onNodeWithText("per Internet serve HTTPS", substring = true).assertIsDisplayed()
    }
}
