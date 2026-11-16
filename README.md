# DatoVariabile

Dato variabile su PDF, gratis e senza installazione: carichi una o più **veline** (file PDF, JPG o PNG), posizioni le **zone** (testi, contatori, codici a barre, QR) e importi un file **Excel, CSV o TXT**. Ottieni un PDF multipagina pronto per la stampa: ogni record occupa una pagina, oppure più pagine se la composizione ne prevede più di una (es. fronte e retro).

**Usalo online:** <https://lukethehawk.github.io/datovariabile/>

Tutto avviene nel browser: i file non vengono caricati su nessun server.

## Perché il PDF resta leggero

Ogni pagina di velina e ogni immagine viene inclusa **una sola volta** come oggetto riutilizzabile, richiamato da tutte le pagine del PDF che lo usano; ogni pagina aggiunge solo il proprio testo e i propri codici. Vale anche con più file (fronte e retro): non è una concatenazione di copie.

Le immagini non vengono ricompresse: i JPEG entrano nel PDF con i dati originali, i PNG senza perdita (la trasparenza è conservata). Il file cresce solo per il testo e i codici di ogni record:

| Esempio (misurato) | Dimensione |
| --- | --- |
| Velina | 375 KB |
| 1000 pagine con un testo variabile | 619 KB (≈ 250 byte per pagina) |
| 1000 pagine con QR Code | 1,1 MB (≈ 800 byte per pagina) |

I font standard (Helvetica, Times, Courier) non vengono incorporati; un font TTF/OTF caricato viene incorporato una volta sola e ridotto ai soli caratteri usati. Testi e codici a barre sono vettoriali.

## Come si usa

1. **Velina**: uno o più file PDF, JPG o PNG da ripetere per ogni record. Ogni file caricato aggiunge le sue pagine in fondo alla composizione, che gestisci nel pannello **Pagine per record** (colonna sinistra). Dei PDF vengono conservati TrimBox, BleedBox e rotazione.
2. **Dati** (facoltativo): `.xlsx`, `.xls`, `.ods`, `.csv`, `.txt`. Il separatore (`;` `,` tab `|`) e la codifica (UTF-8 o Windows-1252 di Excel) sono riconosciuti in automatico. Un `.txt` senza separatori è letto come un valore per riga. I valori di Excel appaiono come formattati nel foglio; le date in formato breve diventano `gg/mm/aaaa`.
3. **Zone**: "＋ Testo" o "＋ Codice / QR", poi trascina e ridimensiona sulla pagina. Nel contenuto scrivi testo fisso e segnaposto:
   - `{Nome colonna}` → valore della colonna per quel record (clicca i nomi delle colonne per inserirli);
   - `{#}` → contatore, con inizio, passo e cifre (zeri iniziali) configurabili.

   Esempio: `Biglietto N. {#} - {Nome} {Cognome}`.
4. **Anteprima**: la pagina mostra il risultato reale del record scelto (frecce ◀ ▶ o clic su una riga della tabella dati).
5. **Crea PDF**: tutti i record oppure un intervallo (utile per le ristampe: il contatore resta quello del record originale). Senza file dati imposti quanti record generare (es. numerazione 1–500).

### Pagine per record

La composizione si gestisce nel pannello **Pagine per record** (colonna sinistra). Ogni file caricato aggiunge le sue pagine in fondo, nello stesso ordine in cui appariranno nel PDF.

- Trascina una pagina (o usa ↑ ↓) per cambiarne la posizione.
- **⧉** duplica la pagina con le sue zone.
- La casella esclude la pagina dal PDF senza toglierla dalla composizione; **✕** la elimina.
- **＋ Aggiungi** riusa una pagina di un file già caricato, per esempio lo stesso retro per più fronti.
- Ogni pagina ha le sue zone; i dati e il contatore `{#}` sono gli stessi su tutte le pagine dello stesso record.

### Fronte/retro

Carica `fronte.pdf` e `retro.pdf` (oppure `fronte.jpg` e `retro.pdf`): con 100 righe di dati ottieni un PDF di 200 pagine, nell'ordine fronte 1, retro 1, fronte 2, retro 2, … Se serve, riordina le pagine nel pannello **Pagine per record**.

### Immagini JPG e PNG come velina

Un JPG o PNG può essere una velina come un PDF. Per ogni pagina immagine scegli:

- **Formato pagina**: **Dimensione reale (DPI)** usa i DPI scritti nel file quando sono almeno 150, altrimenti A4; oppure A3, A4, A5 o **Personalizzato** in millimetri.

Se scegli un formato pagina fisso imposti anche:

- **Orientamento**: come l'immagine, verticale o orizzontale.
- **Adattamento**: **Intera, senza tagli** (predefinito), **Riempi** (taglia i bordi) o **Deforma**. Senza una scelta esplicita l'immagine non viene né tagliata né deformata.

Accanto alle impostazioni vedi la risoluzione di stampa effettiva, con un avviso sotto i 150 dpi. L'orientamento EXIF delle foto (quello scritto dalla fotocamera) viene rispettato.

### PDF da immagini

Senza dati e senza zone, con **Record da generare** impostato a 1 (predefinito), **Crea PDF** produce un PDF con le immagini, nell'ordine della composizione.

Trascinando i file sulla finestra: PDF/JPG/PNG = velina, Excel/CSV/TXT = dati, TTF/OTF = font, `.json` = progetto.

**Salva progetto** crea un file `.dvp.json` con zone, tutti i file velina, l'ordine delle pagine, le impostazioni delle immagini e i font: la prossima volta lo riapri e carichi solo i nuovi dati. I progetti salvati con la versione precedente si aprono ancora: vengono convertiti in automatico.

### Profili colore

Le immagini RGB con un profilo ICC lo conservano nel PDF. Per le immagini CMYK e in scala di grigi i valori vengono mantenuti così come sono e il profilo viene ignorato, con un avviso: così il nero 100% K resta K anche in stampa.

### Opzioni delle zone

- **Testo**: font, corpo, interlinea, allineamento orizzontale e verticale, a capo automatico, riduzione automatica del corpo se il testo non entra (altrimenti un avviso indica i record in cui il testo esce dalla zona).
- **Codici**: QR Code (con livello di correzione), DataMatrix, Aztec, PDF417, Code 128, GS1-128, EAN-13, EAN-8, UPC-A, Code 39, Interleaved 2 of 5, ITF-14; testo leggibile sotto i codici lineari.
- **Comuni**: colore CMYK (predefinito 100% K) o RGB, rotazione 0/90/180/270°, margine interno, **fondo bianco** ("bianco carta" sotto il codice su sfondi colorati).
- Frecce della tastiera: sposta di 0,5 mm (Maiusc: 5 mm); Canc: elimina la zona.

Se un valore non è stampabile (carattere assente nel font standard, EAN con lettere…) la generazione si ferma indicando record e zona: per alfabeti non latini carica un font TTF/OTF che li contenga.

## Uso offline

La build produce un unico file `index.html` che funziona anche aperto con doppio clic, senza internet: dalla pagina online usa "Salva pagina con nome" (pagina web, solo HTML), oppure esegui la build in locale.

## Sviluppo

Richiede Node.js 24.

```sh
npm ci
npm run dev      # server di sviluppo
npm test         # test (generazione PDF, lettura dati)
npm run build    # dist/index.html, file unico
```

A ogni push su `main` GitHub Actions esegue test e build e pubblica su GitHub Pages.

Struttura:

- `src/core/`: logica senza interfaccia (lettura dati, segnaposto, impaginazione testo, codici a barre vettoriali, generazione PDF con pdf-lib);
- `src/ui/`: interfaccia (anteprima con pdf.js, editor delle zone, pannelli);
- `src/worker.ts`: la generazione gira in un Web Worker, l'interfaccia resta reattiva e si può annullare.

SheetJS è incluso in `vendor/` perché la versione aggiornata non è pubblicata sul registro npm.

Per chi sviluppa (anche agenti AI): [AGENTS.md](AGENTS.md) contiene la memoria di progetto (architettura, invarianti, convenzioni), [DIARIO_SVILUPPO.md](DIARIO_SVILUPPO.md) la cronologia delle decisioni.

## Limiti attuali

- Nessun modulo di imposizione (più pose per foglio): ogni record occupa una pagina o più, quante sono le pagine della composizione.
- I PDF velina non devono essere protetti da password.
- JPEG: solo 8 bit standard o progressivi (non 12 bit, lossless o aritmetici).
- I PNG molto grandi con trasparenza o interlacciati (oltre ~400 MB di pixel non compressi) non sono elaborabili nel browser.
- L'anteprima non applica i profili colore ICC; il PDF finale sì.
- Immagini animate: viene usato solo il primo fotogramma.
- Nessuna conversione o ottimizzazione automatica delle immagini: vengono inserite come sono.
- I QR Code richiedono circa 4 ms l'uno: 10.000 codici ≈ 40 secondi.
