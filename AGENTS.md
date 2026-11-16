# Memoria di progetto: DatoVariabile

Leggi questo file prima di modificare il repo. Contiene fatti stabili, invarianti e convenzioni.
La cronologia delle decisioni e il loro perché sono in [DIARIO_SVILUPPO.md](DIARIO_SVILUPPO.md): aggiungi lì una voce a ogni sessione di lavoro.

## Scopo

Alternativa gratuita a ProXDATA (Tecnotronica) per il **dato variabile su PDF**:
una o più veline (PDF, JPG, PNG) + zone (testo, contatore, codici a barre/QR) + dati Excel/CSV/TXT → PDF multipagina.
Le pagine di ogni record sono una **composizione** ordinata di pagine prese dai file caricati (es. fronte.pdf + retro.jpg → F1 R1 F2 R2 …), ripetuta per ogni record.
Requisito chiave dell'utente: **il PDF finale deve pesare poco più della somma delle veline**, non essere una concatenazione di copie. Le immagini non devono perdere qualità (nessuna ricompressione con perdita).

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
  types.ts           Field (TextField | BarcodeField, legata a uno slot), TemplatePage, Slot, RasterLayout, SourceFile, Matrix
  generate.ts        generate(job), inspectTemplate(), embedBackgrounds(), embedTemplatePages(), rotationMatrix(), drawField()
  raster.ts          JPEG/PNG: inspectRaster(), embedRaster() senza perdita, rasterPage() (formato pagina + matrice immagine), defaultLayout()
  composition.ts     inspectSource(), slotsFor() (slot per un file nuovo), jobPage() (slot → JobPage), sourceKind(), newId()
  project.ts         serializeProject()/parseProject() formato v2, migrazione v1, parsePages() (solo per v1)
  barcode.ts         SYMBOLOGIES, BarcodeRenderer.place(), drawing context bwip-js → operatori PDF
  text.ts            layoutText(): a capo, riduzione corpo (ricerca binaria), allineamenti
  placeholders.ts    compileContent(): {Colonna} e {#}; formatCounter()
  data.ts            readTable() (xlsx/csv/txt), toDataSet(), detectDelimiter(), parseDelimited(), decodeText()
  fonts.ts           STANDARD_FONTS, FontCache (embed una volta per documento)
src/ui/              interfaccia DOM vanilla
  state.ts           store globale `state` (sources, slots, slotId…) + pub/sub per topic, slotPage(), createField(), recordRange()
  actions.ts         addSource()/removeSource() (dedup per byte), dati, font, openPdf() pdf.js, salva/apri progetto
  pages-panel.ts     pannello "Pagine per record": slot con miniature, riordino (trascina/↑↓), duplica, escludi, elimina, aggiungi pagina, impostazioni pagina immagine
  backgrounds.ts     slotPdfPage(): sfondo di uno slot come pagina pdf.js (immagini: PDF di 1 pagina fatto da generate(), cache per layout)
  viewer.ts          canvas velina + canvas overlay + riquadri zone (drag/resize/tastiera), zoom
  props.ts           elenco zone e pannello proprietà
  data-panel.ts      tabella dati, foglio, intestazioni, conteggio manuale
  output.ts          intervallo, font aggiuntivi, generazione nel worker, download
  dom.ts             h() builder, toast, download, formatBytes
src/worker.ts        Web Worker: riceve Job, chiama generate(), invia progress/done/error
src/main.ts          bootstrap, drag&drop file, stato toolbar
tests/               generate.test.ts (anche multi-PDF), raster.test.ts, project.test.ts, data.test.ts,
                     helpers.ts (makePdf, pdfJob, textField, barcodeField), images.ts (flatJpeg, encodePng, decodePredicted)
.github/workflows/pages.yml   test + build + deploy Pages
```

## Invarianti (non romperle)

1. **Ogni sfondo una sola volta.** `embedBackgrounds()` incorpora ogni sfondo usato dal job una volta sola, chiave `sourceId:pagina`, prima di creare le pagine; tutte le pagine lo referenziano (`drawObject`, nome risorsa `Velina`).
   - Pagine PDF: Form XObject da `embedTemplatePages()`, **una chiamata (un `PDFObjectCopier`) per file sorgente**, così le risorse condivise fra pagine dello stesso PDF (font, immagini) sono copiate una volta. **Non usare `doc.embedPages()`/`embedPdf()` di pdf-lib**: copia anche lo stream contenuti originale come oggetto orfano e raddoppia la dimensione della velina. Se lo stream è unico viene riusato byte per byte (con `Filter`/`DecodeParms`); più stream vengono decodificati, uniti con `\n` e ricompressi.
   - Immagini: un Image XObject per file (indipendente dal formato pagina degli slot), disegnato direttamente nella pagina con `q [clip] cm /Velina Do Q`.
   - Il writer di pdf-lib salva **tutto ciò che è registrato**: le cache vanno consultate prima di `register`, non esiste raccolta degli orfani.
   - Nessuna deduplicazione fra PDF diversi (stesso font in due PDF = due copie): scelta deliberata, vedi diario.
   Test di guardia: `references the template once…`, `alternates front and back…`, `composes several pages per record…` (generate.test.ts), `combines PDF, JPEG and PNG pages…` (raster.test.ts).
2. **Coordinate zone in "view space"**: punti PDF (1/72"), origine **in alto a sinistra** della pagina *come visualizzata* (dopo `/Rotate`), y verso il basso. `view` = CropBox ∩ MediaBox (quello che mostrano pdf.js e Acrobat). Conversione verso lo spazio utente PDF: una sola matrice per pagina `rotationMatrix(rotate, w, h, ox, oy)`; la stessa funzione ruota il contenuto dentro la zona (`field.rotation`, antioraria). Non introdurre altre convenzioni.
   Test di guardia: `places fields where they were drawn on a page rotated %i°` (0/90/180/270).
3. **Anteprima = motore reale.** L'overlay dell'editor è `generate({ sources: null, … })` su un solo record e una sola pagina (pagina `[0,0,viewW,viewH]`, nessuna rotazione), renderizzato da pdf.js sopra il canvas della velina. Lo sfondo di una pagina immagine è il PDF di 1 pagina prodotto da `generate()` senza zone (stessa incorporazione e stessa matrice dell'output). Nessun secondo renderer "approssimato" in CSS o `<img>`.
4. **Contatore sull'indice assoluto del record**: `{#}` = `start + recordIndex * step`; generare l'intervallo 50–60 dà gli stessi numeri della tiratura completa.
5. **Errori parlanti**: gli errori di generazione sono `Record N, zona "Nome": …` o `Zona "Nome": …` (segnaposto). Non sopprimere caratteri non codificabili: si ferma e l'utente carica un TTF.
6. **Nessun upload**: tutto locale nel browser. Non aggiungere backend o servizi esterni.
7. **Build single-file**: deve funzionare aprendo `dist/index.html` da `file://`. Worker generazione importato con `?worker&inline`; worker pdf.js con `?url` (inlinato come data URL). Verificalo dopo ogni cambio di dipendenze/bundling.
8. **Composizione a slot.** `Slot = {id, sourceId, page, enabled, raster?}`; le zone appartengono a uno slot (`Field.slot`), non alla pagina sorgente: la stessa pagina può comparire più volte con zone diverse e il riordino non sposta le zone. Slot disabilitati: conservano le zone, non vengono generati. `jobPage(slot, info)` è l'unica risoluzione slot → geometria, usata da editor, anteprima e output.
9. **Raster senza perdita** (`raster.ts`), ordine di priorità dell'utente: qualità > correttezza > stampa > riuso > dimensione > velocità.
   - JPEG: byte DCT originali con `DCTDecode`; si eliminano solo i segmenti di metadati (APP1 EXIF/XMP, APP2 ICC, APP13, altri APPn, COM), si tengono JFIF/APP14 Adobe/tabelle/SOF e tutto da SOS in poi. Solo SOF0/1/2 a 8 bit (gli altri → errore italiano). CMYK: `Decode [1 0 1 0 1 0 1 0]` **solo** con APP14 Adobe (verificato con pdf.js).
   - PNG tipo 0/2/3 non interlacciato: IDAT concatenati **così come sono** come `FlateDecode` + `DecodeParms {Predictor 15, Colors, BitsPerComponent, Columns}` (1–16 bit, palette `[/Indexed base hival <PLTE>]`, tRNS grigio/RGB → `/Mask` color key). Tipo 4/6, Adam7 o palette con tRNS: decodifica propria a profondità nativa (unfilter + deinterlacciamento, **non** UPNG: bug Adam7 in `UPNG.js:316`) e ricompressione con predittori PNG (euristica libpng) via `CompressionStream`; alpha → SMask a 8/16 bit.
   - Mai `embedJpg`/`embedPng` di pdf-lib (16→8 bit, palette espanse, ICC ignorato, `Decode` CMYK sempre invertito, `DataView` senza byteOffset).
   - Colore (scelta dell'utente): profilo ICC RGB → `ICCBased` (N 3, Alternate DeviceRGB; per PNG lo stream zlib di iCCP è riusato com'è); profili grigio/CMYK **ignorati** (DeviceGray/DeviceCMYK, avviso "valori di stampa conservati") per non trasformare il K100 in quadricromia sul RIP. Nessun `/Group` di trasparenza aggiunto alle pagine.
   - Nessun ricampionamento, nessuna conversione automatica, nessun ritaglio/deformazione senza scelta esplicita (`fit` cover/stretch).

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
- **Store UI** (`state.ts`): `notify(...topics)` chiama ogni listener una volta. Topic: `composition` (file/slot/impostazioni pagina cambiati), `data`, `fields`, `geometry` (durante il drag: solo sincronizzazione input del pannello, nessun re-render overlay), `selection`, `view` (anche cambio di slot corrente), `fonts`, `output`. Il pannello proprietà si ricostruisce su `selection`/`fonts`/`data`/`composition` e su `fields` aggiorna solo gli input non a fuoco (`syncers`), così non perde il focus mentre si scrive. Cambiare slot notifica solo `view` (un `composition` ricostruirebbe il pannello output perdendo il risultato).
- **Pagine immagine** (`rasterPage()`): `RasterLayout = {size: 'image'|'A3'|'A4'|'A5'|'custom', width, height (pt, custom), orientation: auto|portrait|landscape, fit: contain|cover|stretch, dpi|null}`. Geometria: MediaBox `[0,0,W,H]`, `rotate 0`, view = MediaBox; l'orientamento EXIF (1–8, solo JPEG) è nella matrice immagine, non nel `/Rotate`. `size:'image'` = dimensione da DPI (`layout.dpi` o quelli del file). Predefinito (`defaultLayout`): `image` se il file dichiara ≥ 150 dpi in unità fisiche (JFIF/EXIF/pHYs), altrimenti A4 `contain` con orientamento dell'immagine. Il layout è **per slot**: la stessa immagine può stare su A4 e A5 senza essere incorporata due volte.
- **Limiti raster**: decodifica rifiutata oltre 400 MB di campioni (`MAX_DECODED_BYTES`); il pass-through non ha limiti oltre al file. APNG: solo l'immagine predefinita (IDAT).
- **Anteprima e ICC**: pdf.js è aperto senza `wasmUrl`/`useWorkerFetch` → i profili ICC non sono applicati in anteprima (fallback all'Alternate); `wasmUrl` è un *prefisso* condiviso con openjpeg/jbig2 e letto con XHR sincrona, quindi un solo data URL nel single-file non basta. Limite documentato, il PDF finale contiene i profili.
- **Formato progetto** `.dvp.json` **versione 2** (`project.ts`): `{ app:'DatoVariabile', version:2, sources:[{id,name,kind:'pdf'|'jpeg'|'png',data(base64)}], slots: Slot[], fields: Field[] (con slot), fonts:[{name,data}], manualCount }`. Ogni file una volta (all'import i file con byte identici sono riusati). I dati NON vengono salvati. Versione 1 (`template` + `pagesSpec` + `Field.page`) migrata all'apertura: template → sorgente unica, `pagesSpec` → slot nell'ordine, una copia della zona per ogni occorrenza della sua pagina (come disegnava v1), pagine escluse con zone → slot disabilitati; `pagesSpec` non valido → tutte le pagine con avviso. Versione > 2 → errore "formato più recente". Se cambi `Slot`/`Field`/layout, incrementa la versione con migrazione.
- **Record count**: con dati = righe; senza dati = `state.manualCount` (predefinito **1**: lavori di sola numerazione o PDF da immagini).
- **Worker**: la richiesta contiene solo i file usati da slot abilitati (`jobSources()`), clonati (structured clone); l'output è trasferito.

## Convenzioni

- Logica nuova che non tocca il DOM va in `src/core/` ed è testabile in Node.
- Niente framework UI: DOM vanilla con `h()`. Niente nuove dipendenze se basta poco codice.
- Unità interne in punti; l'interfaccia mostra millimetri (`MM = 72/25.4`).
- Colore predefinito CMYK 0/0/0/100 (nero di stampa); fondo bianco in CMYK 0/0/0/0 se la zona è CMYK.
- Test solo per comportamenti visibili all'utente (dimensione output, posizioni, pixel/byte delle immagini, parsing, errori). Fixture generate in codice (`tests/helpers.ts`, `tests/images.ts`: JPEG a blocchi piatti con quantizzazione 1 = pixel esatti, PNG di ogni tipo/profondità/filtro/Adam7), nessun file binario di test. I test sono type-checkati senza tipi Node: usare `CompressionStream`, non `node:zlib`.
- Commit e testi in italiano. Identità git locale del repo: `lukethehawk <98876950+lukethehawk@users.noreply.github.com>`.

## Verifica prima di consegnare

1. `npm run build` (type-check + build) e `npm test`.
2. Per modifiche all'interfaccia: aprire `dist/index.html` da `file://` in Chromium, caricare due veline (es. un PDF e un JPG/PNG) e un Excel, aggiungere zone su più pagine, riordinare, generare e controllare il PDF (trucco: ricaricare il PDF generato come velina nell'app e sfogliarne le pagine; oppure contare gli stream grandi con pdf-lib).
3. Dopo il push controllare il workflow Pages (`gh run list`, `gh run watch`).

## Backlog noto

- Modulo di imposizione (N pose per foglio, crocini di taglio): non presente.
- Anteprima con profili ICC (qcms di pdf.js) compatibile col single-file; copia degli `/OutputIntents` delle veline PDF.
- Deduplicazione di risorse identiche fra PDF diversi (misurare prima su veline reali: guadagno incerto con font subsettati).
- Miniature/anteprima di immagini enormi: pdf.js decodifica l'immagine intera a ogni render.
- QR più veloci: encoder dedicato (es. `qrcode-generator`) per `qrcode`, bwip-js per il resto.
- Annulla/ripeti nell'editor: non presente.
- Workflow: le action `checkout`/`setup-node`/`upload-pages-artifact`/`deploy-pages` v4 danno avviso di deprecazione Node 20 (funzionano).
