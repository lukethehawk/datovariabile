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

### Pubblicazione

- Push di `c167051` su `main` confermato dall'utente; workflow "Pubblica su GitHub Pages" (run 43880669034) riuscito: build e deploy. Avvisi non bloccanti: action v4 su Node 20 deprecato, `ubuntu-latest` → Ubuntu 26 dal 19/10/2026.
- Verifica del sito pubblicato in Chromium: nuovo pannello presente, nessun errore in console; fronte.pdf + retro.pdf + JPG + PNG con CSV di 50 righe, zone su tre pagine, riordino → 200 pagine, 1,53 MB (veline 1,45 MB) in 0,6 s; salvataggio e riapertura del progetto con pagine, ordine e zone. Dopo la riapertura l'anteprima segnala la colonna mancante perché i dati non sono nel progetto (comportamento voluto, ora spiegato nel README).
- Documentazione: README con tabella di misure estesa a fronte/retro, JPEG e composizione mista, scelta della pagina in anteprima, "Copia su…", dati non salvati nel progetto, struttura dei nuovi moduli; AGENTS.md con la procedura di verifica dopo il deploy.

---

## 2026-11-16: Salvataggio completo del progetto (`.dvp.zip`, formato 3)

### Motivazione

Riaprendo un progetto `.dvp.json` il database non tornava: andava ricaricato a mano (scomodo e rischioso: si può caricare il file sbagliato) e l'anteprima mostrava `Colonna "Nome" non presente nei dati`. L'utente voleva un unico file, come in ProXDATA, da salvare oggi, portare su un altro PC e riaprire domani con grafica, database e impostazioni identici. Nient'altro di ProXDATA in questo intervento.

### Analisi iniziale (stato reale del repo, HEAD 4c5b40a)

- Formato scritto: `.dvp.json` v2, sorgenti e font in base64 (+33 %), tutto in una stringa JSON; dati, foglio Excel scelto, intestazioni e intervallo di record **non** salvati; v1 migrato in `migrateV1`.
- Dati in memoria: `state.source = {name, bytes originali, table: RawTable {sheets, sheet, cells, headerGuess}, header}`, `state.data = toDataSet(...)` con colonne vuote → lettera e duplicate → `_2`. Le zone usano le colonne per nome (`{Nome}`).
- Nessuna libreria ZIP diretta. Disponibili: pako 1.0.11 (transitiva), CFB interno di SheetJS, `CompressionStream`/`DecompressionStream` nativi ('deflate-raw' verificato in Node 24), CRC-32 già scritto per i PNG.
- `openProject` lasciava in memoria dati e intervallo del lavoro precedente.

### Council (council-opus = claude-opus-5-5 high, council-sol = gpt-6.1-sol high)

Due analisi indipendenti sullo stesso brief, poi un giro di revisione incrociata. Sintesi permanente in `docs/FORMATO_PROGETTO.md` §7.

- **Proposte iniziali.** Sol: ZIP con fflate + validatore proprio, `manifest.json`, file con nomi generati (`v0001.pdf`), snapshot JSON autorevole delle celle + CSV solo leggibile (tutto quotato), impostazioni d'importazione nel manifest, azzerare i dati aprendo i vecchi JSON, limiti 256/512 MiB. Opus: ZIP scritto in casa con `CompressionStream('deflate-raw')`, `progetto.json`, nomi `01-fronte.pdf` sanificati, CSV delle celle grezze come unica fonte autorevole letta con parser esplicito a `;`, nessuna impostazione d'importazione oltre foglio/intestazioni, mantenere i dati aprendo i vecchi JSON, limiti 1/1,5 GiB.
- **Accordo dopo la revisione incrociata.** ZIP proprio (Sol: con fflate il validatore andrebbe scritto comunque; la decompressione nativa è già nel browser); CSV delle celle grezze autorevole e niente snapshot JSON (Sol riconosce che un CSV non rettangolarizzato conserva righe irregolari; colonne prese dal manifest come chiedeva Sol); `progetto.json`; `LEGGIMI.txt`; nomi con prefisso + nome ASCII; originale mai rianalizzato; vecchi JSON → dati e intervallo azzerati (Opus cambia posizione per il rischio "database sbagliato").
- **Divergenze decise dal coordinatore.** Virgolette solo quando servono (leggibilità; round-trip identico). Impostazioni d'importazione non salvate (servirebbero solo a rianalizzare l'originale). CSV modificato a mano → usato con avviso (Opus) invece di rifiutare cambi strutturali (Sol). Limiti intermedi: archivio 512 MiB perché è letto intero in memoria; espansione ≤ max(1 MiB, 1000×).

### Architettura implementata

- `src/core/zip.ts` (~280 righe): writer STORE/DEFLATE (DEFLATE solo se più piccolo e dentro il rapporto accettato), lettore che valida EOCD, directory centrale, ogni intestazione locale (nome, metodo, cifratura, CRC/dimensioni salvo data descriptor, disco), consumo esatto della directory, voci non sovrapposte, duplicati anche per maiuscole; decompressione in un buffer della dimensione dichiarata interrotta appena la supera, poi dimensione esatta e CRC. Rifiuta cifratura, ZIP64, multidisco, metodi ≠ 0/8. Gli stessi limiti valgono in scrittura: ogni progetto salvato si riapre.
- `src/core/crc32.ts`: CRC condiviso con `raster.ts`, versione asincrona che cede il controllo ogni 8 MiB.
- `src/core/archive.ts`: `writeProjectArchive()` (instantanea → voci → manifest per primo) e `readProjectFile()` (riconosce ZIP o JSON dal contenuto; validazione completa di manifest, riferimenti, slot, layout immagine e zone — font esistente, simbologia, contatore, colore — prima di toccare lo stato; CRC del manifest confrontati con quelli dell'archivio per le risorse non modificabili).
- `src/core/data.ts`: `writeProjectCsv()` / `parseProjectCsv()` (rigoroso, a fette invece che carattere per carattere, budget di 5 milioni di celle uguale in salvataggio e apertura).
- `src/core/project.ts`: ora contiene il modello comune (`ProjectData` con `data` e `range`, `SavedData`) e solo la lettura dei vecchi JSON.
- Interfaccia (`actions.ts`, `main.ts`, `index.html`, `dom.ts`, `state.ts`, `backgrounds.ts`): "Salva progetto" crea `Nome.dvp.zip` (nome del progetto aperto o della prima velina) con toast che ricorda che contiene i dati; "Apri progetto" accetta `.zip` e `.json`; apertura tutto-o-niente (file aperti uno alla volta, ogni pagina deve risolversi, poi un unico commit di composizione, zone, font, dati, intervallo, record), rilascio dei vecchi file dopo il commit; cache di anteprima e miniature con chiave per caricamento (`Source.rev`), perché un progetto riaperto può riusare gli stessi id con byte diversi.

### Regole di ripristino del database

CSV autorevole se il suo CRC coincide con quello del manifest: celle identiche, `rows`/`width` verificati, colonne dal manifest senza ricalcolo, foglio/intestazioni ripristinati, originale conservato per cambiare foglio. CSV diverso: dati modificati usati, colonne ricalcolate, avviso esplicito. Vecchi JSON: nessun dato inventato; avviso solo se le zone usano colonne.

### Problemi incontrati

- SheetJS aggiunge proprietà non numeriche all'array che legge: i confronti di byte nei test usano `Array.from`.
- `TextDecoder` toglie già il BOM: lo stripping aggiuntivo eliminava un U+FEFF legittimo nella prima cella (trovato dalla revisione).
- Il browser headless di OMP non pilota Firefox: prova Firefox fatta con `playwright-core` installato in una cartella temporanea fuori dal repo.

### Revisione indipendente (GPT-6.1 Sol High, subagente `council-sol`; Advisor disattivato)

Rilievi verificati e corretti: (1) writer che poteva produrre archivi rifiutati dal lettore (voci, dimensioni, rapporto) → stessi limiti in scrittura; (2) salvataggio senza istantanea coerente → clone sincrono dei metadati prima del primo `await`; (3) validazione insufficiente (zone incomplete, `slot.page` inesistente scoperti dopo il commit) → `checkFields()` completo anche per i vecchi JSON e risoluzione di ogni pagina prima del commit; (4) CRC del manifest ignorati per le risorse → confronto con il CRC dell'archivio; (5) U+FEFF nella prima cella perso → rimosso lo stripping doppio; (6) cache di anteprima non invalidate → chiave per caricamento; (7) intestazione locale non confrontata con la centrale → metodo, flag, CRC, dimensioni, disco, fine directory; (8) errori di chiusura dei vecchi file trattati come apertura fallita, task pdf.js non distrutto in errore → corretti; (9) memoria in apertura → file aperti in sequenza e budget di celle.

### Test eseguiti

- Automatici: `tests/archive.test.ts` (round-trip completo con CSV difficile, Excel con secondo foglio e intestazioni spente, progetto senza dati, CSV modificato, archivi non-progetto), `tests/zip.test.ts` e `tests/csv.test.ts` (scritti da subagenti TASK e ricontrollati: archivi ostili, limiti, isSafePath, tutti i casi CSV richiesti, TXT a colonna singola, intestazioni duplicate), `tests/project.test.ts` (v1/v2).
- Windows: archivio estratto con `Expand-Archive` e letto con `System.IO.Compression.ZipFile` (nomi, dimensioni, metodi corretti; originale identico; CSV con BOM e CRLF).
- Chromium da `file://`: PDF×2 + JPG + PNG + CSV con valori difficili + font Arial, pagine duplicate e riordinate, intervallo 2–3 → salva, ricarica, apri: composizione, zone, dati, font e intervallo identici; PDF rigenerato con testo e pagine identici (differenze solo nei metadati). Excel a due fogli (foglio 2, intestazioni spente), TXT a una colonna, progetto di sole immagini, vecchio v1 (dati del lavoro precedente azzerati, avviso, risalvato come `.dvp.zip`), ZIP troncato ed Excel rinominato in `.zip` (messaggi chiari, stato invariato).
- Firefox 159 da `file://`: carica, salva, ricarica, riapre (stato identico) e genera.

### Benchmark (Node 24, mediana di 3, sorgenti PDF 2,5 MB + JPEG + PNG 3,6 MB)

| Scenario | Sorgenti | JSON v2 | ZIP v3 | Salva v2 / v3 | Apri v2 / v3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Solo PDF | 2,49 MB | 3,34 MB | 2,49 MB | 8 / 15 ms | 16 / 12 ms |
| PDF + JPEG + PNG | 6,62 MB | 8,85 MB | 6,63 MB | 20 / 28 ms | 33 / 23 ms |
| + CSV 10.000×6 | 6,62 MB | 8,85 MB (senza dati) | 6,84 MB | 22 / 67 ms | 35 / 45 ms |
| + Excel 100.000×6 | 6,62 MB | 8,85 MB (senza dati) | 15,66 MB | 21 / 280 ms | 33 / 184 ms |

Senza dati lo ZIP è il 25 % più piccolo del JSON (niente base64, PDF/JPG/PNG in STORE). Con un Excel grande cresce perché contiene originale (7,9 MB) e CSV: è il costo dell'autosufficienza, non una duplicazione delle veline. Il CRC pesa 32–85 % del tempo d'apertura; i tempi restano sotto 0,3 s, nessun worker necessario.

### Limiti conosciuti

Progetto apribile fino a 512 MiB (letto in memoria); niente ZIP64; 5 milioni di celle; Excel che apre `dati-usati.csv` può trasformare `001234` in `1234` (documentato in LEGGIMI e README); un archivio ricompresso da strumenti che cambiano i nomi delle voci non si riapre (i percorsi sono quelli del manifest).

### Miglioramenti futuri

Salvataggio/apertura in un worker se compaiono progetti molto grandi; lettura dello ZIP da `File` a blocchi invece che intero in memoria; eventuale scelta "salva senza dati" se l'utente la chiederà.

---

## 2026-11-18: Generatori di dati senza database (numerazione, codici univoci, data/ora)

### Obiettivo

Creare 1.000 etichette con matricole, 5.000 ticket con codici univoci o 500 etichette con la data senza preparare un Excel, con valori riproducibili nelle ristampe. Tre generatori in un'unica architettura; `{#}` invariato; funziona con e senza database; persistenza nel `.dvp.zip`. Fuori ambito: formule, condizioni, imposizione, immagini variabili, export dei codici.

### Analisi iniziale

- `placeholders.ts`: un solo token speciale `{#}` (contatore della zona, `start + indiceAssoluto·step`), ogni altro `{X}` è una colonna (errore se assente); i nomi colonna accettano qualunque carattere tranne `{}`.
- `generate.ts` compila ogni zona una volta e risolve per indice assoluto; anteprima (thread UI, un record) e PDF (worker) costruiscono `Job` separati.
- Manifest `.dvp.zip` v3 validato in modo stretto: un campo nuovo in v3 verrebbe ignorato da un'app vecchia e perso al risalvataggio.
- Verificato da `file://` in Chromium: `isSecureContext`, `crypto.getRandomValues`, `crypto.subtle` disponibili; `Intl.formatToParts` con `Europe/Rome` identico in Chromium e Node 24.

### Council (council-opus = claude-opus-5-5 high, council-sol = gpt-6.1-sol high)

Due analisi indipendenti, un giro di revisione incrociata e un secondo giro mirato (consentito perché restava una divergenza sulla sicurezza dei codici). Sintesi permanente in `docs/FORMATO_PROGETTO.md` §9.

- **Proposte iniziali.** Opus: `{@Nome}` con errore di ambiguità e riscrittura alla rinomina; codici univoci con permutazione Feistel su dominio k^L e HMAC-SHA-256 scritto in casa (nessuno stato); manifest v4 solo se ci sono generatori; date con `Intl.formatToParts`; conferma esplicita alla modifica di una serie. Sol: `{{gen:ID}}` con nuovo tokenizer, escaping e migrazione del significato di `{{…}}`; codici casuali CSPRNG salvati come elenco nel progetto (`generatori/ID.txt`); manifest sempre v4; tzdb incorporata e versionata; blocco della serie e "Crea nuova serie".
- **Dopo la revisione incrociata.** Sol ritira la tzdb (si fermerebbe alla versione del rilascio) e accetta i preset di numerazione di Opus; Opus accetta "sempre v4" e il blocco dell'eliminazione; sulla modifica della serie si sono scambiati posizione (scelta: conferma con codici prima/dopo + "Nuova serie"). Restavano due divergenze.
- **Sintassi** — deciso `{@Nome}`: `{{…}}` cambierebbe il significato di contenuti esistenti (oggi `{{Nome}}` stampa graffe attorno al valore) e richiederebbe migrazione; `{@Nome}` si legge nel campo testo e il conflitto con una colonna `@Nome` diventa un errore esplicito. Sol l'ha accettata come compromesso.
- **Codici univoci** — sintesi del coordinatore, accettata da entrambi al secondo giro: l'elenco di Sol non è riproducibile se si aggiungono record senza risalvare; la Feistel di Opus è crittografia inventata (e con lunghezza 1 degenera in una traslazione, come ha mostrato Sol). Soluzione: **elenco deterministico da seme**, HMAC-SHA-256 in modalità contatore → rejection sampling → scarto dei duplicati; il record i è l'i-esimo codice distinto. Nessuno stato oltre alla chiave, stabilità per prefisso, nessuna costruzione crittografica nuova. Precisazioni recepite: alfabeto e lunghezza nel messaggio HMAC (separazione di dominio), specifica byte per byte e vettori golden, limite al 50 % della capacità, codici sempre generati da 0, HMAC da `@noble/hashes` (audit pubblici) con versione esatta.

### Architettura implementata

- `src/core/types.ts`: `NumberingGenerator`, `UniqueGenerator`, `DateTimeGenerator` (`DataGenerator`), tutti con `id`, `name`, `prefix`, `suffix`.
- `src/core/generators.ts`: `compileGenerators()` restituisce un `GeneratorSet` per job (compilazione pigra: un codice univoco costa solo se usato); `numberingBody()` (base biiettiva come le colonne di Excel, controllo di ogni intermedio come intero sicuro); `uniqueCodes()` con cache incrementale dei flussi (fino a 8 serie) così l'anteprima non ricalcola; `civilTime()`/`formatParts()` per le date; `generatorProblem()`/`nameProblem()` come unico validatore per pannello, salvataggio e apertura.
- `src/core/placeholders.ts`: `{#}` → `{@Nome}` → `{Colonna}`; `generatorToken()` e la stessa regex sono usati da compilazione, ricerca dei riferimenti e rinomina (un solo parser).
- `src/core/generate.ts`: `Job.generators` e `Job.now`; il `GeneratorSet` è condiviso da tutte le zone del job.
- `src/core/archive.ts`: manifest **versione 4** (`generators`), legge la 3; validazione completa in apertura **e** in salvataggio; LEGGIMI avvisa che il progetto contiene la chiave.
- Interfaccia: pannello "Generatori di dati" (`src/ui/generators-panel.ts`, colonna destra) con esempi, uso nelle zone, capacità e probabilità di indovinare un codice, conferme; chip verdi `@Nome` nel pannello zona; riepilogo di "Crea PDF" che blocca prima della generazione se un codice univoco non ha abbastanza combinazioni; `Job.now` preso al clic su "Crea PDF"; anteprima con istante di esempio fisso per la sessione (`state.previewNow`) ed etichetta esplicita.
- Nuova dipendenza: `@noble/hashes` 2.4.0 (sha256 + hmac, zero dipendenze, MIT), unica eccezione motivata alla regola "niente dipendenze" perché si tratta di crittografia.

### Revisione indipendente (GPT-6.1 Sol High, subagente `council-sol`; Advisor ancora disattivato)

Corretti: (alta) perdita di precisione nella numerazione "lettere + numero" con passi enormi → controllo di ogni intermedio; (alta) progetto con generatore non valido salvabile ma non riapribile → stesso validatore in salvataggio; (media) parser diversi fra compilazione e rinomina/riferimenti (`{ @Codice }`) → token condiviso; (media) alfabeti con emoji accettati ma indicizzati per unità UTF-16 → rifiutati; (media) fuso mancante interpretato come fuso del dispositivo → errore; (bassa) anni 0–99 → date fissate limitate a 1000–9999; cache fredda non verificata → `clearUniqueCache()` e test dedicato. Lasciato come limite documentato: la prima anteprima su un record molto alto calcola i codici fino a quel record nel thread UI (misurato 0,2 s per 100.000 codici; poi in cache).

### Test e prove

- `tests/generators.test.ts` e `tests/generators-integration.test.ts` (scritti da subagenti TASK e ricontrollati): sequenze numeriche, alfabetiche (Z→AA, ZZ→AAA), A001→A999→B001, passi, prefissi, intervalli parziali, errori di esaurimento e di precisione; codici univoci senza duplicati su 100.000, stabilità per prefisso e a cache fredda, separazione di dominio, capacità insufficiente, **vettori golden verificati indipendentemente con `crypto.subtle`**; date in tutti i formati, ora legale, mezzanotte, UTC/New York, modalità fissata; stesso codice su fronte, retro e QR; ristampe parziali; database + generatori; ambiguità con colonne `@X`; archivio v4/v3/v5, generatori malformati in apertura e in salvataggio.
- Chromium da `file://`: fronte + retro, 1.000 record senza dati, numerazione A001…, codice univoco, data; zone con i chip; PDF da 2.000 pagine (1,18 MB, 4,2 s) con 1.000 codici distinti, A001…A999, B001; salvataggio (3,6 KB), riapertura con esempi identici, ristampa 100–110 con testi identici alle pagine corrispondenti della tiratura completa.
- Firefox 159 da `file://` (playwright-core temporaneo fuori dal repo): CSV + numerazione + codice univoco, salva, riapri (esempi identici), genera.

### Prestazioni (Node 24)

| Prova | Tempo |
| --- | ---: |
| 10.000 codici univoci (8 caratteri, 31 simboli) | 33 ms |
| 100.000 codici univoci | 201 ms |
| 1.000 seriali A001… | 2 ms |
| 10.000 codici univoci + PDF da 10.000 pagine (test integrazione) | 6,1 s |
| Fronte/retro 5.000 record con database, numerazione, codice e QR (10.000 pagine, 5,5 MB) | 27,5 s (dominato dai QR, ~4 ms l'uno) |

### Limiti conosciuti

Unicità solo dentro una serie (non fra generatori o progetti); chi ha il progetto ha la chiave e quindi tutti i codici; codici facili da indovinare se le combinazioni sono poche (avviso nel pannello); al massimo metà delle combinazioni; la data "alla generazione" in una ristampa è quella della ristampa; i progetti con generatori richiedono questa versione dell'app; prima anteprima su un record alto ricalcola i codici fino a lì.

### Miglioramenti futuri

Anteprima in un worker persistente se servono serie oltre il milione; export dei codici in CSV (fuori ambito ora); opzione "riusa la data della prima generazione" per le ristampe, se richiesta.

---

## 2026-11-18: Riorganizzazione della colonna destra (Dati variabili, Generazione PDF, Risorse)

### Obiettivo

Solo interfaccia: la colonna destra aveva Dati / Generatori di dati / Crea PDF, con il numero di record manuale dentro "Dati", i font dentro "Crea PDF" e paragrafi descrittivi fissi (uno diceva che i generatori servono "senza file dati"). Nessun cambiamento a generatori, import, formato progetto o PDF.

### Nuova struttura

- **DATI VARIABILI**: sottosezione *Database* (vuota: "＋ Carica database" che riusa l'input `#in-data` della barra; caricata: nome, righe·colonne, Sostituisci, Rimuovi, foglio, intestazioni, anteprima alta 220 px) e *Generatori* (menu "＋ Nuovo generatore" con i tre tipi; schede con nome, tipo, zone che lo usano e primi valori visibili da chiuse; impostazioni ed eliminazione dentro).
- **GENERAZIONE PDF**: `Record da generare` (senza dati, modificabile) oppure `Record disponibili` (righe del database, sola lettura; `state.manualCount` resta in memoria e ricompare alla rimozione), Dal/Al record, riepilogo `N record × P pagine = T pagine PDF` (con l'intervallo parziale indicato), avanzamento e risultato. `Crea PDF` resta solo nella barra.
- **RISORSE**: Font aggiuntivi (lista, rimozione, "＋ Carica font").
- Sezioni comprimibili (`src/ui/sections.ts`): intestazione = pulsante con `aria-expanded`/`aria-controls`, corpo `role=region`; stato in `localStorage` (predefinito aperta/aperta/chiusa), non nel progetto. A sezione chiusa l'intestazione mostra un riassunto (righe, generatori, pagine, font) e un ⚠ se c'è un problema (generatore non valido, riepilogo in errore), letto anche dagli screen reader. La generazione riapre la sezione per mostrare avanzamento, risultato o errore.
- Testi lunghi sostituiti da pulsanti ⓘ con tooltip CSS (hover e focus, raggiungibili col puntatore, Escape li chiude, `aria-label` con il testo). Etichette delle select accorciate per stare in 272 px (i caratteri esatti dei codici nel tooltip della select).
- Larghezza colonna `clamp(272px, 26vw, 360px)`: a 960 px la zona centrale passa da 300 a 388 px.

### Verifiche

- `npm test` 143/143, `npm run build` ok.
- Chromium da `file://` (1600, 1200, 960 px, screenshot prima/dopo): stati nessun dato/nessun generatore, solo generatori (250 record manuali), database + generatori, intervallo 11–20, rimozione del database (torna 250, generatori intatti), avviso su sezione chiusa con codice da 1 carattere, apertura/chiusura da tastiera (Invio, Spazio), preferenza ricordata dopo ricarica, esclusione/inclusione del retro (riepilogo 120 ↔ 240 pagine), font caricato, salvataggio e riapertura (stessi esempi, database, font, "Record disponibili"), generazione con sezione chiusa (si riapre), nessuno scorrimento orizzontale della colonna.
- Firefox da `file://` con lo stesso flusso: tutto ok, nessun errore.
- Revisione indipendente GPT-6.1 Sol High (sola lettura). Corretti: conteggio record non aggiornato se i dati cambiano durante una generazione (ora `syncControls()` aggiorna riga record e limiti senza staccare avanzamento/risultato, verificato caricando un CSV durante una generazione di 8.000 pagine); risultato/errore nascosto se la sezione viene chiusa durante il lavoro (riapertura a fine lavoro); errori dei generatori troncati (ora vanno a capo); tooltip non raggiungibili col puntatore e non chiudibili (corretti); testo sui font impreciso per gli OTF CFF (corretto).

### Problemi preesistenti segnalati, non modificati (ora nel backlog di AGENTS.md, in quest'ordine)

1. Il riepilogo controlla la capacità dei generatori su tutte le zone, la generazione solo su quelle delle pagine attive: un generatore usato solo su una pagina esclusa può dare un falso errore nel riepilogo. **Priorità alta.**
2. Pulsanti "Velina", "Dati" e "Apri progetto" della barra sono `<label>` con input nascosto: non raggiungibili con Tab.
3. A finestre strette (≈ 960 px) la barra sopra l'anteprima (pagina, record, zoom) è compressa.

### Pubblicazione

Push di `9160c89` autorizzato; workflow Pages 44274059880 riuscito (build e deploy). Smoke test sul sito pubblicato (Chromium): sezioni iniziali aperta/aperta/chiusa, 30 record manuali + 3 generatori, CSV da 60 righe ("Record disponibili"), zone su fronte e retro, font, salvataggio e riapertura (stessi esempi, database, font, 3 zone), rimozione del database (tornano 30 record, generatori intatti), PDF da 120 pagine con 60 codici distinti uguali su fronte e retro; nessun errore in console, nessuno scorrimento orizzontale.

---

## 2026-11-18: Terminologia più semplice: "Grafica" al posto di "velina" nell'interfaccia

Richiesta dell'utente: un linguaggio comprensibile anche da chi non conosce ProXDATA o il gergo di stampa. Nei testi per l'utente ora si dice **Grafica** (pulsante della barra, suggerimento del trascinamento), **file grafico** (messaggi, riepilogo, pannello Pagine per record, LEGGIMI dell'archivio) e **pagina grafica** (menu della pagina, guida iniziale). Il pulsante della barra ha un tooltip sintetico: "Carica uno o più file PDF, JPG o PNG da utilizzare come base grafica del documento. Le pagine vengono ripetute per ogni record".

"Velina" resta il termine tecnico: nomi interni (`Velina` come nome della risorsa XObject, `embedTemplatePages`…), commenti, documentazione architetturale, e la cartella `veline/` dell'archivio, che non cambia per compatibilità con i progetti salvati. Nel README la sezione sulla leggerezza del PDF spiega il termine ("nel gergo tipografico la *velina*"). Nessuna modifica a logica, formato o layout; convenzione registrata in AGENTS.md. Test 143/143, build ok, controllo in Chromium: nessuna occorrenza di "velina" visibile nell'interfaccia vuota e con un file caricato.
