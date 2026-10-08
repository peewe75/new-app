# Seguito sul Samsung Galaxy S25: chiamate e riunioni registrate con il telefono

L'app **Seguito** per Android manda a Seguito le chiamate registrate con la funzione nativa del telefono Samsung e le registrazioni del **Registratore vocale** (riunioni con clienti e con il team, appunti), senza passare da Plaud. Seguito le trascrive, le fa analizzare a Claude e propone le azioni da approvare, esattamente come per le registrazioni del Plaud.

```
Telefono Samsung        App Seguito (S25)          Seguito (computer dello studio)
registra la chiamata ─► trova il file e chiede ─► trascrizione ─► analisi ─► proposta
(Recordings/Call)       «Invia a Seguito?»         (servizio UE)   (Claude)   da approvare
                                    ◄──────── notifica «Proposta pronta» ─────────┘
```

L'app legge soltanto due cartelle: *Recordings/Call* (chiamate) e *Recordings/Voice Recorder* (Registratore vocale). Non modifica né cancella le registrazioni. Sul server l'audio viene cancellato appena la trascrizione è archiviata: resta solo il testo.

## Cosa serve

1. **Seguito in funzione** sul computer dello studio (`npm run serve`), con:
   - `SEGUITO_PASSWORD` impostata: senza password Seguito rifiuta l'audio dal telefono;
   - la chiave di Claude (`ANTHROPIC_API_KEY`);
   - il servizio di trascrizione configurato (vedi [Trascrizione](#trascrizione)).
2. **Il telefono deve raggiungere il computer**: vedi [Rete](#rete).
3. **La registrazione delle chiamate attiva** nell'app Telefono di Samsung: **⋮ → Impostazioni → Registra chiamate**. Sui telefoni venduti in Italia la registrazione si avvia a mano durante la chiamata, con il pulsante **Registra**, e l'interlocutore sente un avviso vocale.

## Rete

Il telefono invia l'audio al computer su cui gira Seguito. Ci sono due modi.

**Sulla rete Wi-Fi dello studio.** Nel file `.env` del computer:

```bash
SEGUITO_HOST=0.0.0.0
SEGUITO_PASSWORD=<una password robusta>
```

Nell'app l'indirizzo è quello del computer nella rete dello studio, per esempio `http://192.168.1.20:3000`. Lo trovi nelle impostazioni di rete del computer. Conviene assegnargli un indirizzo fisso dal router. Le registrazioni fatte fuori studio partono al rientro: l'app riprova da sola.

**Anche fuori studio, con Tailscale (consigliato).** [Tailscale](https://tailscale.com) crea una rete privata cifrata tra i tuoi dispositivi, gratuita per uso personale.

1. Installa Tailscale sul computer dello studio e sul S25 ed entra con lo stesso account.
2. Nel file `.env` del computer imposta `SEGUITO_HOST=0.0.0.0` e `SEGUITO_PASSWORD`. Se usi il nome del computer al posto dell'indirizzo, aggiungilo anche a `SEGUITO_ALLOWED_HOSTS`, per esempio `SEGUITO_ALLOWED_HOSTS=pc-studio.tail1234.ts.net`.
3. Nell'app usa l'indirizzo Tailscale del computer, per esempio `http://100.101.102.103:3000` o `http://pc-studio.tail1234.ts.net:3000`.

Con HTTP l'app accetta solo indirizzi della rete dello studio o di Tailscale: su Internet la password sarebbe leggibile. Se usi un nome (per esempio `pc-studio.lan` o `….ts.net`), prima di ogni invio l'app controlla che porti davvero a un indirizzo della rete dello studio o di Tailscale; su una rete estranea l'invio viene bloccato. L'indirizzo IP del computer è la scelta più semplice. Quando Seguito sarà pubblicato online con HTTPS basterà indicare quell'indirizzo.

## Installare l'app

1. Sul S25 apri in Chrome l'indirizzo
   **<https://github.com/peewe75/new-app/releases/download/app-android/Seguito.apk>**
   e scarica il file.
2. Apri il file scaricato. Android chiede di consentire a Chrome (o all'app Archivio) l'installazione di app sconosciute: consentila solo per questa installazione.
3. Play Protect può segnalare che l'app non viene dal Play Store: scegli di installarla comunque. L'app è compilata da GitHub a partire dal codice di questo repository.

**Aggiornamenti.** Una versione nuova si installa dallo stesso indirizzo. Finché la chiave di firma dello studio non è configurata (vedi [Firma dell'app](#firma-dellapp)), ogni compilazione ha una firma diversa: per aggiornare va disinstallata la versione precedente e rifatta la configurazione dell'app.

## Configurare l'app

1. **Collegamento a Seguito**: indirizzo e password (`SEGUITO_PASSWORD`), poi **Salva e verifica**. Il messaggio «pronto a ricevere le registrazioni» conferma che il server ha trascrizione e analisi attive.
2. **Cartella delle registrazioni**: **Scegli la cartella**, poi **Recordings** nella memoria interna, e **Usa questa cartella**. Da lì l'app legge *Call* e *Voice Recorder*. Se scegli solo *Recordings/Call*, le registrazioni vocali non sono raggiungibili e l'app lo segnala. Se le cartelle non ci sono ancora, fai prima una chiamata registrata e una registrazione di prova. Le registrazioni già presenti non vengono inviate: compaiono nell'elenco e, se serve, si inviano a mano.
3. **Invio**:
   - **Chiedi conferma per ogni chiamata** (consigliato): dopo ogni chiamata registrata arriva una notifica con **Invia a Seguito** e **Non inviare**;
   - **Invia in automatico**: le registrazioni partono da sole.
   - Restano sempre esclusi i contatti salvati come «Avv. …», «Avvocato …» o «Studio legale …» (art. 38, comma 2, del Codice deontologico forense) e i nomi o numeri dell'elenco **Non inviare mai**.
   - Nell'elenco **Non inviare mai**, per chi è in rubrica scrivi il **nome** come è salvato: per i contatti in rubrica il Samsung mette nel nome del file solo il nome, non il numero. I numeri servono per chi non è in rubrica.
   - Le esclusioni si ricontrollano anche al momento dell'invio: un nome aggiunto all'elenco blocca anche le registrazioni già in coda. Finché una registrazione è in coda puoi toccare **Annulla l'invio**.
   - Con il telefono bloccato, **Invia a Seguito** nella notifica chiede prima lo sblocco.
4. **Permessi**: consenti le notifiche. Il permesso **Rileva la fine delle chiamate** è facoltativo: con quello l'app cerca la registrazione appena finisce la chiamata; senza, controlla ogni 15 minuti e quando la apri.

Il Samsung può limitare le app in background per risparmiare batteria. Per avere la notifica appena salvi una registrazione, nelle informazioni dell'app imposta **Batteria → Senza restrizioni** e, in **Impostazioni → Batteria → Limiti di utilizzo in background**, aggiungi Seguito alle **App mai in sospensione**. Senza queste impostazioni le notifiche possono arrivare in ritardo: l'app controlla comunque ogni 15 minuti e ogni volta che la apri.

## Uso quotidiano

**Chiamate**

1. Durante la chiamata tocca **Registra** nell'app Telefono.
2. A fine chiamata arriva la notifica: **Invia a Seguito**.
3. Dopo qualche minuto, il tempo di trascrizione e analisi, arriva **Proposta pronta**: toccala per aprire la proposta in Seguito, controllarla e approvare le azioni.

**Riunioni e appunti (Registratore vocale)**

1. Registra con il **Registratore vocale** del Samsung e, alla fine, tocca **Salva**. Nel nome puoi già scrivere di che cosa si tratta, per esempio «Riunione Rossi».
2. Arriva la notifica **Registrazione vocale**. Toccandola si apre l'app: puoi aggiungere un titolo, per esempio «Riunione con il cliente Rossi» o «Riunione di team», poi **Invia a Seguito**. Il titolo aiuta l'analisi e ritrovi la proposta più facilmente.
3. Come per le chiamate, arriva **Proposta pronta**.

Le registrazioni vocali chiedono sempre conferma, anche con **Invia in automatico**: dal nome del file non si capisce chi è presente e se la registrazione è di lavoro. L'interruttore **Registrazioni vocali** nella sezione **Invio** le attiva o le disattiva. Quando lo attivi, le registrazioni vocali già presenti non vengono proposte. L'elenco **Non inviare mai** vale anche per loro: i nomi si cercano nel nome del file e nel titolo.

Per le riunioni lunghe:

- l'invio è più rapido sulla rete Wi-Fi dello studio: un'ora di registrazione occupa circa 55 MB;
- Android interrompe un invio che dura più di 10 minuti. Con una rete mobile lenta l'app riprova da sola, ma conviene inviare dal Wi-Fi;
- il Registratore vocale del Samsung può fermarsi dopo circa 3 ore: per riunioni più lunghe avvia una seconda registrazione.

Nell'app, l'elenco **Registrazioni** mostra lo stato di ogni chiamata: da confermare, inviata, proposta pronta, esclusa o in errore, con **Riprova** dove serve.

## Trascrizione

Le registrazioni del telefono non passano da Plaud: le trascrive **Speechmatics** sui server dell'Unione europea (regione EU1), in italiano, con il modello *enhanced* (il più accurato) e il riconoscimento di chi parla.

1. Crea l'account dello studio sul [Portale di Speechmatics](https://portal.speechmatics.com). Il credito gratuito iniziale basta per le prove.
2. In **Settings → API Keys** crea una chiave, per esempio «Seguito studio», e copiala.
3. Nel file `.env` del computer dello studio:

   ```bash
   SPEECHMATICS_API_KEY=<la chiave>
   # facoltativo: nomi e termini da riconoscere meglio, separati da virgole
   SEGUITO_TELEFONO_VOCABOLARIO=Esposito,Tribunale di Nola
   ```

4. Riavvia Seguito. All'avvio compare «Ricezione delle chiamate dal telefono attiva (trascrizione: Speechmatics, eu1.asr.api.speechmatics.com)».

Che cosa succede a ogni chiamata:

- Seguito invia l'audio a Speechmatics con un nome neutro (nessun nome del cliente nei dati del lavoro) e un vocabolario di termini giuridici, più quelli di `SEGUITO_TELEFONO_VOCABOLARIO`;
- appena ha la trascrizione chiede a Speechmatics di cancellare audio e testo; se la cancellazione non riesce, Speechmatics li elimina comunque dopo 7 giorni;
- sul computer dello studio l'audio si cancella dopo l'archiviazione della trascrizione;
- se Speechmatics non risponde o è sovraccarico, Seguito riprova da solo (dopo 1, 5, 15 minuti, 1 ora e 6 ore). Una chiave errata o un credito esaurito restano in errore finché non li correggi e tocchi **Riprova**.

La chiave di Speechmatics resta sul computer: l'app sul telefono non la conosce.

**Costi.** Si paga a ore di audio trascritto. A ottobre 2026 il modello *enhanced* costava circa 0,40 $ l'ora, ma questo prezzo non è stato verificato sul listino ufficiale: controllalo nel Portale prima di attivare il servizio.

**Accordo sul trattamento dei dati (DPA).** Speechmatics tratta l'audio come responsabile del trattamento (art. 28 GDPR). Per gli account self-service l'accordo è nei Termini di servizio. Prima di inviare chiamate vere con i clienti:

- chiedi al [supporto di Speechmatics](https://support.speechmatics.com) il DPA da firmare;
- chiedi anche una conferma scritta che l'audio non viene usato per addestrare i modelli.

Fino ad allora usa solo registrazioni di prova.

## Privacy e deontologia

- **Avviso all'interlocutore**: il Samsung lo fa ascoltare a ogni registrazione. Resta da curare l'informativa ai clienti (vedi [privacy-e-deontologia.md](privacy-e-deontologia.md)).
- **Colleghi**: non registrare le telefonate con altri avvocati. L'app non invia le chiamate con contatti salvati come avvocati e Seguito, se una conversazione con un collega arriva comunque, mostra l'avviso bloccante dell'art. 38.
- **Dove restano i dati**: l'audio resta sul telefono, nella cartella del Samsung, finché non lo cancelli. Sul server viene cancellato dopo la trascrizione. Il servizio di trascrizione tratta l'audio come responsabile del trattamento: va firmato il suo accordo (DPA).
- **App**: la password di Seguito è cifrata con una chiave del telefono che non esce dal dispositivo. Dati e impostazioni dell'app sono esclusi dai backup.

## Firma dell'app

Senza configurazione, GitHub firma ogni APK con una chiave di prova diversa. Per aggiornare l'app senza disinstallarla serve una chiave dello studio, conservata nei **segreti** del repository: il repository è pubblico, quindi la chiave non deve mai stare tra i file.

1. Su un computer con Java crea la chiave (conservane una copia sicura e la password):

   ```bash
   keytool -genkeypair -v -keystore seguito.jks -alias seguito -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 seguito.jks > seguito.jks.b64   # su macOS: base64 -i seguito.jks -o seguito.jks.b64
   ```

2. Su GitHub, in **Settings → Secrets and variables → Actions → New repository secret**, crea:
   - `SEGUITO_KEYSTORE_BASE64`: il contenuto di `seguito.jks.b64`;
   - `SEGUITO_KEYSTORE_PASSWORD` e `SEGUITO_KEY_PASSWORD`: la password scelta;
   - `SEGUITO_KEY_ALIAS`: `seguito`.
3. Dalla compilazione successiva l'APK è firmato con quella chiave. Disinstalla una volta la versione con la firma di prova e installa la nuova: da lì in poi gli aggiornamenti si installano sopra.

Dal 2027 Android chiederà che anche le app installate fuori dal Play Store vengano da sviluppatori verificati: quando la regola arriverà in Italia andrà registrato l'account sviluppatore dello studio.

## Problemi frequenti

| Messaggio o sintomo | Che cosa fare |
|---|---|
| «Seguito non raggiungibile» | Il telefono non vede il computer: stessa rete Wi-Fi o Tailscale attivo su entrambi, Seguito avviato, `SEGUITO_HOST=0.0.0.0`. L'invio riprova da solo. |
| «Password errata» | Deve essere quella di `SEGUITO_PASSWORD` sul computer. |
| «Per ricevere le registrazioni dal telefono impostare SEGUITO_PASSWORD» | Imposta la password nel file `.env` e riavvia Seguito. |
| «Richiesta rifiutata: nome host non autorizzato» | Aggiungi il nome usato nell'indirizzo a `SEGUITO_ALLOWED_HOSTS`, oppure usa l'indirizzo IP. |
| «la ricezione dal telefono non è attiva» | Sul computer mancano la chiave di Claude o il servizio di trascrizione. |
| Nessuna notifica dopo una registrazione vocale | Interruttore **Registrazioni vocali** attivo, cartella **Recordings** (non solo *Call*), batteria **Senza restrizioni**. **Controlla ora** forza la ricerca. |
| Nessuna notifica dopo la chiamata | Controlla di aver toccato **Registra** durante la chiamata, il permesso delle notifiche e le limitazioni della batteria. **Controlla ora** forza la ricerca. |
| «Il permesso sulla cartella non è più valido» | Scegli di nuovo la cartella nell'app. |
| «Chiave di Speechmatics non valida» | Controlla `SPEECHMATICS_API_KEY` nel file `.env`, riavvia Seguito e tocca **Riprova**. |
| «licenza o crediti esauriti» | Ricarica il credito o attiva il piano nel Portale di Speechmatics, poi tocca **Riprova**. |
| La trascrizione è vuota | La registrazione non contiene voci: per esempio con gli auricolari collegati il Samsung non registra l'interlocutore. |
