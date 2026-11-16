# Diario di sviluppo: DatoVariabile

Cronologia delle sessioni di lavoro: cosa è stato fatto, perché, cosa è stato scartato e cosa è stato misurato.
Fatti stabili, invarianti e convenzioni sono in [AGENTS.md](AGENTS.md) (memoria di progetto).

**Regola per chi lavora sul repo (persone o AI):** a fine sessione aggiungi in fondo una voce con data, obiettivo, decisioni (con il perché), misure, problemi incontrati e lavoro rimasto. Se una decisione cambia un'invariante, aggiorna anche `AGENTS.md`.

---

## 2026-11-16: Prima versione

### Obiettivo

Richiesta dell'utente: un software simile a ProXDATA (https://www.tecnotronica.net/proxdata/, licenza € 799 + IVA) ma più comodo, per un uso occasionale:
caricare un PDF "velina", posizionare il dato variabile, importare Excel/TXT/CSV e ottenere un PDF multipagina **poco più grande della velina** (non una concatenazione di copie).

Dal depliant ProXDATA 2026 sono state prese le funzioni rilevanti: zone con strategie diverse (contatori, codici a barre, QR, testi da file), fondo "bianco carta" sotto i codici, fronte/retro, anteprima, modifica dei box della velina, imposizione, export dei codici.
Scope scelto per la prima versione: velina PDF (anche multipagina, per fronte/retro), zone testo e codice, contatore, dati da file, anteprima reale, intervallo di record, progetto salvabile. Imposizione e velina da immagine rimandate.

### Scelta architetturale: app web locale

- **Web app che gira tutta nel browser**, pubblicata su GitHub Pages. Motivi: zero installazione e zero licenze (uso occasionale), file dell'utente che non lasciano il PC, aggiornamento automatico.
- **Build single-file** (`vite-plugin-singlefile`): lo stesso `index.html` (~6,6 MB, 2,4 MB gzip) funziona da Pages e offline con doppio clic.
- Scartate: app desktop Python/PySide (installer, packaging, aggiornamenti) e Electron/Tauri (peso, firma su Windows). Tauri resta possibile in futuro avvolgendo la stessa build.
- UI in DOM vanilla con TypeScript, senza framework: l'interfaccia è contenuta e così si evitano dipendenze.
- Generazione in un **Web Worker** (interfaccia reattiva, annullamento con `terminate()`).

### Il cuore: PDF leggero

1. Primo tentativo con `doc.embedPages()` di pdf-lib + `page.drawPage()`. Misura su 1000 pagine e velina da 383 KB: **1,03 MB**, ma l'analisi degli oggetti mostrava **due** stream da 383 KB: pdf-lib copia lo stream contenuti della pagina sorgente (orfano) *e* crea l'XObject ricodificato.
2. Soluzione: `embedTemplatePages()` scritta a mano con `PDFObjectCopier` (copia le Resources), dizionario Form XObject (`BBox` = MediaBox, `Group` della pagina se presente) e **riuso dello stream compresso originale** byte per byte. In più si eliminano i 5 `cm` identità che `drawPage` aggiungeva a ogni pagina.
3. Risultato: 1000 pagine con un testo = **634 KB** (≈ 250 byte/pagina oltre la velina).

Misure finali (velina 383 KB, 1000 record):

| Contenuto per pagina | Output | Byte/pagina | Tempo (Node) |
| --- | --- | --- | --- |
| 1 testo | 634 KB | 250 | 0,6 s |
| QR Code | 1,18 MB | 793 | 4,7 s |
| Code 128 + testo leggibile | 823 KB | 439 | 3,5 s |
| Code 128 senza testo | 739 KB | 356 | 3,3 s |

Nel browser: 250 record × 2 pagine (fronte/retro) con testo e QR = 500 pagine, 277 KB, 1,5 s.

### Codici a barre

1. Prima versione: `bwip-js.toSVG()` + parser del sottoinsieme SVG (M/L/Q/C/Z) → operatori PDF. Funzionava, ma con il testo leggibile un Code 128 pesava **2,8 KB/pagina**: il testo era disegnato come contorni dei glifi OCR-B.
2. Versione finale: **DrawingContext personalizzato** (API pubblica `bwipjs.render(opts, drawing)`) che produce direttamente gli operatori PDF; il testo leggibile diventa un'etichetta disegnata con Helvetica standard (vero testo, selezionabile, ~0 byte di font). Code 128 con testo: da 2861 a **439 B/pagina**. Si elimina anche la costruzione e il parsing della stringa SVG.
3. Proporzioni: i 2D si adattano mantenendo il rapporto; i lineari usano una calibrazione altezza (render a 10 e 30 mm → retta px/mm) per scegliere l'altezza barre adatta alla zona, così lo stretch finale non deforma il testo.
4. Tempi: il costo è BWIPP (~4 ms per QR, misurato con `toSVG` puro). Un encoder QR dedicato è nel backlog.

### Coordinate e rotazioni

- Le zone vivono nello spazio della pagina *visualizzata* (dopo `/Rotate`, area visibile = CropBox ∩ MediaBox), in punti, origine in alto a sinistra: coincide con ciò che pdf.js mostra nell'editor.
- Le matrici per `/Rotate` 0/90/180/270 sono state ricavate a mano e unificate in `rotationMatrix()`, riusata anche per la rotazione del contenuto della zona.
- Verificato con test che estraggono il testo con pdf.js e ne confrontano la posizione nella viewport, per tutte e quattro le rotazioni.

### Anteprima

- L'overlay dell'editor è generato dallo stesso `generate()` in modalità "solo dati" (`template: null`) e renderizzato da pdf.js su un canvas trasparente sopra la velina (renderizzata una volta e messa in cache per pagina, zoom e DPR). Debounce di 120 ms e numero di sequenza contro le gare tra render.
- Bug trovato in prova: overlay **nero**. pdf.js 6 crea il contesto canvas con `alpha:false` se gli si passa `canvas`; risolto passando un `canvasContext` proprio (`canvas: null`).
- Render su canvas fuori schermo e poi `drawImage`, per evitare lo sfarfallio.

### Dati

- SheetJS per Excel/ODS; parser CSV/TXT scritto in casa (RFC 4180) per controllare la codifica: UTF-8 rigoroso, altrimenti Windows-1252 (CSV esportati da Excel italiano). Separatore rilevato automaticamente.
- Le date di Excel con formato breve uscivano `m/d/yy`: corretto con `dateNF: 'dd/mm/yyyy'`.
- `XLSX.writeFile` fallisce in Node ESM ("cannot save file"): nei test e negli script usare `XLSX.write(wb, { type: 'array' | 'buffer' })`.

### Problemi di ambiente risolti

- npm 12 rifiuta i tarball remoti → SheetJS in `vendor/` come dipendenza `file:`.
- bwip-js: tipi non risolti da TypeScript con `moduleResolution: bundler` → `customConditions: ["browser"]`.
- `tsx` con top-level await richiede `"type": "module"` in `package.json`.
- pdf.js 6: `PDFDocumentProxy.destroy()` non esiste più; usare `loadingTask.destroy()`.
- Nei test pdf.js avvisa sui font standard: passato `standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/'`.
- Nessuna identità git configurata sulla macchina: impostata solo a livello di repo (`lukethehawk`, email noreply).

### Verifiche eseguite

- `npm test`: 15 test (dimensione e unicità della velina, box e rotazione conservati, posizioni su 4 rotazioni, EAN e contatore sull'indice assoluto, errori con record/zona, avviso overflow e riduzione corpo, colonna mancante; CSV Windows-1252 con `;` e virgolette, TSV UTF-8 con BOM, TXT a una colonna, intestazioni duplicate, Excel con date e più fogli).
- Prova in Chromium del single-file da `file://` e del sito pubblicato: velina + Excel, drag e resize, generazione e download, PDF ricontrollato ricaricandolo come velina, font Arial TTF con caratteri polacchi (200 pagine, 67 KB), salvataggio e riapertura del progetto, CSV Windows-1252, messaggio d'errore per EAN non valido.
- GitHub Pages abilitato (`build_type=workflow`); il workflow `pages.yml` (test + build + deploy) è passato.

### Lavoro rimasto

Vedi "Backlog noto" in `AGENTS.md`: imposizione, velina da immagine, QR più veloci, annulla/ripeti, aggiornamento delle action GitHub.

---

## 2026-11-16: Più veline (PDF, JPG, PNG), composizione delle pagine, raster senza perdita

### Obiettivi

Richiesta dell'utente, ispirata alla composizione da sorgenti diverse di ProXDATA:
1. più veline contemporaneamente, con N pagine per record nell'ordine scelto (fronte/retro da `fronte.pdf` + `retro.pdf`, 100 record → 200 pagine F1 R1 F2 R2 …), pagine riusabili, riordinabili, zone indipendenti per pagina;
2. veline direttamente da JPG/PNG, anche miste a PDF, anche senza dati né zone (PDF da immagini);
3. immagini incorporate **senza ulteriori perdite** (priorità: qualità > correttezza > stampa > riuso > dimensione > velocità);
4. conservare l'ottimizzazione "velina una volta sola" estesa a tutte le sorgenti;
5. progetto salvabile con tutto, progetti v1 ancora apribili; documentazione per agenti futuri.

### Analisi iniziale

- Stato: una sola velina (`state.template`), `Field.page` = indice di pagina della velina, `pagesSpec` "1,2" = sequenza per record. Il fronte/retro esisteva solo con pagine nello stesso PDF.
- `embedTemplatePages()` crea un `PDFObjectCopier` per chiamata: la sua cache deduplica le risorse **dentro** un PDF sorgente, non fra PDF diversi.
- pdf-lib 1.17.1 sulle immagini (letto in `node_modules/pdf-lib/cjs`): `embedJpg` passa i byte così come sono ma ignora ICC/APP14/EXIF e mette sempre `Decode` invertito per CMYK; `embedPng` usa `UPNG.toRGBA8` → **16 bit troncati a 8**, grigi e palette espansi in RGB, nessun predittore, profili ignorati. Entrambi inadatti al requisito di qualità.

### Council (Opus 5.5 High + GPT-6.1 Sol High)

Svolto tramite gli agenti `council-opus` (`anthropic/claude-opus-5-5`, high) e `council-sol` (`openai-codex/gpt-6.1-sol`, high), modelli verificati nei log di sessione: analisi indipendenti con lo stesso brief, poi un giro di revisione incrociata. Il coordinatore ha aggiunto prove sperimentali.

- **Concordi da subito**: slot con zone legate allo slot (non alla pagina sorgente, altrimenti la stessa pagina non può avere zone diverse); `embedTemplatePages` invariata con un copier per sorgente; embedder JPEG/PNG propri; pass-through PNG per i tipi senza alpha; migrazione v1.
- **Divergenze e come sono state risolte**:
  - *Immagine nella pipeline*: Opus proponeva di convertire ogni immagine in un PDF sintetico di 1 pagina (una sola strada per tutto); Sol un Image XObject disegnato direttamente nella pagina. Nella revisione incrociata Opus ha accettato B: con il PDF sintetico la stessa immagine usata in due slot con formati diversi verrebbe copiata due volte (copier separati) e nel worker esisterebbe ~3 volte in RAM (input, parser, clone). Condizione accolta: lo sfondo dell'anteprima deve uscire da `generate()` (nessun secondo costruttore).
  - *Layout immagine per sorgente o per slot*: per slot (Sol), così A4 e A5 della stessa immagine non duplicano nulla.
  - *Zone annidate negli slot (Sol) o lista piatta con `Field.slot` (Opus)*: lista piatta, Sol ha accettato (l'interfaccia lavora tutta su `state.fields`).
  - *Zone v1 su pagine escluse da pagesSpec*: slot disabilitati che le conservano (Sol); Opus proponeva di scartarle con avviso, poi ha accettato.
  - *Profili grigio/CMYK*: Opus "valori di dispositivo" (prassi PDF/X-4, il K100 resta solo nero), Sol "ICCBased con opzione". Decisione rimessa all'utente, che ha scelto i **valori di dispositivo** con avviso; gli RGB con profilo restano ICCBased.
  - *Anteprima con ICC (qcms di pdf.js)*: Sol la voleva subito, Opus la riteneva incompatibile col single-file. Verifica nel codice di pdf.js (`pdf.worker.mjs:2776-2808`, `:8735-8790`): `wasmUrl` è un **prefisso** a cui pdf.js aggiunge `qcms_bg.wasm`, `openjpeg.wasm`, `jbig2.wasm` e lo legge con XHR sincrona; un unico data URL non può servire tre file. Limite documentato (README, AGENTS), non tentato un patch di pdf.js.
  - *Binari del progetto*: mappa `assets` per SHA-256 (Sol) contro file dentro ogni sorgente con deduplicazione all'import per confronto dei byte (Opus): scelta la seconda, perché font e sorgenti non condividono mai byte e non serve `crypto.subtle`.
- Evidenze emerse: bug di UPNG nell'unfilter Average della prima riga delle passate Adam7 (`UPNG.js:316-317`, `data[x+1]` invece di `data[off+x+1]`) → decodifica PNG scritta in casa; il writer di pdf-lib serializza tutto ciò che è registrato (`PDFStreamWriter.js:36-48`) → le cache vanno consultate prima di `register`.

### Prove sperimentali prima di implementare

PNG RGB 1200×900, pixel verificati decodificando con pdf.js:

| Immagine | PNG | `embedPng` | IDAT pass-through | decode + Flate livello 9 |
| --- | --- | --- | --- | --- |
| foto (gradienti + rumore) | 2 695 252 B | 2 694 818 B, 342 ms | 2 696 210 B, **13 ms** | 2 694 818 B, 265 ms |
| grafica (campiture) | 128 325 B | 128 860 B, 171 ms | 129 280 B, **9 ms** | 120 536 B, 89 ms |

Pass-through valido anche per 16 bit, grigio 1 bit, palette 4 bit e tutti i filtri PNG. Conclusione: la compressione nativa del PDF basta, nessuna libreria di ottimizzazione PNG (guadagni marginali e dipendenti dall'immagine, contro tempo e RAM).

### Architettura implementata

- **Modello** (`types.ts`): `SourceFile {id,name,kind,bytes}`, `Slot {id, sourceId, page, enabled, raster?}`, `RasterLayout`, `Field.slot`. `Job` ora ha `sources` (null = solo dati, anteprima) e `pages: JobPage[]` (slot risolti con geometria e, per le immagini, matrice di posizionamento).
- **Generazione** (`generate.ts`): `embedBackgrounds()` raggruppa le pagine usate per file, chiama `embedTemplatePages()` una volta per PDF e `embedRaster()` una volta per immagine; poi il ciclo record × pagine invariato (zone raggruppate per slot una volta sola). Pagine immagine: MediaBox `[0,0,W,H]`, `q [clip] cm /Velina Do Q`, zone in view space senza rotazione.
- **Raster** (`raster.ts`):
  - JPEG: parser dei marcatori fino a SOS; si copiano SOI + segmenti necessari (JFIF, APP14, tabelle, SOF) + tutto da SOS in poi. Il flusso DCT resta identico byte per byte; EXIF/XMP/ICC/Photoshop/commenti vengono tolti (l'ICC andrebbe altrimenti due volte nel PDF). Solo SOF0/1/2 a 8 bit. `Decode` CMYK solo con APP14 Adobe: verificato con pdf.js su un JPEG CMYK Adobe generato nei test (nero resta nero).
  - PNG: chunk con CRC verificata; tipi 0/2/3 non interlacciati → IDAT concatenati con `FlateDecode` + `DecodeParms` Predictor 15 (nessuna decompressione); tRNS grigio/RGB → `/Mask`; palette con trasparenza → base in pass-through + SMask dagli indici; tipi 4/6 e Adam7 → inflate limitato alla dimensione attesa, unfilter e deinterlacciamento a profondità nativa (anche bit < 8), separazione colore/alpha, predittori PNG con l'euristica di libpng e `CompressionStream` nativo (nessuna dipendenza). iCCP RGB → ICCBased riusando lo stream zlib del file.
  - `rasterPage()`: formato pagina (dimensione reale da DPI, A3/A4/A5, personalizzato), orientamento, adattamento contain/cover/stretch, orientamento EXIF 1–8 come matrice (anche eXIf dei PNG), DPI effettivi per l'avviso "risoluzione bassa".
- **Progetto v2** (`project.ts`) con migrazione v1 (vedi AGENTS.md).
- **Interfaccia**: pannello "Pagine per record" (`pages-panel.ts`) con miniature pdf.js, riordino trascinando o con ↑↓, duplica (con le zone), escludi, elimina, "＋ Aggiungi" per riusare pagine già caricate, impostazioni della pagina immagine con DPI effettivi; selettore pagina nella barra dell'anteprima; zona "Copia su…" un'altra pagina. Sfondo delle pagine immagine = PDF di 1 pagina generato **nel worker** (`backgrounds.ts`) e reso da pdf.js. `manualCount` predefinito 1 (PDF da immagini senza 100 copie a sorpresa).

### File toccati

Nuovi: `src/core/raster.ts`, `src/core/composition.ts`, `src/core/project.ts`, `src/ui/pages-panel.ts`, `src/ui/backgrounds.ts`, `tests/raster.test.ts`, `tests/project.test.ts`, `tests/images.ts`. Modificati: `src/core/types.ts`, `src/core/generate.ts`, `src/ui/state.ts`, `src/ui/actions.ts`, `src/ui/viewer.ts`, `src/ui/props.ts`, `src/ui/output.ts`, `src/main.ts`, `src/style.css`, `index.html`, `tests/generate.test.ts`, `tests/helpers.ts`, `README.md`, `AGENTS.md`.

### Problemi incontrati e soluzioni

- Le fixture di test non possono usare `node:zlib`/`Buffer` (i test sono type-checkati senza tipi Node): fixture con `CompressionStream`. Un encoder JPEG minimo "a blocchi piatti" con tabella di quantizzazione a 1 permette confronti **pixel esatti** dopo la decodifica pdf.js.
- Padding a fine riga nei PNG a meno di 8 bit: non sono campioni, il decodificatore li azzera (il test li confrontava).
- Miniature bianche: la cache memorizzava il canvas prima del render; ora memorizza la promessa.
- `puppeteer.drag` non genera il drag&drop HTML5: verificato il riordino con DragEvent reali e con le frecce.

### Revisione indipendente (GPT-6.1 Sol High, agente `council-sol`, sola lettura)

L'Advisor di OMP era disattivato (`advisor.enabled: false`); con l'accordo dell'utente la revisione è stata un subagente Sol High. Rilievi verificati e corretti:
1. cache dei PDF di anteprima: l'espulsione chiudeva documenti in uso → contatore d'uso, chiusura solo a uso finito (`withSlotPage`);
2. limite di memoria PNG che non contava tutte le allocazioni e inflate illimitato → stima del picco (dati, pixel, alpha, predittori) e inflate interrotto alla dimensione attesa;
3. migrazione v1: copie delle zone con contatore/colore condivisi (spread superficiale) → `structuredClone`, test aggiunto;
4. gAMA/cHRM senza profilo → avviso esplicito (i pixel restano identici; nessuno spazio calibrato inventato);
5. preparazione raster dell'anteprima sul thread UI → spostata nel worker;
6. apertura progetto fallita lasciava documenti pdf.js aperti → apertura tutto-o-niente;
7. il pannello output veniva ricostruito durante la generazione → durante il job si aggiorna solo il riepilogo;
8. orientamento `eXIf` dei PNG ignorato → letto con lo stesso parser TIFF;
9. DPI JFIF e EXIF discordanti → si tiene il più alto (la risoluzione di stampa);
10. cache delle miniature senza potatura e pannello ricostruito a ogni `view` → potatura e ricostruzione solo al cambio di pagina.

### Verifiche eseguite

- `npm test`: 54 test. Generazione multi-PDF (unicità degli stream, ordine F/R, riuso della stessa pagina con zone diverse, pagine di formati e rotazioni diverse, contatori), raster (byte DCT identici, ICC RGB, CMYK Adobe, JPEG non supportati, EXIF, DPI JFIF/EXIF discordanti; PNG di tutti i tipi/profondità con confronto esatto dei campioni, alpha 8/16 bit, Adam7, tRNS, iCCP, eXIf, avviso gAMA, rifiuto di dimensioni enormi prima di allocare; formato pagina e 8 orientamenti; composizione mista PDF+JPEG+PNG; PDF da sola immagine), progetto (migrazione v1 con copie indipendenti, round-trip v2, versioni sconosciute). I test aggiuntivi su eXIf/gAMA/DPI/limite memoria e il benchmark sono stati scritti da subagenti (ruolo TASK) e ricontrollati.
- `npm run build` e prova in Chromium da `file://`: fronte.pdf + retro.pdf + foto JPEG reale + PNG trasparente, Excel 100 righe, zone su più pagine, riordino, cover/contain, avviso DPI, generazione (400 pagine, 1,56 MB con veline per 1,50 MB, 0,9 s), controllo del PDF con pdf-lib (2 Form XObject + 1 JPEG, flusso JPEG identico al file), salvataggio e riapertura del progetto, apertura di un progetto v1, PDF da immagini senza dati (1 record, 3 pagine).

### Benchmark (Node 24, script temporaneo con `generate()` reale e fixture di `tests/`, non versionato; due zone testo per pagina)

| Documento | Record | Pagine | Sorgenti | PDF | Tempo | Stream > 50 KB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PDF singolo | 1 / 100 / 1000 | 1 / 100 / 1000 | 499 KB | 500 KB / 526 KB / 766 KB | 5 ms / 57 ms / 0,66 s | 1 |
| Fronte/retro 2 PDF | 1 / 100 / 1000 | 2 / 200 / 2000 | 874 KB | 874 KB / 927 KB / 1,4 MB | 8 ms / 113 ms / 1,3 s | 2 |
| JPEG 2480×3504 | 1 / 100 / 1000 | 1 / 100 / 1000 | 749 KB | 750 KB / 778 KB / 1,0 MB | 6 ms / 65 ms / 0,62 s | 1 |
| PNG RGB (pass-through) | 1 / 100 / 1000 | 1 / 100 / 1000 | 2,3 MB | 2,3 MB / 2,3 MB / 2,6 MB | 20 ms / 73 ms / 0,62 s | 1 |
| PNG RGBA (SMask) | 1 / 100 / 1000 | 1 / 100 / 1000 | 2,5 MB | 1,7 MB / 1,7 MB / 1,9 MB | 0,83 s / 0,99 s / 1,4 s | 1 |
| Mista PDF+JPEG+PNG RGBA | 1 / 100 / 1000 | 3 / 300 / 3000 | 3,7 MB | 2,9 MB / 3,0 MB / 3,7 MB | 0,92 s / 1,0 s / 2,3 s | 3 |

Gli stream grandi restano costanti al crescere dei record (nessuna copia delle veline); la crescita è ~270–320 byte per pagina con due testi. Il PNG RGBA esce più piccolo della sorgente perché colore e alpha separati e ripredetti comprimono meglio dell'RGBA interlacciato, senza perdita. La decodifica PNG con alpha costa ~0,8 s una volta per job.

### Limitazioni residue

Anteprima senza profili ICC; JPEG 12 bit/lossless/aritmetici rifiutati; decodifica PNG oltre ~400 MB di picco rifiutata; nessuna deduplicazione fra PDF diversi; `/OutputIntents` delle veline non copiati (già prima); gAMA/cHRM non convertiti in spazi calibrati; pdf.js decodifica l'immagine intera a ogni render dell'anteprima.

### Miglioramenti futuri

Anteprima ICC con pdf.js patchato o asset accanto all'HTML (rompe il single-file: da valutare); copia degli OutputIntents; misurare la deduplicazione fra PDF su veline reali; rendering dell'anteprima immagine a risoluzione ridotta; imposizione (backlog precedente).
