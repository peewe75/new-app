# Decisioni di progetto

Registro delle scelte fatte finora, con il motivo. Aggiornare a ogni decisione nuova.

## Obiettivo

App per lo studio dell'Avv. Vincenzo Sapone (Cantù). Dopo una telefonata o una riunione registrata, l'app individua cosa è stato deciso (appuntamenti, incarichi, accordi economici, scadenze, documenti, email da mandare, attività). Poi propone un elenco di azioni da spuntare e, dopo l'approvazione, le esegue: calendario, bozze email, pratica nel gestionale, invio della trascrizione allo studio.

## Decisioni

| # | Decisione | Motivo |
|---|---|---|
| 1 | **Registratore: Plaud Note Pro**, piano **Starter** (gratuito, 300 minuti al mese) per ora | Registra le chiamate (sensore a contatto, passa da solo tra chiamata e riunione). Ha MCP e CLI ufficiali per leggere le registrazioni. Certificazioni ISO 27001/27701 e SOC 2, accordo GDPR, account UE su AWS Francoforte. |
| 2 | **Scartato Pocket (heypocket.com)** | Trascrizione gratuita illimitata, ma senza API ufficiale documentata, con dati negli USA e senza accordo GDPR verificabile. Da riconsiderare solo se pubblica API e accordo GDPR. |
| 3 | **Trascrizione fatta da Plaud**, non sul telefono né su un server dello studio | Il valore dell'app è l'agente, non la trascrizione. La trascrizione sul telefono era debole su chi parla, batteria e qualità. Il server in studio comporta costi e manutenzione. |
| 4 | **Accesso a Plaud tramite la developer API ufficiale** (`platform.plaud.ai/developer/api`), con i token del login di `@plaud-ai/cli` | Endpoint letti dal codice della CLI ufficiale 0.3.14: `GET /open/third-party/files/?page&page_size`, `GET /open/third-party/files/{id}`. La trascrizione è nel blocco `transaction` (parlante e minutaggio in ms), il riassunto nella nota `auto_sum_note`. |
| 5 | **Template di riassunto Plaud "Seguito – Post-chiamata"** | Plaud prepara già un riassunto strutturato. Seguito lo usa come aiuto, ma la trascrizione resta la fonte che prevale. |
| 6 | **Analisi con Claude** (`claude-opus-5-5`, structured outputs, fallback lato server attivo) | La qualità di estrazione conta più del costo, stimato in pochi centesimi per chiamata. Il modello è configurabile. |
| 7 | **Approvazione umana obbligatoria**: nessuna azione parte senza spunta | Responsabilità professionale. Ogni azione cita il minuto e la frase da cui nasce. |
| 8 | **Art. 38, comma 2, Codice deontologico forense**: avviso bloccante se l'interlocutore è un collega, e nessuna azione preselezionata | Divieto di registrare telefonate con colleghi; nelle riunioni serve il consenso di tutti i presenti. Le prime note citavano per errore l'art. 60; il codice interno dell'avviso è `COLLEGA_ART38`. |
| 9 | **Termini processuali sempre "da verificare"**, ma preselezionati e con «(da verificare)» nel titolo dell'evento | Un errore su una scadenza calcolata dall'AI è un rischio professionale; un termine rimasto fuori dal calendario lo è di più. Il prompt distingue il computo civile (art. 155 c.p.c.) da quello penale (art. 172 c.p.p.) e non fa calcolare termini la cui durata non è stata detta. |
| 10 | **Prima versione con file universali**: `.ics` per il calendario, `.eml` come bozze (X-Unsent), gestionale su file JSON | Funziona subito con qualsiasi calendario e client di posta. I collegamenti diretti (Google o Microsoft, gestionale reale) arrivano dopo, sulle stesse interfacce. |
| 11 | **Jev (TypeSafe AI)**: non usato per ora | È un modello che sceglie tra opzioni, in cloud USA, e non gira sullo smartphone. Potrebbe servire in futuro come filtro rapido, non come agente. |
| 12 | **Privacy**: dati in locale (`data/`, `outbox/`) con permessi ristretti; accordi GDPR da firmare con Plaud e Anthropic | Segreto professionale. In alternativa, per l'analisi, si può valutare Claude su AWS Bedrock nella regione UE. |

## Domande aperte (chiedere all'avvocato)

1. Posta e calendario: Google Workspace o Microsoft 365?
2. Quale gestionale usa lo studio, e ha un'API?
3. iPhone o Android?
4. Dove ospitare l'app: computer dello studio, VPS europeo o Supabase/Netlify?

## Prossimi passi

1. Completare e verificare la prima versione (vedi `docs/specifica-tecnica.md`).
2. Quando arriva il Plaud: configurare il template, fare il login CLI, eseguire `npm run poll` su chiamate vere e confrontare le estrazioni.
3. Collegamenti: Google Calendar e Gmail oppure Microsoft Graph; adattatore per il gestionale reale.
4. Pubblicazione come PWA protetta da password, con accesso dal telefono.
