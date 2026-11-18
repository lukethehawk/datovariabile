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
  composition.ts     inspectSource(), slotsFor() (slot per un file nuovo), activeComposition(), jobPage() (slot → JobPage), sourceKind(), newId()
  blank.ts           pagine vuote: parseMm() (virgola italiana, max 2 decimali), blankSizeProblem() (2–5080 mm: lettori PDF da 3 pt a 14 400 pt), blankPageName(), blankPagePdf() (PDF di una pagina bianca, byte deterministici)
  archive.ts         progetto v3 `.dvp.zip`: writeProjectArchive(), readProjectFile() (riconosce ZIP v3 o JSON v1/v2), validazione del manifest
  zip.ts             ZIP minimale scritto in casa: writeZip(), openZip() con validazione completa, ZIP_LIMITS, isSafePath()
  crc32.ts           crc32()/crc32Async() (PNG e ZIP)
  project.ts         ProjectData/SavedData, parseProject() per i vecchi .dvp.json v1/v2 (migrazione v1), parsePages() (solo v1)
  barcode.ts         SYMBOLOGIES, BarcodeRenderer.place(), drawing context bwip-js → operatori PDF
  text.ts            layoutText(): a capo, riduzione corpo (ricerca binaria), allineamenti
  placeholders.ts    compileContent(): {#} contatore della zona, {@Nome} generatore, {Colonna}; formatCounter(), referencedColumns()
  generators.ts      generatori di dati: compileGenerators() (GeneratorSet per job), numberingBody(), uniqueCodes() (hmac-sha256-ctr-v1), formatDateTime(), generatorProblem()/nameProblem(), renameInContent()
  data.ts            readTable() (xlsx/csv/txt), toDataSet(), detectDelimiter(), parseDelimited(), decodeText(), writeProjectCsv()/parseProjectCsv() (CSV del progetto)
  fonts.ts           STANDARD_FONTS, FontCache (embed una volta per documento)
src/ui/              interfaccia DOM vanilla
  state.ts           store globale `state` (sources, slots, slotId…) + pub/sub per topic, slotPage(), createField(), recordRange()
  actions.ts         addSource()/removeSource() (dedup per byte), dati, font, openPdf() pdf.js, salva/apri progetto
  pages-panel.ts     pannello "Pagine per record": slot con miniature, riordino (trascina/↑↓), duplica, escludi, elimina, aggiungi pagina, impostazioni pagina immagine
  backgrounds.ts     slotPdfPage(): sfondo di uno slot come pagina pdf.js (immagini: PDF di 1 pagina fatto da generate(), cache per layout)
  generators-panel.ts sottosezione "Generatori" di DATI VARIABILI: menu ＋ Nuovo generatore, schede (tipo, esempi, zone), impostazioni, eliminazione
  viewer.ts          canvas velina + canvas overlay + riquadri zone (drag/resize/tastiera), zoom
  props.ts           elenco zone e pannello proprietà
  data-panel.ts      sottosezione "Database": carica/sostituisci/rimuovi, foglio, intestazioni, anteprima tabella
  output.ts          GENERAZIONE PDF: record (manuali o dal database), intervallo, riepilogo, generazione nel worker, download
  fonts-panel.ts     RISORSE › Font aggiuntivi: carica/rimuovi TTF/OTF
  sections.ts        sezioni comprimibili della colonna destra (localStorage), riassunto e avviso a sezione chiusa
  blank-page.ts      dialogo "＋ Nuova pagina vuota" (<dialog> nativo): misure in mm → blankPagePdf() → addSource()
  dom.ts             h() builder, toast, download, formatBytes
src/worker.ts        Web Worker: riceve Job, chiama generate(), invia progress/done/error
src/main.ts          bootstrap, drag&drop file, stato toolbar
tests/               generate.test.ts (anche multi-PDF), raster.test.ts, project.test.ts (v1/v2), archive.test.ts, zip.test.ts, csv.test.ts, data.test.ts, generators.test.ts (vettori golden), generators-integration.test.ts,
                     helpers.ts (makePdf, pdfJob, textField, barcodeField), images.ts (flatJpeg, encodePng, decodePredicted)
docs/FORMATO_PROGETTO.md   specifica del formato .dvp.zip v4 e dei generatori (leggere prima di toccare salvataggio o generatori)
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
10. **Progetto autosufficiente** (`archive.ts`, specifica in `docs/FORMATO_PROGETTO.md`). "Salva progetto" scrive solo `.dvp.zip` v4; "Apri progetto" legge v4, v3 e i vecchi `.dvp.json` v1/v2.
   - I file originali (veline, dati, font) vanno nell'archivio **byte per byte**, una volta sola; nessun base64.
   - Autorevole all'apertura: `progetto.json` + `dati/dati-usati.csv` (celle importate, riga d'intestazione inclusa) + `data.columns` del manifest. **Il file dati originale non si rianalizza mai all'apertura** (serve solo a cambiare foglio): un aggiornamento di SheetJS o dell'euristica del separatore non deve cambiare i valori salvati.
   - CSV del progetto: UTF-8 con BOM, `;`, CRLF, virgolette solo se servono, righe non rettangolarizzate, letto con `parseProjectCsv()` (mai con `readTable`/`detectDelimiter`: con una colonna romperebbe le celle quotate).
   - Apertura **tutto-o-niente**, e dati/intervallo del lavoro precedente non sopravvivono mai a un'apertura (anche dei vecchi JSON, che non contenevano dati).
   - L'archivio è input non attendibile: validare tutto in `openZip()`/`checkManifest()` prima di estrarre; ogni limite controllato in apertura deve essere rispettabile in salvataggio.
11. **Generatori di dati** (`generators.ts`, specifica in `docs/FORMATO_PROGETTO.md` §8). Un valore per record, funzione pura di impostazioni + indice **assoluto** del record (+ `Job.now` per le date "alla generazione"); un solo `GeneratorSet` per job, così testo, QR, barcode, fronte e retro ricevono lo stesso valore. Nessuna casualità durante la risoluzione: l'unica è la chiave creata con il generatore (`crypto.getRandomValues`).
   - `{#}` resta il contatore **della zona** (non è un generatore). `{@Nome}` = generatore (nome case-insensitive); senza generatore con quel nome si cerca la colonna "@Nome" (compatibilità); generatore e colonna insieme → errore. Rinominare riscrive i segnaposto.
   - Codici univoci `hmac-sha256-ctr-v1` **congelato**: HMAC-SHA-256 (`@noble/hashes`, versione esatta 2.4.0) in modalità contatore, rejection sampling, scarto dei duplicati; record i = i-esimo codice distinto, quindi si generano sempre i codici 0…i (mai solo l'intervallo). Persistita solo la chiave. Limite: record ≤ 50 % delle combinazioni. Qualsiasi modifica all'algoritmo richiede un nuovo valore di `algorithm`; i vettori golden in `tests/generators.test.ts` non vanno mai aggiornati per farli passare.
   - `Job.now` si prende **una volta** in `runGeneration` (output.ts); l'anteprima usa `state.previewNow` (fisso per la sessione, aggiornabile dal pannello). Date con `Intl.formatToParts` e separatori composti dall'app; data fissata = ora civile senza fuso.

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
- **Store UI** (`state.ts`): `notify(...topics)` chiama ogni listener una volta. Topic: `composition` (file/slot/impostazioni pagina cambiati), `data`, `fields`, `geometry` (durante il drag: solo sincronizzazione input del pannello, nessun re-render overlay), `selection`, `view` (anche cambio di slot corrente), `fonts`, `output`, `generators`. Il pannello proprietà si ricostruisce su `selection`/`fonts`/`data`/`composition` e su `fields` aggiorna solo gli input non a fuoco (`syncers`), così non perde il focus mentre si scrive. Cambiare slot notifica solo `view` (un `composition` ricostruirebbe il pannello output perdendo il risultato).
- **Colonna destra** (`index.html` + `sections.ts`): tre sezioni comprimibili `data-section` = `data` (DATI VARIABILI: sottosezioni Database `#data-panel` e Generatori `#generators-panel`), `output` (GENERAZIONE PDF `#output-panel`: record, intervallo, riepilogo, avanzamento/risultato), `resources` (RISORSE: Font aggiuntivi `#fonts-panel`). Intestazione = `button.section-toggle` con `aria-expanded`/`aria-controls`; stato aperto/chiuso solo in `localStorage` (`datovariabile.sezioni`, predefinito aperta/aperta/chiusa), mai nel progetto. A sezione chiusa l'intestazione mostra `setSectionMeta()` (riassunto) e `setSectionAlert()` (⚠ con testo per screen reader): ogni pannello che può bloccare la generazione deve impostare l'avviso. `runGeneration` apre la sezione output (`revealSection`) senza cambiare la preferenza. Spiegazioni lunghe → `button.info[data-tip]` (tooltip CSS su hover/focus, `aria-label` impostata da `initSections`), non paragrafi fissi. Larghezza colonna `clamp(272px, 26vw, 360px)`: i controlli devono restare dentro a 272 px (etichette delle select brevi).
- **Numero di record in UI**: con dati `Record disponibili` (righe, sola lettura); senza dati `Record da generare` (`state.manualCount`, conservato mentre i dati sono caricati e ripristinato alla rimozione). Unico pulsante di generazione: `#btn-generate` nella barra.
- **Pagine immagine** (`rasterPage()`): `RasterLayout = {size: 'image'|'A3'|'A4'|'A5'|'custom', width, height (pt, custom), orientation: auto|portrait|landscape, fit: contain|cover|stretch, dpi|null}`. Geometria: MediaBox `[0,0,W,H]`, `rotate 0`, view = MediaBox; l'orientamento EXIF (1–8, solo JPEG) è nella matrice immagine, non nel `/Rotate`. `size:'image'` = dimensione da DPI (`layout.dpi` o quelli del file). Predefinito (`defaultLayout`): `image` se il file dichiara ≥ 150 dpi in unità fisiche (JFIF/EXIF/pHYs), altrimenti A4 `contain` con orientamento dell'immagine. Il layout è **per slot**: la stessa immagine può stare su A4 e A5 senza essere incorporata due volte.
- **Pagine vuote** (`blank.ts`, decisione 2026-11-18): una pagina vuota è un PDF di una pagina bianca (MediaBox `[0 0 w·72/25,4 h·72/25,4]`, nessun contenuto né metadati con data, ~530 byte) creato da `blankPagePdf()` e aggiunto con la normale `addSource()`: per composizione, anteprima, generazione (un Form XObject vuoto per tutti i record) e archivio (`veline/`, `kind:'pdf'`) è un PDF caricato come gli altri, quindi **nessun tipo di sorgente nuovo e formato `.dvp.zip` invariato (v4)**. Byte deterministici: stessa misura e stesso nome → stesso file, condiviso da `addSource()` (deduplica per byte). Nome sorgente = nome scelto dall'utente o "Pagina vuota L × A mm", con estensione `.pdf`. Le misure si fissano alla creazione (modificarle = nuova pagina vuota). Le misure delle pagine nel pannello si mostrano con fino a 2 decimali (`formatMm`).
- **Limiti raster**: decodifica rifiutata oltre 400 MB di campioni (`MAX_DECODED_BYTES`); il pass-through non ha limiti oltre al file. APNG: solo l'immagine predefinita (IDAT).
- **Anteprima e ICC**: pdf.js è aperto senza `wasmUrl`/`useWorkerFetch` → i profili ICC non sono applicati in anteprima (fallback all'Alternate); `wasmUrl` è un *prefisso* condiviso con openjpeg/jbig2 e letto con XHR sincrona, quindi un solo data URL nel single-file non basta. Limite documentato, il PDF finale contiene i profili.
- **Formato progetto**: v4 = `.dvp.zip` (vedi invariante 10 e `docs/FORMATO_PROGETTO.md`): `progetto.json` (`sources[{id,name,kind,file:{path,size,crc32}}]`, `slots`, `fields`, `fonts`, `manualCount`, `range {from,to}`, `data` null o `{name, original, table{…,rows,width}, sheets, sheet, header, headerGuess, columns}`, `generators`), `LEGGIMI.txt`, `veline/NN-nome`, `dati/originale-nome`, `dati/dati-usati.csv`, `font/NN-nome`. STORE per pdf/jpg/png/xlsx/ods, DEFLATE (`CompressionStream('deflate-raw')`) per il resto. Limiti `ZIP_LIMITS`: archivio 512 MiB, 1000 voci, voce 512 MiB, totale 1 GiB, espansione ≤ max(1 MiB, 1000×), manifest 4 MiB. CSV modificato fuori dall'app (CRC diverso dal manifest) → usato con avviso e colonne ricalcolate. Versioni precedenti (`project.ts`): v3 `.dvp.zip` senza generatori, v2 `.dvp.json` (sorgenti/font in base64, nessun dato), v1 (`template` + `pagesSpec` + `Field.page`, migrata: `pagesSpec` → slot, zona copiata per ogni occorrenza, pagine escluse con zone → slot disabilitati). Versione > 4 → "formato più recente". Se cambi `Slot`/`Field`/layout/manifest/generatori, incrementa la versione con migrazione e aggiorna la specifica.
- **Nome del progetto**: `state.projectName` = nome del file aperto (senza `.dvp.zip`/`.dvp.json`), riproposto al salvataggio; altrimenti il nome della prima velina.
- **Manifest versione 4** = versione 3 + `generators` (scritta sempre; la 3 si legge con `generators: []`). Validazione con `generatorProblem()`/`nameProblem()` prima di applicare il progetto.
- **Record count**: con dati = righe; senza dati = `state.manualCount` (predefinito **1**: lavori di sola numerazione o PDF da immagini).
- **Worker**: la richiesta contiene solo i file usati da slot abilitati (`jobSources()`), clonati (structured clone); l'output è trasferito.

## Convenzioni

- **Terminologia**: nei testi per l'utente (interfaccia, messaggi, README) si dice **Grafica** (pulsanti, intestazioni), **file grafico** (PDF/JPG/PNG caricato), **pagina grafica** (singola pagina). "Velina" resta il termine tecnico in codice, commenti, nomi interni, documentazione architetturale e nel nome della cartella `veline/` dell'archivio (compatibilità: non rinominarla). Termini dell'interfaccia da mantenere: "Pagine per record", "Zona", "Dati variabili", "Generatori", "Generazione PDF".
- Logica nuova che non tocca il DOM va in `src/core/` ed è testabile in Node.
- Niente framework UI: DOM vanilla con `h()`. Niente nuove dipendenze se basta poco codice.
- Unità interne in punti; l'interfaccia mostra millimetri (`MM = 72/25.4`).
- Colore predefinito CMYK 0/0/0/100 (nero di stampa); fondo bianco in CMYK 0/0/0/0 se la zona è CMYK.
- Test solo per comportamenti visibili all'utente (dimensione output, posizioni, pixel/byte delle immagini, parsing, errori). Fixture generate in codice (`tests/helpers.ts`, `tests/images.ts`: JPEG a blocchi piatti con quantizzazione 1 = pixel esatti, PNG di ogni tipo/profondità/filtro/Adam7), nessun file binario di test. I test sono type-checkati senza tipi Node: usare `CompressionStream`, non `node:zlib`.
- Commit e testi in italiano. Identità git locale del repo: `lukethehawk <98876950+lukethehawk@users.noreply.github.com>`.

## Verifica prima di consegnare

1. `npm run build` (type-check + build) e `npm test`.
2. Per modifiche all'interfaccia: aprire `dist/index.html` da `file://` in Chromium, caricare due veline (es. un PDF e un JPG/PNG) e un Excel, aggiungere zone su più pagine, riordinare, generare e controllare il PDF (trucco: ricaricare il PDF generato come velina nell'app e sfogliarne le pagine; oppure contare gli stream grandi con pdf-lib).
3. Dopo il push controllare il workflow Pages (`gh run list`, `gh run watch <id> --exit-status`) e poi il sito pubblicato (aprire l'URL con `?v=<timestamp>` per evitare la cache): caricamento senza errori in console, più veline, generazione, salva/riapri progetto. Il push su `main` pubblica subito: farlo solo con conferma dell'utente.

## Backlog noto

Problemi dell'interfaccia segnalati dalla revisione del 2026-11-18: **risolti e verificati il 2026-11-18** (Chromium e Firefox da `file://`, test `tests/generation-check.test.ts`).

1. ~~Falso errore dei generatori su pagine disabilitate~~ — **risolto.** Causa: il riepilogo passava a `generatorIssue()` tutte le zone (`state.fields`), la generazione solo quelle degli slot abilitati. Soluzione: un'unica selezione `activeComposition(slots, fields)` (`composition.ts`: slot abilitati in ordine + zone su quegli slot) e un unico controllo `generationIssue(generators, fields, count)` (`generators.ts`); in `output.ts` `plannedJob()` li usa sia per il riepilogo sia per la richiesta al worker, e `enabledSlots()` deriva da `activeComposition`. Restano invariati: il pannello dei generatori segnala sempre una configurazione errata (anche se usata solo su pagine escluse) e il `.dvp.zip` valida **tutti** i generatori in salvataggio e apertura (l'archivio contiene anche le pagine escluse). Limite noto: il riepilogo non anticipa colonne mancanti o `{@X}` inesistenti, che fermano la generazione con l'errore `Zona "…": …` del motore.
2. ~~Barra di caricamento non raggiungibile da tastiera~~ — **risolto.** Causa: `<label class="btn">` con `<input type="file" hidden>` dentro: l'input nascosto non è focalizzabile e la label non lo è mai. Soluzione HTML: l'`input type="file"` è il controllo reale, visivamente nascosto ma focalizzabile (`.file-input`: 1×1 px, `opacity:0`, `clip-path`), seguito da `<label for>` con l'aspetto di pulsante; Tab lo raggiunge, Invio/Spazio aprono il selettore nativo, focus visibile con `.file-input:focus-visible + label.btn`; nome accessibile dalla label (emoji `aria-hidden`), descrizione dal `title`. Non usare `hidden`/`display:none` su questi input e non riportarli dentro la label. Non verificati: annunci reali di uno screen reader e Safari (WebKit per Windows di Playwright non disponibile).
3. ~~Barra sopra l'anteprima compressa a finestre strette~~ — **risolto.** Causa: una sola riga flex senza `wrap` e con spaziatori. Soluzione: `.stage-bar` con `flex-wrap`, menu della pagina elastico (150–340 px), navigazione record + zoom in un blocco `.bar-controls` che va a capo insieme; `.stage` è un container (`container-type: inline-size`) e sotto 700 px di anteprima si nasconde la sola didascalia "Anteprima record" (il gruppo ha `aria-label`). Risultato: 1 riga a 1600 e 1200 px, 2 righe a 960 px. Limite: a 800 px di finestra le colonne laterali lasciano 228 px all'anteprima e la barra usa 3 righe (senza sovrapposizioni né scorrimento).

Funzionalità e altro:

- **Modificare le misure di una pagina vuota senza perdere le zone** (richiesta dell'utente, 2026-11-18). Oggi le misure si fissano alla creazione. Idea: creare con `blankPagePdf()` il nuovo PDF, aggiungerlo come sorgente e far puntare gli slot esistenti (`slot.sourceId`, `page: 0`) al nuovo file: le zone sono agganciate allo slot e non si perdono. Da decidere: zone che escono dalla nuova pagina (avviso, nessuno spostamento automatico), ancoraggio in alto a sinistra (coordinate attuali) o scala proporzionale, rimozione della vecchia sorgente quando nessuno slot la usa più. Formato `.dvp.zip` invariato.
- Modulo di imposizione (N pose per foglio, crocini di taglio): non presente.
- Anteprima con profili ICC (qcms di pdf.js) compatibile col single-file; copia degli `/OutputIntents` delle veline PDF.
- Deduplicazione di risorse identiche fra PDF diversi (misurare prima su veline reali: guadagno incerto con font subsettati).
- Miniature/anteprima di immagini enormi: pdf.js decodifica l'immagine intera a ogni render.
- QR più veloci: encoder dedicato (es. `qrcode-generator`) per `qrcode`, bwip-js per il resto.
- Annulla/ripeti nell'editor: non presente.
- Workflow: le action `checkout`/`setup-node`/`upload-pages-artifact`/`deploy-pages` v4 danno avviso di deprecazione Node 20 (funzionano); `ubuntu-latest` passerà a Ubuntu 26 dal 19/10/2026 (avviso del runner).
