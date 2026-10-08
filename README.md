# Seguito

Seguito trasforma le telefonate e le riunioni registrate con il Plaud Note Pro in azioni per lo studio. Plaud registra e trascrive. Seguito legge la trascrizione e la fa analizzare a Claude, che individua appuntamenti, incarichi, accordi economici, scadenze, documenti da ricevere o inviare, email da scrivere e attività interne. Ogni proposta riporta il minuto e la frase da cui nasce. L'avvocato spunta le azioni giuste, corregge quelle imprecise e scarta le altre. **Solo dopo la sua approvazione** Seguito crea gli eventi del calendario, le bozze delle email e le note nel gestionale, e prepara l'invio della trascrizione alla casella dello studio.

```
 Plaud Note Pro ──► trascrizione Plaud ──► Seguito (analisi con Claude) ──► proposta
   (registra)        (app e cloud Plaud)    (minuto e frase per ogni punto)  (azioni con caselle)
                                                                                   │
                                                                     approvazione dell'avvocato
                                                                                   │
           ┌──────────────────────┬──────────────────────┬─────────────────────────┤
           ▼                      ▼                      ▼                         ▼
   calendario (.ics)      bozze email (.eml)    gestionale (pratiche     trascrizione allo studio
                                                e note)                 (bozza .eml)
```

## Provalo subito

Serve Node.js 22 o successivo.

```bash
npm install
npm run demo
```

Poi apri <http://127.0.0.1:3000>.

La demo carica tre telefonate di esempio, con nomi e dati inventati:

- **Mario Rossi**: decreto ingiuntivo da opporre. Ci sono un appuntamento fissato, l'incarico conferito, il compenso concordato, il termine di opposizione, i documenti da ricevere e l'email di riepilogo.
- **Avv. Giulia Bianchi**: proposta transattiva della collega di controparte. Mostra l'avviso deontologico sulle telefonate con i colleghi: nessuna azione è preselezionata.
- **Paolo Verdi**: primo contatto per sovraindebitamento. È un potenziale cliente non presente nel gestionale; l'appuntamento è da fissare e il compenso è solo proposto.

Le analisi della demo sono già pronte in `fixtures/extractions/`: **non serve una chiave API**. La demo lavora in cartelle separate (`data/demo/` e `outbox/demo/`) con una copia del gestionale di esempio, quindi non tocca i dati veri. Per ricominciare da capo, cancella queste due cartelle.

Per far analizzare le stesse telefonate a Claude, imposta `ANTHROPIC_API_KEY` nel file `.env` e avvia:

```bash
npm run demo -- --live
```

Le proposte della demo non ancora approvate vengono rigenerate con l'analisi richiesta: con `--live` quella di Claude, senza `--live` quella di esempio. Quelle già approvate restano come sono.

## Con il Plaud

Le istruzioni passo passo, dall'app Plaud alla creazione del template di riassunto, sono in [docs/plaud-setup.md](docs/plaud-setup.md). In breve:

1. Sul computer che esegue Seguito, collega il tuo account Plaud. Il comando guida l'accesso all'account e salva le credenziali in `~/.plaud`:

   ```bash
   npx @plaud-ai/cli login
   ```

2. Inserisci la chiave di Claude in `.env` (vedi [Configurazione](#configurazione)).
3. Scarica e analizza le registrazioni nuove:

   ```bash
   npm run poll                 # un controllo e basta
   npm run poll -- --watch 5    # controlla ogni 5 minuti, fino a Ctrl+C
   npm run poll -- --retry-failed   # ripete subito anche le analisi non riuscite
   ```

4. Apri l'interfaccia per rivedere e approvare le proposte:

   ```bash
   npm run serve
   ```

   Se il login a Plaud e la chiave di Claude sono presenti, il pulsante **Aggiorna** dell'interfaccia cerca anche le registrazioni nuove.

Le registrazioni ancora senza trascrizione vengono ignorate e riprovate al controllo successivo. Ogni registrazione viene analizzata una volta sola, anche se `poll` e `serve` sono in funzione insieme: una proposta già creata non viene mai sovrascritta. Se l'analisi non riesce per un errore transitorio (per esempio il servizio non risponde), viene ritentata con attese crescenti, da 15 minuti fino a un giorno. Se invece ripeterla darebbe lo stesso esito (registrazione troppo lunga per il limite di token, rifiuto del modello, risposta non conforme), non viene ritentata in automatico: rimossa la causa, la si ripete con `npm run poll -- --retry-failed`.

## Con Microsoft 365

Se lo studio usa Outlook, Seguito crea gli eventi direttamente nel calendario e le bozze direttamente nella cartella Bozze, invece dei file `.ics` ed `.eml`. Le email a clienti, colleghi e controparti restano sempre bozze da controllare e inviare.

1. Registra Seguito come applicazione nel tenant dello studio e inserisci in `.env` i tre valori `SEGUITO_M365_*`: i passaggi sono in [docs/microsoft365-setup.md](docs/microsoft365-setup.md).
2. Avvia `npm run serve`, apri <http://localhost:3000> e premi **Collega Microsoft 365**.

Finché l'account non è collegato, le azioni di calendario ed email restano in errore e si eseguono approvandole di nuovo dopo il collegamento; le note nel gestionale procedono comunque.

## Con le chiamate registrate dal telefono

Sul Samsung Galaxy S25 l'app **Seguito per Android** trova le chiamate registrate con la funzione nativa del telefono e, dopo la tua conferma, le invia a Seguito senza passare da Plaud. Seguito le trascrive con Speechmatics (server nell'UE), le analizza con Claude e propone le azioni da approvare, come per il Plaud. Le chiamate con i colleghi non partono: i contatti salvati come «Avv.», «Avvocato» o «Studio legale» sono sempre esclusi.

1. In `.env`: `SPEECHMATICS_API_KEY` (account e chiave sul [Portale di Speechmatics](https://portal.speechmatics.com)), `SEGUITO_PASSWORD` e `SEGUITO_HOST=0.0.0.0`; poi `npm run serve`.
2. Sul telefono installa l'app da <https://github.com/peewe75/new-app/releases/download/app-android/Seguito.apk> e indica indirizzo del computer, password e cartella **Recordings**.

Installazione, rete (Wi-Fi dello studio o Tailscale), costi, accordo sul trattamento dei dati con Speechmatics e problemi frequenti sono in [docs/telefono-samsung.md](docs/telefono-samsung.md).

## Trascrizioni esportate

Per analizzare trascrizioni già scaricate, indica un file o una cartella:

```bash
npm run ingest -- <percorso>
npm run ingest -- <percorso> --fixture
```

Formati accettati:

- **JSON di Plaud**: il dettaglio di una registrazione come lo restituisce l'API (con `source_list`), per esempio i file in `fixtures/plaud/`;
- **JSON di Seguito**: una registrazione già convertita (con `segments`);
- **testo `.txt`**: il formato stampato da `plaud transcript`, una riga per intervento, per esempio `[02:15] Speaker 2: Venerdì due ottobre...`. Le righe facoltative `# title: ...` e `# startedAt: 2026-10-07T09:30` in testa al file indicano titolo e inizio. Senza fuso orario, l'ora è quella dello studio.

Con `--fixture` Seguito non chiama Claude e usa le analisi già pronte in `fixtures/extractions/` (una per registrazione, con lo stesso nome). Serve per le prove.

## Configurazione

Copia `.env.example` in `.env` e completa i valori. Il file `.env` contiene la chiave API: non condividerlo e non metterlo sotto controllo di versione (è già escluso da `.gitignore`).

| Variabile | Valore predefinito | A che cosa serve |
|---|---|---|
| `SEGUITO_STUDIO_NAME` | `Studio Legale Sapone` | Nome dello studio, usato nei testi e nella firma predefinita. |
| `SEGUITO_LAWYER_NAME` | `Avv. Vincenzo Sapone` | Avvocato di riferimento: Claude lo riconosce come avvocato dello studio. |
| `SEGUITO_LAWYER_EMAIL` | `avvocato@studio.example` | Mittente delle bozze di email. |
| `SEGUITO_STUDIO_EMAIL` | `segreteria@studio.example` | Casella che riceve le trascrizioni. |
| `SEGUITO_TIMEZONE` | `Europe/Rome` | Fuso orario per date, orari e scadenze. |
| `SEGUITO_BOOKING_LINK` | vuoto | Link di prenotazione (per esempio Cal.com) inserito nelle email quando un appuntamento è da fissare. Se manca, l'email chiede le disponibilità. |
| `SEGUITO_SIGNATURE` | nome dell'avvocato e dello studio | Firma in calce alle email; `\n` va a capo. |
| `ANTHROPIC_API_KEY` | vuoto | Chiave API di Claude. Serve per `poll`, `ingest` senza `--fixture` e `demo -- --live`. |
| `SEGUITO_CLAUDE_MODEL` | `claude-opus-5-5` | Modello usato per l'analisi. |
| `SEGUITO_CLAUDE_EFFORT` | `high` | Livello di ragionamento: `low`, `medium`, `high`, `xhigh` o `max`. |
| `SEGUITO_CLAUDE_MAX_TOKENS` | `16000` | Limite di token in uscita per ogni analisi. Va aumentato solo se Seguito segnala che una registrazione molto lunga ha superato il limite. |
| `PLAUD_TOKENS_PATH` | `~/.plaud/tokens.json` | Credenziali salvate da `npx @plaud-ai/cli login`. |
| `PLAUD_REGION` | vuoto | Area dell'account Plaud. Lasciare vuoto, salvo diversa indicazione del supporto Plaud. |
| `SEGUITO_HOST` | `127.0.0.1` | Indirizzo dell'interfaccia. Con `127.0.0.1` è raggiungibile solo dal computer stesso. |
| `SEGUITO_ALLOWED_HOSTS` | vuoto | Nomi, separati da virgole, con cui si apre l'interfaccia da altri dispositivi (per esempio `seguito.studio.lan`). Indirizzi IP, `localhost` e il nome in `SEGUITO_HOST` sono sempre accettati; gli altri nomi sono rifiutati, per impedire a un sito esterno di raggiungere Seguito tramite il DNS rebinding. |
| `SEGUITO_PORT` | `3000` | Porta dell'interfaccia. |
| `SEGUITO_PASSWORD` | vuoto | Se impostata, l'interfaccia chiede nome utente (per esempio `studio`) e password. Va sempre impostata se Seguito è raggiungibile da altri dispositivi. |
| `SEGUITO_DATA_DIR` | `./data` | Registrazioni, proposte ed esiti. |
| `SEGUITO_OUTBOX_DIR` | `./outbox` | File generati: eventi `.ics` e bozze `.eml`. |
| `SEGUITO_GESTIONALE_FILE` | `./data/gestionale.json` | Gestionale su file JSON, usato finché non c'è il collegamento al gestionale dello studio. |
| `SEGUITO_M365_TENANT_ID` | vuoto | ID della directory (tenant) Microsoft 365 dello studio. |
| `SEGUITO_M365_CLIENT_ID` | vuoto | ID dell'applicazione registrata in Microsoft Entra. |
| `SEGUITO_M365_CLIENT_SECRET` | vuoto | Segreto dell'applicazione. Con questi tre valori eventi e bozze vanno in Outlook; senza, Seguito produce file `.ics` ed `.eml`. |
| `SEGUITO_M365_REDIRECT_URI` | `http://localhost:<porta>/auth/microsoft/callback` | Indirizzo di ritorno dopo l'accesso Microsoft: deve coincidere con quello registrato. |
| `SEGUITO_M365_TOKENS_FILE` | `./data/microsoft365.json` | Token dell'account collegato (file leggibile solo dall'utente che esegue Seguito). |
| `SPEECHMATICS_API_KEY` | vuoto | Chiave di Speechmatics per trascrivere le chiamate inviate dal telefono. Con questa, la chiave di Claude e `SEGUITO_PASSWORD`, `serve` riceve le registrazioni dall'app Android. |
| `SPEECHMATICS_URL` | `https://eu1.asr.api.speechmatics.com/v2` | Indirizzo dell'API di Speechmatics (regione UE). Va cambiato solo su indicazione di Speechmatics, restando nell'UE. |
| `SEGUITO_TELEFONO_VOCABOLARIO` | vuoto | Nomi e termini, separati da virgole, che la trascrizione deve riconoscere meglio (oltre ai termini giuridici già previsti). |
| `SEGUITO_TELEFONO_MAX_MB` | `500` | Dimensione massima di una registrazione inviata dal telefono. |
| `SEGUITO_TRASCRIZIONE` | `bozza` | Con `invio` la trascrizione è inviata direttamente alla casella dello studio (solo a quella e solo con Microsoft 365); altrimenti resta una bozza. |

Per usi particolari esistono anche `PLAUD_API_BASE` e `PLAUD_REFRESH_URL`, che di norma non vanno toccate.

## Che cosa succede quando approvi

Nell'interfaccia ogni azione ha una casella. Sono già spuntate le azioni con affidabilità alta e senza avvisi di attenzione, e le scadenze processuali anche se da verificare, perché un termine fuori dal calendario è il rischio maggiore; le altre vanno controllate e, se servono, spuntate a mano. Con **Modifica** puoi correggere data, destinatario, testo, importi, condizioni economiche e stato dell'incarico prima di approvare. **Approva selezionate** esegue solo le azioni spuntate.

| Azione | Risultato |
|---|---|
| Appuntamento con data e ora | Evento `.ics` con promemoria il giorno prima e un'ora prima, anche se la data è stata indicata con **Modifica** su un appuntamento «da fissare». |
| Appuntamento da fissare | Bozza `.eml` al cliente con il link di prenotazione (se configurato) o la richiesta di disponibilità. Nessuna bozza se un'email approvata allo stesso cliente parla già dell'appuntamento, o se il cliente non vi partecipa: l'azione resta da completare con la data. |
| Scadenza | Evento `.ics` per il giorno della scadenza (all'ora indicata, se c'è) con promemoria 7 giorni e 1 giorno prima, con la norma e il calcolo del termine e l'avvertenza di verificarlo. I termini processuali hanno «(da verificare)» nel titolo. Se la data è stata corretta, il calcolo originario resta solo nelle note, come superato. |
| Email | Bozza `.eml` con la firma dello studio. Se l'indirizzo non è stato detto in chiamata, viene preso dal gestionale. |
| Incarico, accordo economico, documenti, attività | Nota nella pratica del gestionale. Se serve, Seguito crea il nuovo cliente e la nuova pratica. |
| Invio della trascrizione | Bozza `.eml` alla casella dello studio, con sintesi, azioni e trascrizione completa (anche in allegato `.txt`). |

Con Microsoft 365 collegato, eventi e bozze sono creati direttamente in Outlook e dopo l'approvazione compaiono i link **Apri nel calendario** e **Apri la bozza in Outlook** (dettagli in [docs/microsoft365-setup.md](docs/microsoft365-setup.md)). Senza Microsoft 365, i file si trovano in `outbox/`, in una cartella per ogni registrazione, e si scaricano dai link che compaiono dopo l'approvazione:

- **`.ics`**: con un doppio clic si apre in Calendario di Apple o in Outlook. In Google Calendar si importa da *Impostazioni → Importa ed esporta → Importa*.
- **`.eml`**: è una bozza, **non viene inviata**. In Outlook si apre come messaggio da completare e inviare. In Apple Mail, se si apre in sola lettura, usa *Messaggio → Invia di nuovo*. In Thunderbird, *Modifica come nuovo messaggio*. Gmail sul web non apre i file `.eml` come bozze: il collegamento diretto a Gmail è previsto nella roadmap.
- **Gestionale**: le note e le pratiche vengono scritte in `data/gestionale.json`, o nel file indicato da `SEGUITO_GESTIONALE_FILE`.

Le azioni non spuntate non vengono eseguite, ma restano nella proposta: si possono approvare anche in un secondo momento, per esempio una scadenza dopo averla verificata sul fascicolo. Se un'azione approvata non riesce, la proposta resta «eseguita in parte» finché quell'azione non riesce: si può correggere e approvare di nuovo, e le azioni già eseguite non vengono ripetute. Nell'elenco, le proposte eseguite con scadenze non ancora in calendario lo segnalano. **Scarta** archivia la proposta senza eseguire nulla.

## Sicurezza e deontologia

- **Nulla parte senza approvazione.** Seguito non invia email a clienti, colleghi o controparti: crea bozze (file `.eml` o bozze in Outlook) che l'avvocato controlla e invia. Gli eventi in calendario e le note nel gestionale si creano solo per le azioni spuntate. L'unico invio possibile è quello della trascrizione alla casella dello studio, e solo se lo si sceglie (`SEGUITO_TRASCRIZIONE=invio`).
- **Telefonate con i colleghi.** L'art. 38, comma 2, del Codice deontologico forense vieta di registrare una conversazione telefonica con un collega e consente la registrazione di una riunione solo con il consenso di tutti i presenti. Se tra i partecipanti c'è un altro avvocato, Seguito mostra un avviso bloccante e non preseleziona nessuna azione. Il collega collegato al telefono o in vivavoce durante una riunione, e la videochiamata a due, sono trattati come telefonate.
- **Termini processuali.** Sono sempre segnalati come «da verificare» sul fascicolo e sul codice, anche nel titolo dell'evento in calendario. Il prompt distingue le regole di computo del processo civile (art. 155 c.p.c., proroga anche di sabato) e di quello penale (art. 172 c.p.p., il sabato non proroga), e non fa calcolare termini la cui durata non è stata detta.
- **Conflitto di interessi e controparte assistita.** Una controparte che risulta cliente dello studio produce l'avviso «Possibile conflitto di interessi» (art. 24 CDF); le email dirette alla controparte ricordano l'art. 41 CDF. In entrambi i casi l'azione non è preselezionata.
- **Collegamento al cliente.** Il solo cognome non basta per collegare un partecipante a un cliente del gestionale; il nome indicato nel campo «Cliente» dell'incarico prevale sempre.
- **Evidenze.** Ogni azione cita il minuto e la frase della trascrizione. Le citazioni che non si ritrovano nel testo vengono segnalate.
- **Dati.** Trascrizioni, proposte e file generati restano sul computer dello studio, in cartelle accessibili solo all'utente che esegue Seguito. La trascrizione passa da Plaud (o da Speechmatics per le chiamate inviate dal telefono) e, per l'analisi, da Anthropic: con ciascuno va firmato l'accordo sul trattamento dei dati (DPA). L'audio inviato dal telefono si cancella dal computer appena la trascrizione è archiviata, e da Speechmatics appena la trascrizione è pronta.

- **Interfaccia.** Risponde solo agli indirizzi IP, a `localhost` e ai nomi autorizzati (`SEGUITO_ALLOWED_HOSTS`), così una pagina web esterna non può leggere le proposte né approvarle tramite il DNS rebinding.

Informativa ai clienti, conservazione dei dati, segreto professionale e valutazione d'impatto sono trattati in [docs/privacy-e-deontologia.md](docs/privacy-e-deontologia.md).

## Struttura del progetto

```
src/
  domain/      contratti condivisi (types.ts) e gestione di date e fusi orari (time.ts)
  sources/     fonti delle registrazioni: API Plaud e file locali
  extract/     analisi con Claude (prompt e chiamata), analisi di esempio, costruzione della proposta
  enrich/      collegamento al gestionale (interfaccia e versione su file JSON)
  actions/     esecuzione delle azioni approvate: eventi, bozze (file o servizio collegato), note nel gestionale
  connectors/  servizi collegati: Microsoft 365 (accesso, Microsoft Graph, calendario e bozze)
  phone/       ricezione delle chiamate registrate inviate dall'app Android
  transcribe/  trascrizione dell'audio del telefono (Speechmatics, regione UE)
  store/       archivio locale di registrazioni e proposte
  server/      server HTTP e interfaccia web di approvazione (ui/)
  pipeline.ts  dalla registrazione alla proposta, sincronizzazione con la fonte
  cli.ts       comandi demo, serve, poll, ingest
  config.ts    configurazione dalle variabili d'ambiente
fixtures/      telefonate di esempio (plaud/), analisi pronte (extractions/), gestionale di esempio
android/      app Android che invia a Seguito le chiamate registrate dal telefono (APK compilato da GitHub Actions)
docs/          architettura, configurazione del Plaud, privacy e deontologia, decisioni di progetto
tests/         test automatici (Vitest)
```

L'architettura è descritta in [docs/architettura.md](docs/architettura.md) e le scelte fatte finora in [docs/decisioni.md](docs/decisioni.md).

## Test

```bash
npm run check
```

Il comando esegue il controllo dei tipi TypeScript e tutti i test. I test non richiedono la rete, la chiave API o un account Plaud.

## Roadmap

- **Google Workspace**: eventi in Google Calendar e bozze in Gmail (Microsoft 365 è già disponibile).
- **Gestionale dello studio**: un adattatore per il gestionale reale al posto del file JSON.
- **Supabase**: archivio e accesso condivisi, per lavorare da più dispositivi.
- **Hosting e PWA**: Seguito su un server europeo, installabile sul telefono e protetto da password.
- **n8n**: automazioni collegate agli esiti (per esempio un avviso quando arriva una nuova proposta).
