# Configurare il Plaud Note Pro per Seguito

Guida passo passo per quando arriva il Plaud Note Pro: dall'app al template di riassunto, fino al collegamento con Seguito. Le voci di menu dell'app Plaud cambiano a volte tra una versione e l'altra. Se un nome non corrisponde esattamente, cerca la voce più simile.

## 1. App e account

1. Installa l'app **Plaud** dall'App Store o da Google Play.
2. Crea l'account con l'indirizzo email dello studio che userai stabilmente. Usa una password robusta e non condivisa. Attiva la verifica in due passaggi, se l'app la offre.
3. **Area dei dati.** Plaud dichiara che i dati degli account europei sono conservati in Europa, su AWS a Francoforte. In fase di registrazione e poi nelle impostazioni dell'account, verifica che l'account risulti europeo. È un elemento da riportare nella documentazione privacy dello studio (vedi [privacy-e-deontologia.md](privacy-e-deontologia.md)).
4. Accendi il Note Pro, abbinalo all'app seguendo le istruzioni a schermo e installa l'eventuale aggiornamento del firmware.
5. Imposta l'**italiano** come lingua della trascrizione.

## 2. Piano Starter: i minuti di trascrizione

L'acquisto del Note Pro include il piano **Starter**, gratuito: **300 minuti di trascrizione al mese**. Per iniziare bastano: sono circa venti telefonate da un quarto d'ora.

- I minuti si azzerano a ogni rinnovo mensile e quelli non usati non si accumulano.
- Superato il limite, il dispositivo continua a registrare, ma la trascrizione si ferma fino al rinnovo o a un acquisto di minuti aggiuntivi. Senza trascrizione Seguito non può analizzare la registrazione.
- Controlla ogni tanto i minuti residui nella sezione dell'app dedicata al piano.
- Se arrivi spesso vicino al limite, valuta il piano **Pro**, che oggi prevede 1.200 minuti al mese. Limiti e prezzi cambiano: verificali sul sito di Plaud prima di decidere.
- Non far trascrivere ciò che non serve: una registrazione fatta per errore, per esempio una telefonata con un collega, va cancellata senza trascriverla.

## 3. Registrare le telefonate

Il Note Pro registra le telefonate con un **sensore a conduzione di vibrazioni**: «ascolta» le vibrazioni del telefono e capta così entrambe le voci. Per questo il dispositivo deve stare **a contatto con il telefono**.

1. **Posizionamento.** Aggancia il Note Pro al retro del telefono. Sugli iPhone con MagSafe si attacca direttamente. Sugli altri telefoni serve un anello magnetico adesivo: verifica se è incluso nella confezione. Con una cover spessa la qualità può peggiorare: usa una cover compatibile con MagSafe oppure applica l'anello sulla cover.
2. **Niente auricolari.** Durante le telefonate da registrare non usare auricolari, cuffie Bluetooth o il vivavoce dell'auto. Il sensore capta l'audio che passa dal telefono: con gli auricolari la voce dell'interlocutore non viene registrata.
3. **Modalità automatica.** Il Note Pro riconosce da solo se è in corso una telefonata o una riunione e passa alla modalità adatta. Non serve un selettore come sul modello precedente.
4. **Avvio e fine.** Avvia la registrazione con il pulsante del dispositivo e controlla l'indicazione di registrazione in corso. Interrompila a fine chiamata.
5. **Riunioni in studio.** Appoggia il Note Pro sul tavolo, tra i partecipanti, lontano da fonti di rumore come il condizionatore o la stampante.
6. **Trasferimento.** Dopo la registrazione apri l'app: il file passa dal dispositivo all'app e da lì al cloud di Plaud. Finché il file resta solo sul dispositivo, Seguito non lo vede.

> **Prima di premere il pulsante.** Non registrare le telefonate con i colleghi: l'art. 38, comma 2, del Codice deontologico forense lo vieta. Le riunioni con colleghi si registrano solo con il consenso di tutti i presenti, da chiedere e da far risultare all'inizio della registrazione. Con i clienti e con i terzi, informali della registrazione (vedi [privacy-e-deontologia.md](privacy-e-deontologia.md)). Seguito segnala le conversazioni con i colleghi, ma la scelta di registrare spetta all'avvocato.

## 4. Il template di riassunto «Seguito – Post-chiamata»

Plaud prepara un riassunto di ogni registrazione secondo un template. Con un template dedicato il riassunto segue le stesse sezioni che Seguito usa. Claude lo riceve come aiuto, anche se la fonte che prevale resta la trascrizione.

1. Nell'app apri **Esplora** (Explore) → **Template Community**. Su Plaud Web, la Template Community è nella barra laterale.
2. Tocca **Crea** (Create) e scegli **Description to template**: il template si crea da una descrizione scritta.
3. Come nome inserisci esattamente **`Seguito – Post-chiamata`**. Il nome deve contenere la parola «Seguito»: è così che Seguito riconosce, tra i riassunti di una registrazione, quello fatto con il template dello studio.
4. Incolla come descrizione il testo qui sotto e conferma la creazione.
5. Il template resta **privato**: non pubblicarlo nella community.
6. Se l'app lo consente, impostalo come template predefinito. Altrimenti sceglilo ogni volta che generi il riassunto.

```text
Sei l'assistente di uno studio legale italiano. Dalla registrazione di una telefonata o di una riunione dell'avvocato dello studio prepara un riepilogo operativo in italiano, con le sezioni seguenti, in quest'ordine e con questi titoli.

## PARTECIPANTI
Per ogni persona: nome e cognome (se detti), ruolo (avvocato dello studio, cliente, potenziale cliente, controparte, altro avvocato, consulente, altro) ed eventuale ente o società. Accanto a ciascuno scrivi "AVVOCATO: SÌ" se è un avvocato, compreso il difensore della controparte, altrimenti "AVVOCATO: NO". Elenca anche le persone e le società citate ma non presenti, se rilevanti, con la nota "(citata, non presente)".

## APPUNTAMENTI
Per ogni appuntamento: "FISSATO", con giorno della settimana, data, ora, luogo o modalità e durata se detta; oppure "DA FISSARE", con quanto detto sui tempi e su chi deve fissarlo.

## INCARICO
Oggetto della pratica, controparte e stato del mandato: "CONFERITO", "IN VALUTAZIONE" o "NON CONFERITO".

## ACCORDI ECONOMICI
Importi, criterio (a forfait, a ore, per fasi, a percentuale), "oltre IVA e CPA" se detto, acconto e tempi di pagamento. Indica se l'accordo è "CONCORDATO" o solo "PROPOSTO".

## SCADENZE E TERMINI
Termini processuali, contrattuali o amministrativi e udienze: data, evento da cui decorrono e norma, solo se detti. Non calcolare termini che nessuno ha indicato.

## DOCUMENTI
Documenti da ricevere e da inviare: elenco puntuale, chi li deve consegnare o a chi vanno inviati, entro quando.

## EMAIL DA INVIARE
Destinatario, scopo e contenuto essenziale di ogni comunicazione scritta da inviare. Riporta l'indirizzo email solo se è stato dettato.

## ALTRE AZIONI
Attività interne dello studio emerse dalla conversazione.

## SINTESI
Al massimo 5 righe: chi ha parlato con chi, di che cosa e che cosa si è deciso.

## PUNTI DUBBI
Nomi, date, importi o impegni incerti, ambigui o contraddittori da verificare.

Regole:
- Riporta solo ciò che è stato detto. Non dedurre e non inventare nomi, date, orari, importi, indirizzi o numeri di telefono.
- Per ogni punto indica tra parentesi quadre il minuto della registrazione in cui se ne parla, nel formato [mm:ss].
- Se una sezione non ha contenuto, scrivi "Nessuno".
- Scrivi le date per esteso (per esempio "giovedì 15 ottobre 2026, ore 10:00") e gli importi in cifre (per esempio "€ 2.500").
- Non aggiungere valutazioni, consigli o commenti personali.
```

Un esempio di riassunto prodotto con questo template si trova nei file della demo, nel campo `note_list` di `fixtures/plaud/demo-rossi-decreto-ingiuntivo.json`.

## 5. Collegare Seguito

Esegui questi passaggi **sul computer su cui gira Seguito**.

1. Installa Seguito (vedi il [README](../README.md)): Node.js 22 e `npm install` nella cartella del progetto.
2. Collega l'account Plaud:

   ```bash
   npx @plaud-ai/cli login
   ```

   Segui le istruzioni ed entra con lo stesso account usato nell'app. Le credenziali (token di accesso) vengono salvate nella cartella `~/.plaud`, nel file `tokens.json`. Seguito le legge da lì e le rinnova da solo quando scadono. Il file dà accesso alle registrazioni: non copiarlo su altri computer e non condividerlo. Per scollegare Seguito da Plaud basta cancellarlo.
3. Copia `.env.example` in `.env` e inserisci almeno `ANTHROPIC_API_KEY` e gli indirizzi email dello studio.
4. Fai una **prova**: registra una breve nota vocale di prova in cui leggi un appuntamento inventato e aspetta che nell'app compaiano trascrizione e riassunto. Poi esegui:

   ```bash
   npm run poll
   ```

   Seguito indica quante registrazioni ha elaborato. Avvia l'interfaccia con `npm run serve` e apri <http://127.0.0.1:3000>.
5. **Nell'uso quotidiano** puoi lasciare aperte due finestre del terminale: una con `npm run poll -- --watch 5`, che controlla le registrazioni nuove ogni 5 minuti, e una con `npm run serve`. In alternativa, tieni aperto solo `npm run serve` e premi **Aggiorna** nell'interfaccia quando vuoi controllare.

Seguito analizza ogni registrazione una sola volta, anche con `poll` e `serve` aperti insieme. Le registrazioni ancora senza trascrizione vengono riprovate al controllo successivo. Un'analisi non riuscita per un errore transitorio viene ritentata con attese crescenti (da 15 minuti a un giorno); se l'errore si ripeterebbe uguale, per esempio una registrazione troppo lunga per il limite di token, Seguito non la ripete da solo: rimossa la causa, esegui `npm run poll -- --retry-failed`.

## 6. Problemi frequenti

**«Credenziali Plaud non trovate», «La sessione Plaud è scaduta» o «Accesso a Plaud non autorizzato»**
Ripeti `npx @plaud-ai/cli login` con lo stesso utente del computer che esegue Seguito. Se hai spostato il file delle credenziali, indica il percorso in `PLAUD_TOKENS_PATH`.

**«La trascrizione non è ancora disponibile in Plaud»**
La registrazione esiste, ma Plaud non l'ha ancora trascritta. Controlla nell'app che il file sia stato trasferito dal dispositivo, che la trascrizione sia stata generata e che restino minuti nel piano. Non serve fare altro: Seguito riprova al controllo successivo.

**Nessuna registrazione nuova**
- La registrazione è ancora sul dispositivo: apri l'app per trasferirla.
- L'account usato per il login è diverso da quello dell'app.
- La registrazione era già stata analizzata: Seguito non la ripete e la proposta è già nell'elenco.
- Con `--watch` il controllo successivo arriva dopo i minuti indicati: per non aspettare, premi **Aggiorna** nell'interfaccia.
- L'analisi non era riuscita ed è in attesa del nuovo tentativo: il riepilogo indica le «analisi rinviate». Per ripeterla subito, `npm run poll -- --retry-failed`.

**Il riassunto di Plaud non viene usato**
Il nome del template deve contenere «Seguito». Senza il template dello studio Seguito usa il primo riassunto disponibile, o nessuno. L'analisi funziona comunque, perché si basa sulla trascrizione.

**Si sente una voce sola, o l'audio è disturbato**
Controlla che non fossero collegati auricolari o il vivavoce dell'auto. Verifica la posizione del Note Pro sul retro del telefono e lo spessore della cover.

**Parlanti scambiati**
La trascrizione automatica può attribuire una battuta alla persona sbagliata. Claude ne tiene conto e segnala i casi dubbi. Puoi rinominare i parlanti nell'app Plaud, ma la verifica finale resta dell'avvocato.

**«Impossibile contattare Plaud» o «Plaud non ha risposto entro il tempo massimo»**
Verifica la connessione a Internet e riprova più tardi.
