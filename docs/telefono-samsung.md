# Seguito sul Samsung Galaxy S25: le chiamate registrate dal telefono

L'app **Seguito** per Android manda a Seguito le chiamate registrate con la funzione nativa del telefono Samsung, senza passare da Plaud. Seguito le trascrive, le fa analizzare a Claude e propone le azioni da approvare, esattamente come per le registrazioni del Plaud.

```
Telefono Samsung        App Seguito (S25)          Seguito (computer dello studio)
registra la chiamata ─► trova il file e chiede ─► trascrizione ─► analisi ─► proposta
(Recordings/Call)       «Invia a Seguito?»         (servizio UE)   (Claude)   da approvare
                                    ◄──────── notifica «Proposta pronta» ─────────┘
```

L'app legge soltanto la cartella che le indichi e non modifica né cancella le registrazioni. Sul server l'audio viene cancellato appena la trascrizione è archiviata: resta solo il testo.

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

Con HTTP l'app accetta solo indirizzi della rete dello studio o di Tailscale: su Internet la password sarebbe leggibile. Quando Seguito sarà pubblicato online con HTTPS basterà indicare quell'indirizzo.

## Installare l'app

1. Sul S25 apri in Chrome l'indirizzo
   **<https://github.com/peewe75/new-app/releases/download/app-android/Seguito.apk>**
   e scarica il file.
2. Apri il file scaricato. Android chiede di consentire a Chrome (o all'app Archivio) l'installazione di app sconosciute: consentila solo per questa installazione.
3. Play Protect può segnalare che l'app non viene dal Play Store: scegli di installarla comunque. L'app è compilata da GitHub a partire dal codice di questo repository.

**Aggiornamenti.** Una versione nuova si installa dallo stesso indirizzo. Finché la chiave di firma dello studio non è configurata (vedi [Firma dell'app](#firma-dellapp)), ogni compilazione ha una firma diversa: per aggiornare va disinstallata la versione precedente e rifatta la configurazione dell'app.

## Configurare l'app

1. **Collegamento a Seguito**: indirizzo e password (`SEGUITO_PASSWORD`), poi **Salva e verifica**. Il messaggio «pronto a ricevere le registrazioni» conferma che il server ha trascrizione e analisi attive.
2. **Cartella delle registrazioni**: **Scegli la cartella**, poi **Recordings** (o **Recordings/Call**) nella memoria interna, e **Usa questa cartella**. Se la cartella *Call* non c'è ancora, fai prima una chiamata di prova registrata. Le registrazioni già presenti non vengono inviate: compaiono nell'elenco e, se serve, si inviano a mano.
3. **Invio**:
   - **Chiedi conferma per ogni chiamata** (consigliato): dopo ogni chiamata registrata arriva una notifica con **Invia a Seguito** e **Non inviare**;
   - **Invia in automatico**: le registrazioni partono da sole.
   - Restano sempre esclusi i contatti salvati come «Avv. …», «Avvocato …» o «Studio legale …» (art. 38, comma 2, del Codice deontologico forense) e i nomi o numeri dell'elenco **Non inviare mai**.
4. **Permessi**: consenti le notifiche. Il permesso **Rileva la fine delle chiamate** è facoltativo: con quello l'app cerca la registrazione appena finisce la chiamata; senza, controlla ogni 15 minuti e quando la apri.

Il Samsung può limitare le app in background per risparmiare batteria. Se le notifiche arrivano in ritardo: **Impostazioni → Batteria → Limiti di utilizzo in background** e togli Seguito dalle app in sospensione, oppure, nelle informazioni dell'app, **Batteria → Senza restrizioni**.

## Uso quotidiano

1. Durante la chiamata tocca **Registra** nell'app Telefono.
2. A fine chiamata arriva la notifica: **Invia a Seguito**.
3. Dopo qualche minuto, il tempo di trascrizione e analisi, arriva **Proposta pronta**: toccala per aprire la proposta in Seguito, controllarla e approvare le azioni.

Nell'app, l'elenco **Registrazioni** mostra lo stato di ogni chiamata: da confermare, inviata, proposta pronta, esclusa o in errore, con **Riprova** dove serve.

## Trascrizione

Le registrazioni del telefono non passano da Plaud: le trascrive un servizio di trascrizione nell'Unione europea, con riconoscimento di chi parla. Il servizio, le variabili da impostare in `.env` e l'accordo sul trattamento dei dati sono descritti nella sezione dedicata del README.

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
| Nessuna notifica dopo la chiamata | Controlla di aver toccato **Registra** durante la chiamata, il permesso delle notifiche e le limitazioni della batteria. **Controlla ora** forza la ricerca. |
| «Il permesso sulla cartella non è più valido» | Scegli di nuovo la cartella nell'app. |
| La trascrizione è vuota | La registrazione non contiene voci: per esempio con gli auricolari collegati il Samsung non registra l'interlocutore. |
