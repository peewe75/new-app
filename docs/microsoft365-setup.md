# Collegare Seguito a Microsoft 365

Con Microsoft 365 collegato, quando approvi una proposta Seguito:

- crea gli **eventi nel calendario Outlook** (appuntamenti e scadenze, con la categoria «Seguito»);
- crea le **bozze nella cartella Bozze** di Outlook: le apri, le controlli e le invii tu;
- per la trascrizione allo studio crea una bozza oppure, se lo scegli (`SEGUITO_TRASCRIZIONE=invio`), la invia direttamente, ma **solo** alla casella dello studio indicata in `SEGUITO_STUDIO_EMAIL`.

Nessuna email parte verso clienti, colleghi o controparti: restano tutte bozze.

Serve una volta sola registrare Seguito come applicazione nel tenant Microsoft 365 dello studio. Ci vogliono circa 10 minuti e un account amministratore.

## 1. Registrare l'applicazione

1. Apri l'**interfaccia di amministrazione di Microsoft Entra** (<https://entra.microsoft.com>) con l'account amministratore dello studio.
2. Vai in **Applicazioni → Registrazioni app → Nuova registrazione**.
3. Compila:
   - **Nome**: `Seguito`;
   - **Tipi di account supportati**: *Solo account in questa directory organizzativa* (tenant singolo);
   - **URI di reindirizzamento**: piattaforma **Web**, indirizzo `http://localhost:3000/auth/microsoft/callback`.
4. Premi **Registra**. Nella pagina *Panoramica* copia:
   - **ID applicazione (client)** → `SEGUITO_M365_CLIENT_ID`;
   - **ID della directory (tenant)** → `SEGUITO_M365_TENANT_ID`.

Quando Seguito sarà pubblicato online, aggiungerai in **Autenticazione** anche l'indirizzo pubblico, per esempio `https://seguito.example.it/auth/microsoft/callback`, e lo indicherai in `SEGUITO_M365_REDIRECT_URI`.

## 2. Creare il segreto

1. In **Certificati e segreti → Segreti client → Nuovo segreto client**, descrizione `Seguito`, scadenza 24 mesi.
2. Copia subito il **Valore** (non l'ID): è visibile una sola volta → `SEGUITO_M365_CLIENT_SECRET`.
3. Segna in agenda la scadenza del segreto: quando scade, Seguito segnala «Credenziali dell'applicazione Microsoft non valide» e va creato un segreto nuovo.

## 3. Concedere i permessi

1. In **Autorizzazioni API → Aggiungi un'autorizzazione → Microsoft Graph → Autorizzazioni delegate**, seleziona:
   - `User.Read` (nome e indirizzo dell'account collegato);
   - `Mail.ReadWrite` (creare le bozze);
   - `Calendars.ReadWrite` (creare gli eventi);
   - `offline_access` (restare collegati senza ripetere l'accesso);
   - `Mail.Send`, **solo** se vuoi l'invio diretto della trascrizione allo studio (`SEGUITO_TRASCRIZIONE=invio`).
2. Premi **Concedi consenso amministratore per …** e conferma.

Sono autorizzazioni *delegate*: Seguito agisce solo sulla casella e sul calendario dell'account che si collega, non sulle altre caselle dello studio.

## 4. Configurare Seguito

Nel file `.env`:

```bash
SEGUITO_M365_TENANT_ID=<ID della directory (tenant)>
SEGUITO_M365_CLIENT_ID=<ID applicazione (client)>
SEGUITO_M365_CLIENT_SECRET=<valore del segreto>
# Facoltativi:
# SEGUITO_M365_REDIRECT_URI=http://localhost:3000/auth/microsoft/callback
# SEGUITO_TRASCRIZIONE=invio
```

Avvia Seguito con `npm run serve`, apri **<http://localhost:3000>** (proprio `localhost`, lo stesso nome dell'indirizzo di reindirizzamento) e premi **Collega Microsoft 365**. Accedi con l'account dell'avvocato: Seguito torna all'elenco con «Microsoft 365 collegato».

I token restano nel file `data/microsoft365.json` (o in `SEGUITO_M365_TOKENS_FILE`), leggibile solo dall'utente che esegue Seguito, e si rinnovano da soli. **Scollega**, nell'elenco delle registrazioni, cancella il file.

## Come appaiono eventi e bozze

| Azione approvata | In Outlook |
|---|---|
| Appuntamento con data e ora | Evento nel calendario, «Occupato», promemoria un'ora prima. |
| Scadenza | Evento sull'intera giornata, «Libero», promemoria 7 giorni prima; i termini processuali hanno «(da verificare)» nel titolo. |
| Email, appuntamento da fissare | Bozza nella cartella Bozze, con la firma dello studio. |
| Invio della trascrizione | Bozza alla casella dello studio, con la trascrizione anche in allegato; con `SEGUITO_TRASCRIZIONE=invio` è inviata direttamente. |

Dopo l'approvazione, ogni azione ha il link **Apri nel calendario** o **Apri la bozza in Outlook**.

Outlook ammette un solo promemoria per evento: Seguito usa il più importante (un'ora prima per gli appuntamenti, 7 giorni prima per le scadenze). I file `.ics` della versione senza Microsoft 365 ne hanno due.

## Problemi frequenti

| Messaggio | Che cosa fare |
|---|---|
| «Microsoft 365 non è collegato» | Premi **Collega Microsoft 365** e approva di nuovo le azioni rimaste in errore: quelle già eseguite non si ripetono. |
| «Il collegamento a Microsoft 365 è scaduto o è stato revocato» | Il collegamento dura finché viene usato; dopo un lungo periodo di inattività, o se la password è cambiata, va ripetuto. |
| «Credenziali dell'applicazione Microsoft non valide» | Il segreto è scaduto o è stato copiato male: creane uno nuovo (passo 2). |
| «L'applicazione non ha ancora i permessi richiesti» | Manca il consenso amministratore (passo 3). |
| Dopo l'accesso, errore di Microsoft sull'indirizzo di reindirizzamento | L'indirizzo registrato (passo 1) e `SEGUITO_M365_REDIRECT_URI` devono coincidere carattere per carattere. |
