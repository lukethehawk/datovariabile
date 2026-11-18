# DatoVariabile

Dato variabile su PDF, gratis e senza installazione: carichi uno o più **file grafici** (PDF, JPG o PNG), posizioni le **zone** (testi, contatori, codici a barre, QR) e importi un file **Excel, CSV o TXT**. Ottieni un PDF multipagina pronto per la stampa: ogni record occupa una pagina, oppure più pagine se la composizione ne prevede più di una (es. fronte e retro).

**Usalo online:** <https://lukethehawk.github.io/datovariabile/>

Tutto avviene nel browser: i file non vengono caricati su nessun server.

## Perché il PDF resta leggero

Ogni pagina grafica (nel gergo tipografico la *velina*, cioè la base ripetuta per ogni record) e ogni immagine viene inclusa **una sola volta** come oggetto riutilizzabile, richiamato da tutte le pagine del PDF che lo usano; ogni pagina aggiunge solo il proprio testo e i propri codici. Vale anche con più file (fronte e retro): non è una concatenazione di copie.

Le immagini non vengono ricompresse: i JPEG entrano nel PDF con i dati originali, i PNG senza perdita (la trasparenza è conservata). Il file cresce solo per il testo e i codici di ogni record:

| Esempio (misurato) | File grafici | PDF generato |
| --- | --- | --- |
| 1000 pagine con un testo variabile | 1 PDF, 375 KB | 619 KB (≈ 250 byte per pagina) |
| 1000 pagine con QR Code | 1 PDF, 375 KB | 1,1 MB (≈ 800 byte per pagina) |
| 1000 record fronte/retro (2000 pagine) | 2 PDF, 874 KB | 1,4 MB |
| 1000 pagine su foto JPEG A4 a 300 dpi | 1 JPEG, 749 KB | 1,0 MB |
| 1000 record PDF + JPEG + PNG trasparente (3000 pagine) | 3 file, 3,7 MB | 3,7 MB |

I font standard (Helvetica, Times, Courier) non vengono incorporati; un font TTF/OTF caricato viene incorporato una volta sola e ridotto ai soli caratteri usati. Testi e codici a barre sono vettoriali.

## Come si usa

1. **Grafica**: uno o più file grafici PDF, JPG o PNG, da ripetere per ogni record. Ogni file caricato aggiunge le sue pagine in fondo alla composizione, che gestisci nel pannello **Pagine per record** (colonna sinistra). Dei PDF vengono conservati TrimBox, BleedBox e rotazione.
2. **Dati** (facoltativo): `.xlsx`, `.xls`, `.ods`, `.csv`, `.txt`, dal pulsante **Dati** della barra o da **＋ Carica database** nella sezione **Dati variabili** (colonna destra). Il separatore (`;` `,` tab `|`) e la codifica (UTF-8 o Windows-1252 di Excel) sono riconosciuti in automatico. Un `.txt` senza separatori è letto come un valore per riga. I valori di Excel appaiono come formattati nel foglio; le date in formato breve diventano `gg/mm/aaaa`.
3. **Zone**: "＋ Testo" o "＋ Codice / QR", poi trascina e ridimensiona sulla pagina. Nel contenuto scrivi testo fisso e segnaposto:
   - `{Nome colonna}` → valore della colonna per quel record (clicca i nomi delle colonne per inserirli);
   - `{#}` → contatore, con inizio, passo e cifre (zeri iniziali) configurabili;
   - `{@Nome}` → valore di un generatore di dati (vedi [Generatori di dati](#generatori-di-dati-con-o-senza-excel)).

   Esempio: `Biglietto N. {#} - {Nome} {Cognome}`.
4. **Anteprima**: la pagina mostra il risultato reale del record scelto (frecce ◀ ▶ o clic su una riga della tabella dati). Con più pagine per record scegli la pagina da modificare nel pannello **Pagine per record** o nel menu sopra l'anteprima.
5. **Crea PDF** (pulsante in alto a destra). Le impostazioni sono nella sezione **Generazione PDF**: tutti i record oppure un intervallo (utile per le ristampe: il contatore resta quello del record originale) e il riepilogo delle pagine. Con un file dati il numero di record è quello delle righe (**Record disponibili**); senza dati lo imposti in **Record da generare** (predefinito 1; es. 500 per una numerazione 1–500).

### Pagine per record

La composizione si gestisce nel pannello **Pagine per record** (colonna sinistra). Ogni file caricato aggiunge le sue pagine in fondo, nello stesso ordine in cui appariranno nel PDF.

- Trascina una pagina (o usa ↑ ↓) per cambiarne la posizione.
- **⧉** duplica la pagina con le sue zone.
- La casella esclude la pagina dal PDF senza toglierla dalla composizione; **✕** la elimina.
- **＋ Aggiungi** riusa una pagina di un file già caricato, per esempio lo stesso retro per più fronti.
- Ogni pagina ha le sue zone; i dati e il contatore `{#}` sono gli stessi su tutte le pagine dello stesso record.

### Fronte/retro

Carica `fronte.pdf` e `retro.pdf` (oppure `fronte.jpg` e `retro.pdf`): con 100 righe di dati ottieni un PDF di 200 pagine, nell'ordine fronte 1, retro 1, fronte 2, retro 2, … Se serve, riordina le pagine nel pannello **Pagine per record**.

### Immagini JPG e PNG come grafica

Un JPG o PNG può fare da file grafico come un PDF. Per ogni pagina immagine scegli:

- **Formato pagina**: **Dimensione reale (DPI)** usa i DPI scritti nel file quando sono almeno 150, altrimenti A4; oppure A3, A4, A5 o **Personalizzato** in millimetri.

Se scegli un formato pagina fisso imposti anche:

- **Orientamento**: come l'immagine, verticale o orizzontale.
- **Adattamento**: **Intera, senza tagli** (predefinito), **Riempi** (taglia i bordi) o **Deforma**. Senza una scelta esplicita l'immagine non viene né tagliata né deformata.

Accanto alle impostazioni vedi la risoluzione di stampa effettiva, con un avviso sotto i 150 dpi. L'orientamento EXIF delle foto (quello scritto dalla fotocamera) viene rispettato.

### PDF da immagini

Senza dati e senza zone, con **Record da generare** impostato a 1 (predefinito), **Crea PDF** produce un PDF con le immagini, nell'ordine della composizione.

Trascinando i file sulla finestra: PDF/JPG/PNG = grafica, Excel/CSV/TXT = dati, TTF/OTF = font, `.dvp.zip`/`.json` = progetto.

**Salva progetto** crea un unico file `NomeProgetto.dvp.zip` (il nome del progetto aperto, altrimenti quello del primo file grafico) con: i file grafici originali (PDF, JPG o PNG, non modificati e ognuno una sola volta), il file dati originale (Excel, CSV o TXT), una copia dei dati usati, i font caricati, i generatori di dati (compresa la chiave dei codici univoci) e tutte le impostazioni, cioè pagine e loro ordine, impostazioni delle immagini, zone, contatori, intervallo di record e numero di record senza dati. Riaprendolo con **Apri progetto** ritrovi tutto com'era al salvataggio, compreso il foglio Excel scelto e l'indicazione delle intestazioni: non serve ricaricare i dati.

### Cosa c'è nel file .dvp.zip

È un normale file ZIP: si apre con Esplora risorse (doppio clic) o con qualsiasi programma ZIP. Dentro trovi:

- `progetto.json`: tutte le impostazioni, con i riferimenti agli altri file;
- `LEGGIMI.txt`: queste spiegazioni, in breve;
- `veline/`: i file grafici (PDF, JPG, PNG) così come li hai caricati (la cartella mantiene il nome tecnico per compatibilità con i progetti già salvati);
- `dati/`: il file dati originale (`dati/originale-...`) e i dati usati `dati/dati-usati.csv` (UTF-8, separatore `;`, prima riga = intestazioni se attive);
- `font/`: i font caricati.

Per recuperare i dati basta estrarre `dati/dati-usati.csv` (oppure il file originale `dati/originale-...`).

Attenzione: se apri il CSV con Excel, Excel può trasformare alcuni valori (per esempio `001234` diventa `1234`); dentro DatoVariabile il valore resta corretto. Se modifichi il CSV e ricrei lo ZIP, all'apertura DatoVariabile usa i dati modificati e te lo segnala.

**Privacy.** Il file contiene anche i dati importati (nomi, indirizzi, codici…): condividilo solo con chi è autorizzato a vederli. Tutto resta sul tuo PC, nessun file viene caricato online.

**Progetti delle versioni precedenti.** I file `.dvp.json` si aprono ancora con **Apri progetto**. Non contenevano i dati: se le zone usano colonne compare un avviso, quindi carica il file dati e salva di nuovo, ottenendo il nuovo `.dvp.zip`.

### Profili colore

Le immagini RGB con un profilo ICC lo conservano nel PDF. Per le immagini CMYK e in scala di grigi i valori vengono mantenuti così come sono e il profilo viene ignorato, con un avviso: così il nero 100% K resta K anche in stampa.

### Opzioni delle zone

- **Testo**: font, corpo, interlinea, allineamento orizzontale e verticale, a capo automatico, riduzione automatica del corpo se il testo non entra (altrimenti un avviso indica i record in cui il testo esce dalla zona).
- **Codici**: QR Code (con livello di correzione), DataMatrix, Aztec, PDF417, Code 128, GS1-128, EAN-13, EAN-8, UPC-A, Code 39, Interleaved 2 of 5, ITF-14; testo leggibile sotto i codici lineari.
- **Comuni**: colore CMYK (predefinito 100% K) o RGB, rotazione 0/90/180/270°, margine interno, **fondo bianco** ("bianco carta" sotto il codice su sfondi colorati).
- **Pagina**: sposta la zona su un'altra pagina del record, oppure **Copia su…** per crearne una copia nella stessa posizione su un'altra pagina.
- Frecce della tastiera: sposta di 0,5 mm (Maiusc: 5 mm); Canc: elimina la zona.

Se un valore non è stampabile (carattere assente nel font standard, EAN con lettere…) la generazione si ferma indicando record e zona: per alfabeti non latini carica un font TTF/OTF che li contenga (sezione **Risorse** della colonna destra, **＋ Carica font**).

### Generatori di dati (con o senza Excel)

Numeri progressivi, codici univoci e date si creano nella sezione **Dati variabili › Generatori** della colonna destra, con o senza un file di dati: scegli **＋ Nuovo generatore** e poi **Numerazione**, **Codice univoco** o **Data/Ora**. Ogni generatore mostra tipo, primi valori e numero di zone che lo usano; clicca la riga per le impostazioni. Dagli un nome (per esempio `Matricola`): nell'editor della zona compare un pulsante verde `@Matricola` che inserisce il segnaposto `{@Matricola}` (puoi anche scriverlo a mano).

- Un generatore produce **un solo valore per record**, identico in tutte le zone che lo usano — testo, QR, codice a barre, fronte e retro.
- Funzionano con o senza file dati; con i dati il numero di record è quello del file, senza dati lo imposti tu.
- `{#}` resta il contatore della singola zona, come prima: è indipendente dai generatori.

**Numerazione.** Tre tipi, con prefisso e suffisso comuni:

- **Numerica**: inizio, passo e cifre con zeri iniziali. Con prefisso `FT-` e 6 cifre ottieni `FT-000001`, `FT-000002`…
- **Alfabetica**: `A, B … Z, AA, AB…`; scegli la prima lettera e il passo. Dopo l'ultima lettera puoi far aggiungere una lettera (`Z` → `AA`) oppure fermarti con un errore. L'alfabeto è modificabile.
- **Lettere + numero**: `A001 … A999, B001…`; imposti lettera iniziale, numero iniziale, numero da/a e cifre. Con prefisso `PROD-`, numero da 1 a 9999 e 4 cifre ottieni `PROD-A0001`, `PROD-A0002`…

**Codice univoco.** Scegli i caratteri tra lettere e numeri senza ambigui (`0`/`O`, `1`/`I`/`L`), lettere e numeri, solo numeri, solo lettere, solo lettere senza ambigui; imposti la lunghezza e, se vuoi, prefisso e suffisso (es. `GIFT-2026-` più 6 caratteri).

- I codici non si ripetono nella stessa serie.
- Restano gli stessi in anteprima, nel PDF, dopo salvataggio e riapertura e nelle ristampe parziali: il record 100 ha sempre lo stesso codice. Aggiungere record in fondo non cambia i codici già assegnati.
- Si può usare al massimo metà delle combinazioni possibili: se i record sono troppi, l'app chiede di aumentare la lunghezza. Il pannello mostra quante combinazioni esistono e quanto è facile indovinare un codice a caso.
- Cambiare caratteri o lunghezza cambia tutti i codici: se il generatore è già usato nelle zone, viene chiesta conferma. **Nuova serie** crea codici completamente nuovi.
- Non c'è garanzia di unicità tra generatori o progetti diversi.
- Il file di progetto contiene la chiave da cui si ricavano i codici: trattalo come riservato, perché chi ha il progetto può ricostruire tutti i codici.

**Data/Ora.** Formati: `18/11/2026`, `18-11-2026`, `18/11/26`, `18/11/2026 14:35`, `14:35`, `2026-11-18`, `2026-11-18 14:35`. Puoi usare la data **del momento in cui si crea il PDF**: viene presa una volta all'avvio della creazione e resta uguale su tutte le pagine; in anteprima vedi un'ora di esempio (aggiornabile con **Aggiorna ora di esempio**), quindi una ristampa successiva avrà la nuova data. Oppure scegli **fissata nel progetto**: resta uguale anche dopo salvataggio e riapertura. Il fuso orario predefinito è `Europe/Rome`.

Qualche esempio:

- 1000 etichette con matricola `FT-000001`: Numerazione con prefisso `FT-` e 6 cifre, inserita come `{@Matricola}`.
- 5000 ticket: Codice univoco sul fronte e lo stesso `{@Codice}` dentro un QR sul retro.
- 500 etichette "Prodotto il …": Data/Ora del momento di creazione nel testo `Prodotto il {@Data}`.

## Uso offline

La build produce un unico file `index.html` che funziona anche aperto con doppio clic, senza internet: dalla pagina online usa "Salva pagina con nome" (pagina web, solo HTML), oppure esegui la build in locale.

## Sviluppo

Richiede Node.js 24.

```sh
npm ci
npm run dev      # server di sviluppo
npm test         # test (generazione PDF, più file grafici, immagini JPEG/PNG, progetti, lettura dati)
npm run build    # dist/index.html, file unico
```

A ogni push su `main` GitHub Actions esegue test e build e pubblica su GitHub Pages.

Struttura:

- `src/core/`: logica senza interfaccia: generazione PDF con pdf-lib (`generate.ts`), composizione delle pagine (`composition.ts`), immagini JPEG/PNG senza perdita (`raster.ts`), salvataggio e apertura del progetto `.dvp.zip` (`archive.ts`, `zip.ts`, `data.ts`) e conversione dei vecchi progetti (`project.ts`), lettura dati, segnaposto, impaginazione testo, codici a barre vettoriali;
- `src/ui/`: interfaccia (anteprima con pdf.js, pannello delle pagine, editor delle zone, pannelli);
- `src/worker.ts`: la generazione gira in un Web Worker, l'interfaccia resta reattiva e si può annullare; lo stesso worker prepara l'anteprima delle pagine immagine.

SheetJS è incluso in `vendor/` perché la versione aggiornata non è pubblicata sul registro npm.

Per chi sviluppa (anche agenti AI): [AGENTS.md](AGENTS.md) contiene la memoria di progetto (architettura, invarianti, convenzioni), [DIARIO_SVILUPPO.md](DIARIO_SVILUPPO.md) la cronologia delle decisioni.

## Limiti attuali

- Il progetto (`.dvp.zip`) si può salvare e aprire fino a 512 MB (file grafici, dati e font compresi) e con al massimo 5 milioni di celle di dati: oltre, il salvataggio si ferma con un messaggio invece di creare un file che non si riaprirebbe.
- Nessun modulo di imposizione (più pose per foglio): ogni record occupa una pagina o più, quante sono le pagine della composizione.
- I PDF usati come grafica non devono essere protetti da password.
- JPEG: solo 8 bit standard o progressivi (non 12 bit, lossless o aritmetici).
- I PNG molto grandi con trasparenza o interlacciati (oltre ~400 MB di pixel non compressi) non sono elaborabili nel browser.
- Un generatore con lo stesso nome di una colonna dei dati che inizia con `@` (per esempio generatore `Codice` e colonna `@Codice`) blocca la generazione finché non rinomini il generatore.
- I progetti salvati con i generatori richiedono questa versione dell'app.
- L'anteprima non applica i profili colore ICC; il PDF finale sì.
- Immagini animate: viene usato solo il primo fotogramma.
- Nessuna conversione o ottimizzazione automatica delle immagini: vengono inserite come sono.
- I QR Code richiedono circa 4 ms l'uno: 10.000 codici ≈ 40 secondi.
