# DatoVariabile

Dato variabile su PDF, gratis e senza installazione: carichi un **PDF velina**, posizioni le **zone** (testi, contatori, codici a barre, QR) e importi un file **Excel, CSV o TXT**. Ottieni un PDF multipagina pronto per la stampa, un record per pagina.

**Usalo online:** <https://lukethehawk.github.io/datovariabile/>

Tutto avviene nel browser: i file non vengono caricati su nessun server.

## Perché il PDF resta leggero

La velina viene inclusa **una sola volta** come oggetto riutilizzabile (Form XObject) e ogni pagina la richiama, aggiungendo solo il proprio testo e i propri codici. Non è una concatenazione di copie della velina:

| Esempio (misurato) | Dimensione |
| --- | --- |
| Velina | 375 KB |
| 1000 pagine con un testo variabile | 619 KB (≈ 250 byte per pagina) |
| 1000 pagine con QR Code | 1,1 MB (≈ 800 byte per pagina) |

I font standard (Helvetica, Times, Courier) non vengono incorporati; un font TTF/OTF caricato viene incorporato una volta sola e ridotto ai soli caratteri usati. Testi e codici a barre sono vettoriali.

## Come si usa

1. **Velina PDF**: il file grafico da ripetere. Se ha più pagine (es. fronte/retro) ogni record le ripete tutte, oppure scegli quali in "Pagine della velina per record". TrimBox, BleedBox e rotazione vengono conservati.
2. **Dati** (facoltativo): `.xlsx`, `.xls`, `.ods`, `.csv`, `.txt`. Il separatore (`;` `,` tab `|`) e la codifica (UTF-8 o Windows-1252 di Excel) sono riconosciuti in automatico. Un `.txt` senza separatori è letto come un valore per riga. I valori di Excel appaiono come formattati nel foglio; le date in formato breve diventano `gg/mm/aaaa`.
3. **Zone**: "＋ Testo" o "＋ Codice / QR", poi trascina e ridimensiona sulla pagina. Nel contenuto scrivi testo fisso e segnaposto:
   - `{Nome colonna}` → valore della colonna per quel record (clicca i nomi delle colonne per inserirli);
   - `{#}` → contatore, con inizio, passo e cifre (zeri iniziali) configurabili.

   Esempio: `Biglietto N. {#} - {Nome} {Cognome}`.
4. **Anteprima**: la pagina mostra il risultato reale del record scelto (frecce ◀ ▶ o clic su una riga della tabella dati).
5. **Crea PDF**: tutti i record oppure un intervallo (utile per le ristampe: il contatore resta quello del record originale). Senza file dati imposti quanti record generare (es. numerazione 1–500).

Trascinando i file sulla finestra: PDF = velina, Excel/CSV/TXT = dati, TTF/OTF = font, `.json` = progetto.

**Salva progetto** crea un file `.dvp.json` con zone, velina e font: la prossima volta lo riapri e carichi solo i nuovi dati.

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

## Limiti attuali

- Nessun modulo di imposizione (più pose per foglio): il PDF ha un record per pagina.
- La velina deve essere un PDF (non immagini JPG/PNG) e non protetto da password.
- I QR Code richiedono circa 4 ms l'uno: 10.000 codici ≈ 40 secondi.
