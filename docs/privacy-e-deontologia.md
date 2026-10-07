# Privacy e deontologia

Questo documento raccoglie i punti deontologici e di protezione dei dati da considerare prima di usare Seguito con conversazioni vere. Contiene indicazioni operative e raccomandazioni, **non un parere**: le valutazioni finali spettano all'avvocato, eventualmente con il consulente privacy o il DPO dello studio. I riferimenti normativi sono aggiornati a ottobre 2026: prima di farvi affidamento, conviene verificare il testo vigente delle norme e i termini contrattuali dei fornitori.

## 1. Le conversazioni con i colleghi

### La regola

L'**art. 38, comma 2, del Codice deontologico forense** vieta all'avvocato di registrare una conversazione telefonica con un collega. Nel corso di una riunione la registrazione è consentita **soltanto con il consenso di tutti i presenti**. La violazione ha rilievo disciplinare. Secondo la giurisprudenza disciplinare del CNF il divieto riguarda anche l'uso del vivavoce per far ascoltare la telefonata a terzi senza avvisare il collega (CNF, sentenza n. 7 del 2016).

In pratica:

- **non avviare il Plaud nelle telefonate con altri avvocati**: il difensore della controparte, il domiciliatario, il codifensore, un collega di un altro studio;
- nelle **riunioni** con colleghi, chiedere il consenso di tutti prima di iniziare e farlo risultare all'inizio della registrazione, per esempio: «Diamo atto che tutti i presenti acconsentono alla registrazione». Seguito non può verificare il consenso;
- una conversazione con un collega **registrata per errore** non va utilizzata. Si consiglia di cancellarla subito (vedi più avanti).

### Come lo segnala Seguito

Claude classifica ogni partecipante. Qualsiasi altro avvocato, compreso il difensore della controparte, riceve il ruolo «collega avvocato». Se almeno un collega ha parlato nella conversazione:

- la proposta mostra un **avviso bloccante in rosso** (codice interno `COLLEGA_ART38`). Il testo dell'avviso dipende dal tipo di conversazione: per una telefonata ricorda il divieto e invita a valutare la cancellazione della registrazione; una videochiamata a due è trattata, in via prudenziale, come una telefonata; per una riunione, o una videochiamata con più partecipanti, ricorda che serve il consenso di tutti i presenti e che il divieto vale comunque se il collega era collegato al telefono o in vivavoce;
- **nessuna azione è preselezionata**, nemmeno l'invio della trascrizione alla casella dello studio: per eseguire qualcosa l'avvocato deve spuntarla consapevolmente.

La demo contiene questo caso: la telefonata con l'Avv. Giulia Bianchi.

Claude ha l'istruzione di indicare come «telefonata» una conversazione in cui qualcuno partecipa al telefono o in vivavoce, anche durante una riunione in studio, e di segnalare tra i dubbi il vivavoce e le persone presenti in ascolto.

**Limiti.** Il riconoscimento dipende da ciò che si dice nella conversazione. Se l'interlocutore non viene mai presentato come avvocato, per esempio un collega chiamato solo per nome, l'avviso può mancare. L'avviso è una rete di sicurezza, non sostituisce l'attenzione di chi registra.

### Cancellare una registrazione

1. **In Plaud**: elimina la registrazione dall'app. Se l'app ha un cestino, svuotalo, così la registrazione viene eliminata anche dal cloud.
2. **In Seguito**: **Scarta** archivia la proposta senza eseguire nulla, ma non cancella i file. Per la cancellazione completa elimina i file della registrazione nelle cartelle `data/recordings/` e `data/proposals/`. Il nome dei file contiene l'identificativo della registrazione. Se avevi approvato qualche azione, elimina anche la cartella corrispondente in `outbox/`.
3. Se la trascrizione era già stata inviata alla casella dello studio o annotata nel gestionale, eliminala anche da lì.

## 2. Le conversazioni con clienti e terzi

Secondo la giurisprudenza consolidata (a partire da Cass., Sez. Un., n. 36747 del 2003), la registrazione di un colloquio da parte di chi vi partecipa non è un'intercettazione. Resta però un **trattamento di dati personali**, soggetto al GDPR e ai doveri di lealtà e riservatezza dell'avvocato. Raccomandazioni:

- **avvisare all'inizio della conversazione**, per esempio: «Le segnalo che registro la telefonata per prendere appunti; la trascrizione resta riservata nello studio». Se l'interlocutore si oppone, non registrare;
- inserire la clausola sulla registrazione nell'**informativa** e nel **mandato** (testo di esempio al paragrafo 3);
- informare anche i terzi che non sono avvocati, come i consulenti di parte o i familiari del cliente presenti all'incontro;
- non registrare quando non serve: una registrazione non necessaria è un rischio senza beneficio.

### Altri controlli deontologici della proposta

- **Conflitto di interessi (art. 24 del Codice deontologico forense).** Le controparti indicate nella conversazione e negli incarichi sono cercate tra i clienti del gestionale, anche per il solo cognome. Se una corrisponde, la proposta mostra l'avviso «Possibile conflitto di interessi» con le pratiche del cliente, e l'incarico non è preselezionato.
- **Controparte assistita da un collega (art. 41).** Le bozze di email indirizzate alla controparte ricevono un avviso e non sono preselezionate: se la controparte è assistita, le si può scrivere direttamente solo per richiedere comportamenti determinati, intimare messe in mora o evitare prescrizioni o decadenze, sempre con copia al collega.
- **Collegamento al cliente.** Un partecipante indicato con il solo cognome non viene mai collegato in automatico a un cliente del gestionale: la proposta chiede di verificarlo, per non annotare la pratica di una persona nel fascicolo di un'altra.

Sono controlli di supporto: non sostituiscono le verifiche dell'avvocato.

## 3. Protezione dei dati (GDPR)

### Ruoli

| Soggetto | Ruolo | Che cosa tratta |
|---|---|---|
| Studio (l'avvocato) | **Titolare** del trattamento | Tutto: decide se registrare, che cosa analizzare, che cosa conservare. |
| Plaud | **Responsabile** del trattamento (art. 28 GDPR) | Audio, trascrizione e riassunto, nel dispositivo, nell'app e nel cloud Plaud. Plaud si avvale a sua volta di fornitori, tra cui fornitori di modelli di intelligenza artificiale per trascrizione e riassunti (**sub-responsabili**). |
| Anthropic | **Responsabile** del trattamento | Testo della trascrizione, riassunto Plaud, titolo e data della registrazione, nome dello studio e dell'avvocato, inviati per l'analisi con Claude. L'audio non viene inviato. |
| Fornitori di posta e calendario già in uso | Responsabili, secondo i contratti già in essere | Le bozze inviate e gli eventi importati. |

### Il percorso dei dati

1. **Registrazione**: l'audio è salvato sul Note Pro e poi trasferito all'app e al cloud di Plaud. Per gli account europei Plaud dichiara la conservazione su AWS a Francoforte.
2. **Trascrizione e riassunto**: li produce Plaud, anche con modelli di intelligenza artificiale di terzi.
3. **Scaricamento**: Seguito scarica trascrizione e riassunto tramite l'API ufficiale di Plaud, con le credenziali salvate in `~/.plaud`, e li salva sul computer dello studio in `data/`.
4. **Analisi**: Seguito invia il testo all'API di Anthropic. Nella demo, e con l'opzione `--fixture`, non viene inviato nulla.
5. **Proposta e approvazione**: restano in `data/`. I file generati (`.ics`, `.eml`) vanno in `outbox/` e le note nel gestionale. **Seguito non invia email** e non scrive su servizi esterni: lo fa l'avvocato, aprendo le bozze.

Le cartelle `data/` e `outbox/` sono create con permessi ristretti: cartelle `0700` e file `0600`, accessibili solo all'utente del computer che esegue Seguito.

### Accordi con i fornitori (DPA)

- **Plaud**: sottoscrivere o accettare l'accordo sul trattamento dei dati (DPA) ai sensi dell'art. 28 GDPR. Verificare l'area di conservazione dell'account, l'elenco dei sub-responsabili, in particolare i fornitori di intelligenza artificiale e la loro sede, e le garanzie per eventuali trasferimenti fuori dall'Unione europea. Plaud dichiara le certificazioni ISO 27001, ISO 27701 e SOC 2: conviene conservarne evidenza nella documentazione privacy.
- **Anthropic**: per l'uso tramite API valgono i termini commerciali, che includono un DPA. Verificare il DPA vigente, la sede del trattamento e le garanzie per il **trasferimento verso gli Stati Uniti** (per esempio le clausole contrattuali standard), la durata di conservazione dei dati inviati via API e l'esclusione del loro uso per l'addestramento dei modelli. Se si preferisce che l'analisi avvenga in Europa, si può valutare Claude tramite un fornitore cloud con region europea, per esempio AWS Bedrock. Richiede un estrattore dedicato (vedi [architettura.md](architettura.md)).

### Basi giuridiche

Indicazioni da verificare e riportare nel **registro dei trattamenti** (art. 30 GDPR), dove si consiglia di descrivere anche gli strumenti usati (Plaud, Seguito, Anthropic):

- dati comuni: esecuzione del mandato e misure precontrattuali (art. 6, par. 1, lett. b), obblighi di legge (lett. c), interesse legittimo a documentare con precisione le conversazioni professionali (lett. f, da bilanciare);
- categorie particolari di dati, come i dati sulla salute: art. 9, par. 2, lett. f, quando il trattamento è necessario per accertare, esercitare o difendere un diritto in sede giudiziaria;
- dati relativi a condanne penali e reati (art. 10 GDPR): nei limiti dell'art. 2-octies del Codice privacy (d.lgs. 196/2003), che consente il trattamento, tra l'altro, per far valere o difendere un diritto in sede giudiziaria.

### Informativa ai clienti

La legge 23 settembre 2025, n. 132, all'art. 13, chiede ai professionisti di comunicare al cliente, con linguaggio chiaro, semplice ed esaustivo, le informazioni sui sistemi di intelligenza artificiale utilizzati. Lo stesso articolo limita l'uso dell'intelligenza artificiale alle attività strumentali e di supporto, con prevalenza del lavoro intellettuale del professionista. Si raccomanda quindi di aggiornare l'informativa privacy e il mandato. Un paragrafo di esempio, da adattare (tra parentesi quadre i valori da decidere o da verificare). L'art. 13, par. 1, lett. f), GDPR chiede di indicare il Paese terzo e la garanzia su cui si basa il trasferimento: con l'API diretta di Anthropic, l'unico estrattore oggi disponibile, ogni conversazione analizzata è trasmessa negli Stati Uniti, quindi il trasferimento va dichiarato come certo, non come «eventuale».

> **Registrazione delle conversazioni e uso di strumenti di intelligenza artificiale.** Per documentare con precisione le indicazioni ricevute e gli impegni assunti, lo Studio può registrare, previo avviso, le telefonate e gli incontri con il Cliente. La registrazione è effettuata con un dispositivo Plaud; la trascrizione e un riassunto sono generati dal servizio Plaud mediante sistemi di intelligenza artificiale [se verificato nelle impostazioni dell'account e nei documenti contrattuali di Plaud: e conservati su server situati nell'Unione europea]. Il testo della trascrizione è elaborato con il servizio di intelligenza artificiale Claude, fornito da Anthropic PBC, con sede negli Stati Uniti, al solo fine di individuare appuntamenti, scadenze, documenti e attività da svolgere e di predisporre bozze di comunicazioni: il testo è quindi trasferito negli Stati Uniti sulla base di [decisione di adeguatezza della Commissione europea (EU-U.S. Data Privacy Framework), se il fornitore vi aderisce / clausole contrattuali standard approvate dalla Commissione europea]. Ogni risultato è verificato e approvato dall'Avvocato, che resta il solo responsabile della prestazione professionale; nessuna decisione è assunta in modo automatico. I fornitori operano come responsabili del trattamento in forza di accordi conclusi ai sensi dell'art. 28 del Regolamento (UE) 2016/679; [indicare gli eventuali ulteriori trasferimenti verso Paesi terzi da parte di Plaud o dei suoi sub-responsabili, con il Paese e la garanzia applicata ai sensi degli artt. 44 e seguenti del Regolamento]. Le registrazioni audio sono cancellate entro [30] giorni dalla trascrizione; le trascrizioni sono conservate nel fascicolo per la durata dell'incarico e, successivamente, per [10] anni. Il Cliente può chiedere in qualsiasi momento che le conversazioni non siano registrate, senza alcuna conseguenza sull'incarico, ed esercitare i diritti previsti dagli artt. da 15 a 22 del Regolamento. Le presenti informazioni sono rese anche ai sensi dell'art. 13 della legge 23 settembre 2025, n. 132.

### Conservazione

Seguito non cancella ancora i dati in modo automatico: la pulizia va fatta a mano, a cadenza fissa, per esempio una volta al mese. Tempi suggeriti, da adattare alla politica di conservazione dello studio:

| Dato | Dove si trova | Suggerimento |
|---|---|---|
| Audio originale | Note Pro, app e cloud Plaud | Cancellare dopo aver verificato trascrizione e proposta, per esempio entro 30 giorni, salvo esigenze probatorie motivate. |
| Trascrizione e riassunto in Plaud | Cloud Plaud | Cancellare insieme all'audio, una volta che la trascrizione è archiviata nello studio. |
| Registrazioni e proposte in Seguito | `data/recordings/`, `data/proposals/` | Conservare finché servono alla lavorazione, poi archiviare nel fascicolo e cancellare, per esempio dopo 90 giorni. |
| File generati | `outbox/` | Cancellare dopo l'importazione nel calendario o l'invio, per esempio dopo 30 giorni. |
| Trascrizione archiviata | Casella dello studio, fascicolo | Come il fascicolo: durata dell'incarico più il periodo previsto dalla politica dello studio, spesso dieci anni. |
| Primi contatti senza incarico | Tutte le posizioni sopra | Cancellare a breve, per esempio dopo 6 mesi, se l'incarico non viene conferito. |
| Conversazioni con colleghi registrate per errore | Tutte le posizioni sopra | Cancellare subito, senza utilizzarle. |

### Sicurezza del computer che esegue Seguito

- Cifratura del disco (FileVault su Mac, BitLocker su Windows), blocco automatico dello schermo e un account utente dedicato.
- Backup cifrati. Non sincronizzare `data/` e `outbox/` con servizi cloud personali senza averne valutato le garanzie.
- Proteggere `.env`, che contiene la chiave API di Anthropic, e la cartella `~/.plaud`, che contiene le credenziali Plaud.
- L'interfaccia ascolta solo sul computer stesso (`127.0.0.1`). Se la si rende raggiungibile da altri dispositivi, impostare `SEGUITO_PASSWORD` e usare una connessione cifrata (HTTPS, per esempio tramite un reverse proxy): con HTTP semplice la password viaggia in chiaro.
- In caso di perdita o furto del computer o del Note Pro, valutare subito se si tratta di una violazione da notificare al Garante entro 72 ore (art. 33 GDPR).

### Valutazione d'impatto (DPIA)

Si raccomanda di **valutare se serve una valutazione d'impatto** (art. 35 GDPR) e di documentare l'esito per iscritto, anche se si conclude che non è obbligatoria. Elementi da considerare:

- l'uso di **tecnologie innovative**, cioè sistemi di intelligenza artificiale, che figura tra i criteri dell'elenco del Garante (provvedimento n. 467 dell'11 ottobre 2018);
- la natura dei dati: possono esserci dati sulla salute e, nella pratica penale, dati giudiziari;
- la registrazione sistematica delle conversazioni e il coinvolgimento di terzi che non sono clienti;
- i trasferimenti di dati fuori dall'Unione europea attraverso i fornitori.

Il regolamento europeo sull'intelligenza artificiale (Reg. UE 2024/1689) chiede inoltre a chi usa questi sistemi di curare un livello sufficiente di alfabetizzazione del personale (art. 4). Per uno studio questo significa che chi usa Seguito deve sapere come funziona e quali errori può commettere.

## 4. Segreto professionale

L'avvocato deve mantenere il segreto e il massimo riserbo sull'attività prestata e sulle informazioni ricevute (art. 28 del Codice deontologico forense, art. 6 della legge 247/2012; la rivelazione senza giusta causa può integrare anche il reato previsto dall'art. 622 c.p.) e deve vigilare perché lo rispettino anche collaboratori e dipendenti. Affidare registrazioni e trascrizioni a fornitori esterni non è di per sé in contrasto con questi doveri, ma richiede attenzione. Raccomandazioni:

- scegliere fornitori con obblighi contrattuali di riservatezza e misure di sicurezza documentate (vedi i DPA sopra);
- **ridurre al minimo** ciò che si registra: si può interrompere la registrazione quando la conversazione tocca aspetti che non serve documentare;
- nella **pratica penale** valutare con particolare cautela se registrare. Le conversazioni con l'assistito possono contenere dichiarazioni delicate, che non devono uscire dal perimetro dello studio. In questi casi può essere preferibile non registrare, o non inviare la trascrizione alla casella dello studio;
- limitare l'accesso alle trascrizioni a chi lavora sulla pratica. L'invio della trascrizione alla casella dello studio è un'azione come le altre: si può non spuntarla.

## 5. Il principio dell'approvazione umana

Seguito propone, l'avvocato decide:

- **nessuna azione viene eseguita senza approvazione.** Anche dopo l'approvazione Seguito produce file e note: le email restano bozze da inviare a mano;
- ogni proposta indica il **minuto e la frase** da cui nasce, e le citazioni che non si ritrovano nella trascrizione vengono segnalate;
- i **termini processuali** sono sempre contrassegnati come «da verificare» sul fascicolo e sul codice: il calcolo automatico è un aiuto, non una certezza;
- l'**affidabilità** di ogni proposta è indicata. Le azioni incerte o con avvisi non sono preselezionate;
- la responsabilità professionale resta dell'avvocato, coerentemente con l'art. 13 della legge 132/2025: l'intelligenza artificiale è uno strumento di supporto, non sostituisce il lavoro intellettuale.

## Promemoria operativo

- [ ] DPA con Plaud accettato e area europea dell'account verificata.
- [ ] DPA con Anthropic verificato, comprese le garanzie per il trasferimento dei dati.
- [ ] Informativa privacy e mandato aggiornati: registrazione e intelligenza artificiale, legge 132/2025.
- [ ] Trattamento descritto nel registro dei trattamenti.
- [ ] Valutazione sulla necessità della DPIA documentata.
- [ ] Disco cifrato, backup cifrati, `.env` e `~/.plaud` protetti.
- [ ] Abitudine consolidata: niente registrazioni con i colleghi; consenso di tutti nelle riunioni.
- [ ] Pulizia periodica di audio, trascrizioni e file generati.
