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
| 13 | **Posta e calendario: Microsoft 365** (risposta dell'avvocato, 8 ottobre 2026) | Lo studio usa Outlook. Seguito crea le bozze nella cartella Bozze e gli eventi nel calendario tramite Microsoft Graph. I file `.ics` ed `.eml` restano per la demo e quando Microsoft 365 non è configurato. |
| 14 | **Telefono: Android** (risposta dell'avvocato) | La PWA si installa da Chrome e può ricevere notifiche push. |
| 15 | **Hosting: Supabase + Netlify** (scelta dell'avvocato) | Archivio su Supabase (regione UE), interfaccia PWA e funzioni su Netlify. Comporta l'adattamento dell'archivio, del polling e delle analisi lunghe ai limiti delle funzioni serverless; vanno firmati i DPA con Supabase e Netlify. |
| 16 | **Gestionale**: risposta dell'avvocato «è vecchio e costruito nuovo» | Da chiarire (vedi domande aperte). Finché non è chiarito resta il gestionale su file JSON. |
| 17 | **Connettore Microsoft 365 con Microsoft Graph, senza librerie aggiuntive**: accesso delegato con codice di autorizzazione e PKCE (applicazione Entra a tenant singolo, con segreto), permessi `User.Read`, `Mail.ReadWrite`, `Calendars.ReadWrite`, `offline_access` | Seguito agisce solo sulla casella e sul calendario dell'avvocato che si collega. Lo stesso flusso funziona in locale (`http://localhost`) e una volta pubblicato. Gli esecutori passano da un'interfaccia comune (`Office`): file `.ics`/`.eml` se Microsoft 365 non è configurato, Outlook se lo è. |
| 18 | **Le email restano bozze; la trascrizione allo studio è una bozza, salvo `SEGUITO_TRASCRIZIONE=invio`** | Coerente con la decisione 10: nessun invio verso l'esterno. L'invio diretto, se scelto, è ammesso solo verso la casella dello studio (controllo nel codice) e richiede in più il permesso `Mail.Send`. |
| 19 | **Un solo promemoria per evento in Outlook**: un'ora prima per gli appuntamenti, 7 giorni prima per le scadenze (sull'intera giornata, «Libero») | Outlook ammette un solo promemoria; per le scadenze serve il tempo di prepararsi. I file `.ics` mantengono entrambi i promemoria. Se serve anche quello del giorno prima, si può aggiungere un secondo evento. |
| 20 | **Microsoft 365 configurato ma non collegato: le azioni di calendario ed email vanno in errore**, non ripiegano sui file | Evita che un evento finisca in un file invece che nel calendario senza che l'avvocato se ne accorga. Le azioni in errore si eseguono approvandole di nuovo dopo il collegamento. |
| 21 | **Telefonate registrate con il Samsung Galaxy S25: importate in Plaud** («Importa audio» o Condividi → Plaud) e trascritte da Plaud, con AutoFlow attivo | Coerente con la decisione 3: la trascrizione resta a Plaud e Seguito non cambia. Il Samsung salva le registrazioni (.m4a) in una cartella leggibile da altre app, ma Plaud non ha un'API per caricare file (la CLI ufficiale 0.3.15 legge soltanto): l'importazione resta un gesto manuale. Un'app Android di accompagnamento può ridurla a un tocco, da una notifica dopo ogni chiamata registrata; un'importazione senza alcun tocco richiederebbe una trascrizione fuori da Plaud, cioè una modifica della decisione 3. |

## Domande aperte (chiedere all'avvocato)

1. Gestionale: il gestionale attuale è vecchio e senza API, e ne state costruendo uno nuovo? Chi lo sviluppa, con quale tecnologia (per esempio su Supabase), e Seguito deve scrivere direttamente lì?
2. Pubblicazione su Supabase + Netlify (decisione 15): quale delle due strade? Vincoli verificati l'8 ottobre 2026 sulla documentazione ufficiale:
   - Netlify Free e Personal eseguono le funzioni negli Stati Uniti (Ohio); Francoforte richiede Netlify Pro (20 $/mese). Con Free, se i crediti finiscono, il sito viene sospeso.
   - Supabase Free sospende il progetto dopo una settimana senza attività e non ha backup: per dati dei clienti serve Supabase Pro (da 25 $/mese), regione eu-central-1 (Francoforte), non la generica «Europe».
   - **Strada A (consigliata)**: Netlify Pro con le funzioni a Francoforte + Supabase Pro a Francoforte, circa 45 $/mese. Il codice Node attuale gira quasi senza modifiche; l'analisi con Claude ha fino a 15 minuti (funzioni in background).
   - **Strada B**: Netlify Free solo per la PWA + tutta l'elaborazione nelle Edge Functions di Supabase a Francoforte, circa 25 $/mese. Va riscritta parte del codice per Deno e l'analisi deve stare entro 400 secondi.
   - In entrambe: DPA da firmare con Supabase (dalla dashboard) e con Netlify; accesso con email, password e codice TOTP (Supabase Auth); token Microsoft e Plaud cifrati in Supabase Vault.

## Prossimi passi

1. Completare e verificare la prima versione (vedi `docs/specifica-tecnica.md`).
2. Quando arriva il Plaud: configurare il template, fare il login CLI, eseguire `npm run poll` su chiamate vere e confrontare le estrazioni.
3. Collegamento Microsoft 365: fatto (vedi `docs/microsoft365-setup.md`); resta da registrare l'applicazione nel tenant dello studio. Adattatore per il gestionale reale, dopo il chiarimento sulla decisione 16.
4. Pubblicazione come PWA protetta da password, con accesso dal telefono, dopo la scelta della strada (domanda aperta 2).
