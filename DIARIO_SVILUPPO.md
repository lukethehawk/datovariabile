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
