# Memoria di progetto: DatoVariabile

Leggi questo file prima di modificare il repo. Contiene fatti stabili, invarianti e convenzioni.
La cronologia delle decisioni e il loro perché sono in [DIARIO_SVILUPPO.md](DIARIO_SVILUPPO.md): aggiungi lì una voce a ogni sessione di lavoro.

## Scopo

Alternativa gratuita a ProXDATA (Tecnotronica) per il **dato variabile su PDF**:
velina PDF + zone (testo, contatore, codici a barre/QR) + dati Excel/CSV/TXT → PDF multipagina, un record per pagina (o N pagine per record se la velina ha più pagine).
Requisito chiave dell'utente: **il PDF finale deve pesare poco più della velina**, non essere una concatenazione di copie.

Utente: tipografia/stampa digitale, uso occasionale, italiano. Interfaccia, messaggi di errore, README e commit in **italiano**.

- Online: https://lukethehawk.github.io/datovariabile/ (GitHub Pages, deploy automatico da `main`)
- Repo: https://github.com/lukethehawk/datovariabile (pubblico)

## Stack

| Componente | Versione | Ruolo |
| --- | --- | --- |
| Vite | 8 | build; `vite-plugin-singlefile` produce **un solo** `dist/index.html` |
| TypeScript | 7 (tsgo) | `tsc -p .` solo type-check (`noEmit`) |
| Vitest | 5 | test in `tests/**/*.test.ts` (config in `vite.config.ts`) |
| pdf-lib | 1.17.1 | generazione PDF |
| @pdf-lib/fontkit | 1.1 | font TTF/OTF |
| pdfjs-dist | 6.5 | rendering anteprima (browser) e lettura testo nei test |
| bwip-js | 4.11 | codici a barre (via DrawingContext personalizzato) |
| xlsx (SheetJS) | 0.20.3 | **vendorizzato** in `vendor/xlsx-0.20.3.tgz` |

Node 24. Comandi: `npm ci`, `npm run dev`, `npm test`, `npm run build` (= `tsc -p . && vite build`).

## Mappa del codice

```
src/core/            logica pura, nessun DOM (gira anche nel worker e in Node)
  types.ts           Field (TextField | BarcodeField), TemplatePage, DataSet, ColorSpec
  generate.ts        generate(job), inspectTemplate(), embedTemplatePages(), rotationMatrix(), drawField()
  barcode.ts         SYMBOLOGIES, BarcodeRenderer.place(), drawing context bwip-js → operatori PDF
  text.ts            layoutText(): a capo, riduzione corpo (ricerca binaria), allineamenti
  placeholders.ts    compileContent(): {Colonna} e {#}; formatCounter()
  data.ts            readTable() (xlsx/csv/txt), toDataSet(), detectDelimiter(), parseDelimited(), decodeText()
  fonts.ts           STANDARD_FONTS, FontCache (embed una volta per documento)
src/ui/              interfaccia DOM vanilla
  state.ts           store globale `state` + pub/sub per topic, createField(), parsePages(), recordRange()
  actions.ts         apertura file (pdf/dati/font/progetto), openPdf() pdf.js, salva/apri progetto
  viewer.ts          canvas velina + canvas overlay + riquadri zone (drag/resize/tastiera), zoom
  props.ts           elenco zone e pannello proprietà
  data-panel.ts      tabella dati, foglio, intestazioni, conteggio manuale
  output.ts          intervallo, font aggiuntivi, generazione nel worker, download
  dom.ts             h() builder, toast, download, formatBytes
src/worker.ts        Web Worker: riceve Job, chiama generate(), invia progress/done/error
src/main.ts          bootstrap, drag&drop file, stato toolbar
tests/               generate.test.ts, data.test.ts, helpers.ts (makeTemplate, textField, barcodeField)
.github/workflows/pages.yml   test + build + deploy Pages
```

## Invarianti (non romperle)

1. **Velina una sola volta.** Ogni pagina della velina diventa un Form XObject creato da `embedTemplatePages()` e referenziato da tutte le pagine (`drawObject`). **Non usare `doc.embedPages()`/`embedPdf()` di pdf-lib**: copia anche lo stream contenuti originale come oggetto orfano e raddoppia la dimensione della velina. Se lo stream è unico viene riusato byte per byte (con `Filter`/`DecodeParms`); più stream vengono decodificati, uniti con `\n` e ricompressi.
   Test di guardia: `references the template once…` in `tests/generate.test.ts`.
2. **Coordinate zone in "view space"**: punti PDF (1/72"), origine **in alto a sinistra** della pagina *come visualizzata* (dopo `/Rotate`), y verso il basso. `view` = CropBox ∩ MediaBox (quello che mostrano pdf.js e Acrobat). Conversione verso lo spazio utente PDF: una sola matrice per pagina `rotationMatrix(rotate, w, h, ox, oy)`; la stessa funzione ruota il contenuto dentro la zona (`field.rotation`, antioraria). Non introdurre altre convenzioni.
   Test di guardia: `places fields where they were drawn on a page rotated %i°` (0/90/180/270).
3. **Anteprima = motore reale.** L'overlay dell'editor è `generate({ template: null, … })` su un solo record e una sola pagina (pagina `[0,0,viewW,viewH]`, nessuna rotazione), renderizzato da pdf.js sopra il canvas della velina. Nessun secondo renderer "approssimato" in CSS.
4. **Contatore sull'indice assoluto del record**: `{#}` = `start + recordIndex * step`; generare l'intervallo 50–60 dà gli stessi numeri della tiratura completa.
5. **Errori parlanti**: gli errori di generazione sono `Record N, zona "Nome": …` o `Zona "Nome": …` (segnaposto). Non sopprimere caratteri non codificabili: si ferma e l'utente carica un TTF.
6. **Nessun upload**: tutto locale nel browser. Non aggiungere backend o servizi esterni.
7. **Build single-file**: deve funzionare aprendo `dist/index.html` da `file://`. Worker generazione importato con `?worker&inline`; worker pdf.js con `?url` (inlinato come data URL). Verificalo dopo ogni cambio di dipendenze/bundling.

## Dettagli tecnici da sapere

- **Font**: i 12 standard (Helvetica/Times/Courier ×4) non vengono incorporati (0 byte, codifica WinAnsi: accenti italiani ok, polacco/greco no). TTF caricati: `subset: true`. OTF con outline CFF (magic `OTTO`): incorporati interi perché il subsetter fontkit li corrompe.
- **Codici a barre** (`barcode.ts`):
  - `bwip-js.render(opts, drawingContext)` con un DrawingContext che emette operatori PDF (stessa geometria di `DrawingSVG` di bwip-js: arrotondamenti, mezzo pixel per larghezze dispari, `y0++`). Barre = linee con `stroke`, raggruppate per spessore; moduli 2D = poligoni con `f*` (even-odd).
  - Testo leggibile (HRI): **non** contorni glifi (pesavano ~2 KB/pagina) ma etichette disegnate con Helvetica standard: corpo = altezza cella OCR-B × `0.95`, `measure()` usa le metriche Helvetica, `dx` gestito carattere per carattere.
  - 2D (`twoD: true`): proporzioni mantenute, centrato nella zona.
  - Lineari: si calibra per job `altezza_px = intercept + slope × altezza_mm` (render a 10 e 30 mm), poi per ogni record si renderizza una volta per la larghezza e una con l'altezza barre che dà le proporzioni della zona: lo stretch finale è quasi uniforme e il testo non si deforma. Costo: 2 render per record.
  - Prestazioni misurate: QR ~4 ms/codice, Code128 ~3 ms/record (il costo è BWIPP, non pdf-lib).
- **Testo** (`text.ts`): ascent = `heightAtSize(size, {descender:false})`, descent = differenza con `heightAtSize(size)`; `shrink` = ricerca binaria tra 2 pt e il corpo impostato; overflow → avviso (max 50 per job).
- **Dati** (`data.ts`): UTF-8 `fatal`, altrimenti Windows-1252; BOM rimosso; separatore scelto tra tab `;` `,` `|` con il conteggio più costante nelle prime 30 righe; nessun separatore → una colonna per riga (`headerGuess=false`). Excel: `raw:false` (testo come visualizzato) e `dateNF:'dd/mm/yyyy'` (sostituisce il formato data breve che SheetJS renderebbe `m/d/yy`). Intestazioni vuote → lettera colonna, duplicate → `_2`.
- **pdf.js 6**: `page.render({ canvas, viewport })`; `destroy()` sta sul **loading task**, non su `PDFDocumentProxy` (`openPdf()` restituisce `{ pdf, close }`). Per l'overlay trasparente passare `canvasContext` proprio (`canvas: null`): con `canvas` pdf.js crea un contesto `alpha:false` e il trasparente diventa **nero**. Font standard in anteprima: fallback di sistema (Arial), `standardFontDataUrl` non incluso nel bundle.
- **bwip-js e TypeScript**: l'export map non ha condizione di default per i tipi → `"customConditions": ["browser"]` in `tsconfig.json`. In Node/Vitest viene risolta la build `node`, stessa API.
- **SheetJS**: npm 12 rifiuta le dipendenze da URL remoti ("Fetching packages of type remote have been disabled"), quindi tarball in `vendor/` e `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`. Per aggiornare: scaricare il nuovo tgz da cdn.sheetjs.com, sostituirlo, `npm i file:vendor/…`.
- **Store UI** (`state.ts`): `notify(...topics)` chiama ogni listener una volta. Topic: `template`, `data`, `fields`, `geometry` (durante il drag: solo sincronizzazione input del pannello, nessun re-render overlay), `selection`, `view`, `fonts`, `output`. Il pannello proprietà si ricostruisce su `selection`/`fonts`/`data`/`template` e su `fields` aggiorna solo gli input non a fuoco (`syncers`), così non perde il focus mentre si scrive.
- **Formato progetto** `.dvp.json`: `{ app:'DatoVariabile', version:1, fields, fonts:[{name,data(base64)}], template:{name,data(base64)}|null, manualCount, pagesSpec }`. I dati NON vengono salvati (cambiano a ogni lavoro). Se cambi `Field`, mantieni la lettura dei progetti `version:1` o incrementa la versione con migrazione.
- **Record count**: con dati = righe; senza dati = `state.manualCount` (lavori di sola numerazione).

## Convenzioni

- Logica nuova che non tocca il DOM va in `src/core/` ed è testabile in Node.
- Niente framework UI: DOM vanilla con `h()`. Niente nuove dipendenze se basta poco codice.
- Unità interne in punti; l'interfaccia mostra millimetri (`MM = 72/25.4`).
- Colore predefinito CMYK 0/0/0/100 (nero di stampa); fondo bianco in CMYK 0/0/0/0 se la zona è CMYK.
- Test solo per comportamenti visibili all'utente (dimensione output, posizioni, parsing, errori). Fixture generate in codice (`tests/helpers.ts`), nessun file binario di test.
- Commit e testi in italiano. Identità git locale del repo: `lukethehawk <98876950+lukethehawk@users.noreply.github.com>`.

## Verifica prima di consegnare

1. `npm run build` (type-check + build) e `npm test`.
2. Per modifiche all'interfaccia: aprire `dist/index.html` da `file://` in Chromium, caricare una velina e un Excel, aggiungere zone, generare e controllare il PDF (trucco: ricaricare il PDF generato come velina nell'app e sfogliarne le pagine).
3. Dopo il push controllare il workflow Pages (`gh run list`, `gh run watch`).

## Backlog noto

- Modulo di imposizione (N pose per foglio, crocini di taglio): non presente.
- Velina da immagine JPG/PNG: non presente.
- QR più veloci: encoder dedicato (es. `qrcode-generator`) per `qrcode`, bwip-js per il resto.
- Annulla/ripeti nell'editor: non presente.
- Workflow: le action `checkout`/`setup-node`/`upload-pages-artifact`/`deploy-pages` v4 danno avviso di deprecazione Node 20 (funzionano).
