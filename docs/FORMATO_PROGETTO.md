# Formato del progetto DatoVariabile (`.dvp.zip`, versione 4)

Specifica sufficiente per scrivere un lettore o uno scrittore compatibile. Implementazione di riferimento: `src/core/archive.ts` (progetto), `src/core/zip.ts` (contenitore), `src/core/data.ts` (`writeProjectCsv`/`parseProjectCsv`), `src/core/project.ts` (lettura dei vecchi `.dvp.json` v1/v2). Il perché delle scelte è in fondo e in `DIARIO_SVILUPPO.md`.

## 1. Contenitore

- ZIP standard (PKWARE APPNOTE), profilo ristretto: **ZIP32, disco singolo, metodi 0 (STORE) e 8 (DEFLATE), nessuna cifratura, nessuno ZIP64**. Nessun data descriptor in scrittura (le dimensioni sono nell'intestazione locale).
- Nomi delle voci: percorsi relativi con `/`, generati in ASCII (bit 11 UTF-8 impostato solo se un nome non è ASCII). Nessuna voce di cartella.
- STORE per i file già compressi (`.pdf .jpg .jpeg .png .xlsx .xlsm .xlsb .ods .zip`), DEFLATE per gli altri, mantenuto solo se riduce la dimensione.
- Estensione consigliata `NomeProgetto.dvp.zip`; il formato si riconosce dal contenuto (firma `PK\x03\x04` o `PK\x05\x06`, poi la presenza di `progetto.json`).

## 2. Struttura

```text
progetto.json                 manifest (obbligatorio, prima voce)
LEGGIMI.txt                   spiegazione per chi apre lo ZIP a mano (ignorato in lettura)
veline/01-fronte.pdf          un file per sorgente grafica, byte identici all'originale
veline/02-retro.jpg
dati/originale-clienti.xlsx   file dati originale, byte identici (solo se c'è un database)
dati/dati-usati.csv           tabella importata, autorevole (solo se c'è un database)
font/01-Mio_Font.ttf          font caricati, byte identici
```

Nomi dei file: prefisso progressivo a 2+ cifre (unicità anche su Windows, che non distingue le maiuscole) + nome originale ridotto ad ASCII (NFD senza accenti, caratteri diversi da `A-Za-z0-9._-` → `_`, massimo 60 caratteri). Il nome originale completo resta nel manifest. **Un lettore non deve dedurre nulla dal nome della voce**: usa solo i riferimenti del manifest.

## 3. Manifest `progetto.json` (UTF-8, JSON)

```ts
interface FileRef { path: string; size: number; crc32: number }   // size = byte non compressi

interface ProjectManifest {
  app: 'DatoVariabile';
  version: 4;                                       // 3 = stesso formato senza `generators` (ancora letto)
  savedAt: string;                                  // ISO 8601, informativo
  sources: Array<{ id: string; name: string; kind: 'pdf' | 'jpeg' | 'png'; file: FileRef }>;
  slots: Slot[];                                    // composizione, in ordine (vedi src/core/types.ts)
  fields: Field[];                                  // zone; Field.slot = id di uno slot
  fonts: Array<{ name: string; file: FileRef }>;    // name = nome usato da TextField.font
  manualCount: number;                              // record da generare senza database
  range: { from: string; to: string };              // intervallo di record come digitato, "" = tutti
  data: null | {
    name: string;                                   // nome originale del file dati
    original: FileRef;                              // dati/originale-…
    table: FileRef & { rows: number; width: number };  // dati/dati-usati.csv: righe, celle della riga più lunga
    sheets: string[]; sheet: string;                // fogli del file Excel e foglio usato ("" per CSV/TXT)
    header: boolean;                                // prima riga = intestazioni
    headerGuess: boolean;                           // suggerimento dell'importatore (riusato se si cambia foglio)
    columns: string[];                              // nomi effettivi delle colonne usati da {Colonna}
  };
  generators: DataGenerator[];                      // generatori di dati {@Nome}, vedi §8 (assente nella versione 3)
}
```

- `Slot = { id, sourceId, page, enabled, raster? }`, `RasterLayout = { size: 'image'|'A3'|'A4'|'A5'|'custom', width, height, orientation: 'auto'|'portrait'|'landscape', fit: 'contain'|'cover'|'stretch', dpi: number|null }`. Coordinate delle zone in punti PDF, origine in alto a sinistra della pagina visualizzata (AGENTS.md, invariante 2).
- Ogni `FileRef.path` deve essere relativo e sicuro (niente `..`, `/` iniziale, `\`, `:`, caratteri di controllo), presente nell'archivio e usato da un solo riferimento. `size` e `crc32` del manifest devono coincidere con quelli della voce ZIP (eccezione: `dati/dati-usati.csv`, vedi §4). Le sorgenti non usate da nessuno slot vengono salvate comunque (fanno parte del lavoro).
- Le zone sono validate per intero prima di applicare il progetto (tipo, posizione, rotazione, colore, contatore, font esistente fra standard e `fonts`, simbologia nota); ogni slot deve puntare a una pagina esistente della sua sorgente.
- `version` 3 si legge come 4 con `generators: []`; `version` maggiore di 4 → il lettore deve rifiutare ("formato più recente"). Lo scrittore produce sempre la 4: un'app che conosce solo la 3 rifiuta i progetti nuovi invece di perdere i generatori risalvandoli.

## 4. Tabella dati `dati/dati-usati.csv`

Contiene **le celle importate così come le usa l'applicazione** (`RawTable.cells`), riga di intestazione inclusa se presente nel file, **tutte le righe** (non solo l'intervallo: il contatore usa l'indice assoluto del record).

- Codifica UTF-8 **con BOM**; separatore `;`; ogni riga termina con CRLF.
- Una cella è racchiusa tra virgolette solo se contiene `;`, `"`, CR o LF; le virgolette interne sono raddoppiate. Una riga composta da una sola cella vuota si scrive `""`.
- Le righe **non sono rettangolarizzate**: ogni riga ha il proprio numero di celle (così `["a"]` e `["a",""]` restano distinte: `a` e `a;`).
- Righe completamente vuote non esistono (l'importatore le scarta).
- Lettura: parser rigoroso (UTF-8 obbligatorio, `;` fisso, nessun riconoscimento automatico, nessun trim, errore per virgolette non chiuse o testo dopo la virgoletta di chiusura).

Regole di ripristino (in quest'ordine):

1. Se CRC-32 e dimensione della voce coincidono con `data.table` del manifest: le celle lette sono autorevoli; devono valere `rows`, `width` e `columns.length === width`, altrimenti il progetto è danneggiato. I nomi di colonna sono `data.columns` **senza ricalcolo**; i record sono `header ? celle.slice(1) : celle`.
2. Se il CSV è diverso (modificato fuori dall'applicazione e ZIP ricreato): si usano comunque i dati modificati (parser rigoroso, altrimenti lettura tollerante come un nuovo CSV), i nomi di colonna vengono ricalcolati con le regole d'importazione (vuote → lettera, duplicate → `_2`) e l'utente riceve un avviso esplicito.
3. Il file originale non viene mai rianalizzato all'apertura; serve per estrarlo a mano e per cambiare foglio Excel dopo la riapertura.

## 5. Lettura sicura (l'archivio è input non attendibile)

Ordine di validazione: EOCD (l'ultima firma il cui commento arriva esattamente a fine file) → directory centrale → per ogni voce l'intestazione locale (stesso nome, dati entro l'inizio della directory centrale) → nessuna sovrapposizione fra voci → manifest → riferimenti → estrazione delle sole voci richieste.

Rifiuti: cifratura (bit 0 o 6), metodi diversi da 0/8, ZIP64 (valori `0xFFFF`/`0xFFFFFFFF`), più dischi, nomi duplicati anche solo per maiuscole, nomi non UTF-8 validi con bit 11, STORE con dimensioni compressa/non compressa diverse.

Limiti (`ZIP_LIMITS`): archivio 512 MiB (letto in memoria), 1000 voci, singola voce 512 MiB, totale decompresso 1 GiB, espansione massima `max(1 MiB, 1000 × compressa)`, `progetto.json` 4 MiB, tabella dati 5 milioni di celle (`MAX_PROJECT_CELLS`). **Gli stessi limiti valgono in scrittura** (DEFLATE scartato a favore di STORE se violerebbe il rapporto), così ogni progetto salvato si riapre. La decompressione scrive in un buffer della dimensione dichiarata e si interrompe appena la supera; poi verifica dimensione esatta e CRC-32. L'intestazione locale deve coincidere con la centrale (nome, metodo, cifratura, CRC e dimensioni salvo data descriptor) e la directory centrale deve essere consumata esattamente.

Apertura tutto-o-niente: si prepara il nuovo progetto completo (file letti, PDF aperti) e solo alla fine si sostituisce lo stato; in caso di errore il lavoro corrente resta intatto. Dati e intervallo del lavoro precedente non sopravvivono mai all'apertura di un progetto.

## 6. Versioni precedenti

| Versione | File | Contenuto | In lettura |
| --- | --- | --- | --- |
| 1 | `.dvp.json` | una velina PDF in base64, `pagesSpec`, zone con `page` | migrata: velina → sorgente, `pagesSpec` → slot (zona copiata per ogni occorrenza della sua pagina, pagine escluse con zone → slot disabilitati) |
| 2 | `.dvp.json` | sorgenti in base64, slot, zone con `slot`, font, `manualCount` | letta così com'è |
| 3 | `.dvp.zip` | come la 4 ma senza `generators` (2026-11-16) | letta con `generators: []` |
| 4 | `.dvp.zip` | questo documento | formato scritto da "Salva progetto" |

v1/v2 non contenevano i dati: dopo l'apertura database e intervallo sono vuoti e, se le zone usano colonne, l'utente riceve l'invito a caricare il file dati e salvare di nuovo (diventa v4). Un `progetto.json` v3/v4 aperto da solo (estratto dallo ZIP) viene rifiutato: i suoi file sono riferimenti.

## 7. Decisioni (Council Opus 5.5 High + GPT-6.1 Sol High, 2026-11-16)

- **ZIP scritto in casa** invece di fflate/pako/CFB di SheetJS: anche con una libreria il validatore (directory centrale, intestazioni, duplicati, limiti, CRC) andrebbe scritto comunque; deflate/inflate sono già nel browser (`CompressionStream('deflate-raw')`), nessuna dipendenza, funziona da `file://`. CFB di SheetJS scartato (CRC disabilitato, nomi ASCII mascherati, file vuoti saltati).
- **CSV autorevole con celle grezze** (proposta Opus, accettata da Sol dopo la revisione incrociata) invece di uno snapshot JSON separato: un solo file, leggibile, senza due fonti che possano divergere; le colonne effettive vengono dal manifest per non dipendere da future versioni di `toDataSet()`.
- **Originale mai rianalizzato all'apertura** (concordi): aggiornamenti di SheetJS o dell'euristica del separatore non devono cambiare i valori di un lavoro salvato.
- **CSV modificato a mano**: usato con avviso (proposta Opus) invece di rifiutarlo; il caso peggiore sarebbe ignorare in silenzio una modifica voluta.
- **Virgolette solo quando servono** (Opus) invece che sempre (Sol): CSV più leggibile, round-trip identico.
- **Impostazioni d'importazione non salvate oltre foglio/intestazioni** (Opus): codifica e separatore dell'originale servirebbero solo a rianalizzarlo, cosa che non avviene.
- **Vecchi JSON: dati e intervallo azzerati** (Sol, accettato da Opus): tenere i dati del lavoro precedente con colonne compatibili produrrebbe un PDF sbagliato senza errori.
- **Limiti**: compromesso fra le due proposte (Sol 256/512 MiB, Opus 1/1,5 GiB): 512 MiB di archivio perché viene letto interamente in memoria insieme alle copie estratte.

## 8. Generatori di dati (`generators`, dalla versione 4)

Un generatore produce **un valore per record**, funzione pura di impostazioni e indice assoluto del record `i` (0 = primo record; con un database è la riga, senza è il numero manuale), più l'istante `now` per le date "alla generazione". Tutte le zone che scrivono `{@Nome}` ricevono lo stesso valore. Implementazione: `src/core/generators.ts`.

```ts
interface Base { id: string; name: string; prefix: string; suffix: string }   // valore = prefix + corpo + suffix
type DataGenerator =
  | Base & { type: 'numbering'; style: 'number' | 'letters' | 'lettersNumber'; start: number; step: number; digits: number;
             alphabet: string; groupStart: string; numberMin: number; numberMax: number; overflow: 'grow' | 'error' }
  | Base & { type: 'unique'; algorithm: 'hmac-sha256-ctr-v1'; key: string /* 64 hex */; alphabet: string; length: number }
  | Base & { type: 'datetime'; mode: 'job' | 'fixed'; timeZone: string /* IANA */; fixed: string /* YYYY-MM-DDTHH:mm */;
             format: 'dd/MM/yyyy' | 'dd-MM-yyyy' | 'dd/MM/yy' | 'dd/MM/yyyy HH:mm' | 'HH:mm' | 'yyyy-MM-dd' | 'yyyy-MM-dd HH:mm' };
```

**Sintassi nelle zone.** `{#}` = contatore della zona (invariato); `{@Nome}` = generatore (nome confrontato senza distinguere maiuscole); `{X}` = colonna. Se nessun generatore si chiama `Nome`, `{@Nome}` cerca una colonna letteralmente chiamata `@Nome` (compatibilità con i progetti precedenti); se esistono entrambi la generazione si ferma con errore. Rinominare un generatore riscrive `{@vecchio}` → `{@nuovo}` in tutte le zone. Nomi: non vuoti, senza spazi ai bordi, senza `{}`, max 40 caratteri, unici.

**Numerazione.** Con `lettersOf(o)` = numerale biiettivo in base k = |alphabet| (1 → A, k → Z, k+1 → AA, come le colonne di Excel) e `ordinalOf` la sua inversa:
- `number`: `pad(start + i·step, digits)`; numero negativo o non intero sicuro → errore.
- `letters`: `lettersOf(ordinalOf(groupStart) + i·step)` (`start` non usato).
- `lettersNumber`: `R = numberMax − numberMin + 1`, `t = start − numberMin + i·step`, `q = ⌊t/R⌋`; corpo = `lettersOf(ordinalOf(groupStart) + q)` + `pad(numberMin + t − q·R, digits)` (A001…A999, B001). Vincoli: `numberMin ≤ start ≤ numberMax`, `step ≠ 0`.
- Gruppo con ordinale < 1 → errore. `overflow: 'error'`: se le lettere diventano più lunghe di `groupStart` → errore "numerazione esaurita"; `'grow'` → Z999 → AA001.
- `pad` = zeri a sinistra fino a `digits`, mai troncamento.
- Esempi: FT-000001 = `number`, prefix `FT-`, digits 6; PROD-A0001 = `lettersNumber`, prefix `PROD-`, numberMin 1, numberMax 9999, digits 4.

**Codici univoci, algoritmo `hmac-sha256-ctr-v1` (congelato: cambiarlo cambia i codici già stampati).**
1. `block_c = HMAC-SHA-256(key, "DVP-U1" ‖ 0x00 ‖ UTF-8(alphabet) ‖ 0x00 ‖ u32be(length) ‖ u64be(c))`, c = 0, 1, 2, …; la chiave è la stringa esadecimale decodificata (32 byte).
2. I byte dei blocchi consecutivi formano un unico flusso. Con k = |alphabet| (2–64, caratteri ASCII distinti) un byte b si usa solo se `b < 256 − (256 mod k)` e dà `alphabet[b mod k]` (nessuna distorsione statistica); altrimenti si scarta.
3. Ogni `length` caratteri accettati formano un candidato; i candidati già visti si scartano. Il codice del record i è l'i-esimo candidato distinto. Per stampare il record i si generano quindi i codici 0…i (anche in una ristampa parziale): aggiungere record non cambia quelli esistenti e non si salva nessun elenco.
4. Limite: record ≤ ⌊k^length × 0,5⌋ (oltre, l'estrazione di codici distinti rallenta molto); controllato prima della generazione.
5. Vettori di prova: chiave `00`×32, alfabeto `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, lunghezza 8 → `2U3CG6NN`, `8W59DPFZ`, `2PMMGWXV`, `G9X2RM5M`, `YM5TUX7T`; chiave `ab`×32, alfabeto `0123456789`, lunghezza 6 → `609265`, `635638`, `033089`, `585252`, `968400`.

Sicurezza: unicità garantita solo **dentro una serie** (stesso generatore); nessuna garanzia fra generatori, progetti o copie dello stesso progetto. Chi possiede il progetto conosce la chiave e quindi tutti i codici; chi vede solo alcuni codici non può ricavare gli altri senza la chiave (HMAC-SHA-256 come funzione pseudo-casuale). L'interfaccia mostra combinazioni e probabilità di indovinare un codice con un tentativo (`combinazioni / record`) e avvisa sotto 1 su 1.000.000.

**Data/Ora.** `job`: l'istante è preso una volta all'avvio della generazione (`Job.now`) e uguale su tutte le pagine; i componenti si leggono con `Intl.DateTimeFormat('en-US', {timeZone, calendar:'gregory', numberingSystem:'latn', hourCycle:'h23', …}).formatToParts()` e la stringa è composta dall'app (separatori fissi, mai quelli della lingua del browser). `fixed`: ora civile salvata e formattata così com'è, senza fuso. L'anteprima mostra un istante di esempio fisso per la sessione. Una ristampa in modalità `job` ha la data della ristampa.

## 9. Decisioni sui generatori (Council Opus 5.5 High + GPT-6.1 Sol High, 2026-11-18)

- **Generatori nominati e riutilizzabili** (preferenza dell'utente, confermata da entrambi): un valore per record condiviso, diverso da `{#}` che resta per zona.
- **Sintassi `{@Nome}`** (Opus) invece di `{{Nome}}` con nuovo tokenizer (Sol): nessuna migrazione del significato di `{{…}}` nei progetti esistenti, leggibile nel campo di testo; il conflitto con una colonna `@Nome` è rilevato con errore esplicito. Sol l'ha accettata come compromesso, notando che non è una sintassi senza conflitti per costruzione.
- **Codici univoci "elenco deterministico da seme"** (sintesi del coordinatore, accettata da entrambi al secondo giro): Sol proponeva un elenco CSPRNG salvato nel progetto (ma estensioni non salvate non sarebbero riproducibili), Opus una permutazione Feistel con HMAC scritto in casa (nessuno stato, ma crittografia proprietaria e debole su domini piccoli). Il flusso HMAC in modalità contatore con scarto dei duplicati prende il meglio di entrambe: nessuno stato oltre alla chiave, stabilità per prefisso, nessuna costruzione crittografica inventata; HMAC da `@noble/hashes` (libreria con audit pubblici, versione fissata).
- **Manifest sempre versione 4** (Sol; Opus proponeva la 4 solo con generatori, poi ha accettato).
- **Fusi orari con `Intl`** (Opus) invece di una tzdb incorporata (Sol, poi ritirata): la tzdb incorporata invecchierebbe con il rilascio; Chromium e Node danno componenti identici per Europe/Rome.
- **Modifica di alfabeto/lunghezza di un codice usato**: conferma esplicita con codici prima/dopo; "Nuova serie" crea una nuova chiave. Eliminazione bloccata finché il generatore è usato.
