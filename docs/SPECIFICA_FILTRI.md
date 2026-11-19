# DatoVariabile — Specifica tecnica dei filtri e del formato v5

**Stato:** specifica tecnica **definitivamente approvata** da Luca il 19/11/2026; riferimento per l'implementazione (sviluppo autorizzato).
**Data:** 19 novembre 2026
**Progetto:** https://github.com/lukethehawk/datovariabile (base: commit `1aa2f52`)
**Origine:** proposta di Luca (18/11/2026), valutata dal Council OMP (Claude Opus 5.5 High e GPT-6.1 Sol High) in sette giri: analisi indipendenti, revisione incrociata, sintesi mirate, rivalutazione senza progetti da preservare, verifica dei punti 4 e 5. Decisioni di prodotto confermate da Luca il 19/11/2026. Verbali: sessione OMP `local://council4/`.

> Il **codice del repository** prevale su questa specifica solo per i fatti esistenti (nomi di file, funzioni). Per comportamento, sintassi e formato **prevale questa specifica**. Qualsiasi deviazione va segnalata prima di implementarla.

---

## 1. Scopo

Trasformare il valore di un segnaposto direttamente nella zona (testo, QR, DataMatrix, codice a barre) senza modificare il database e senza creare generatori derivati.

Caso principale: un'etichetta con un **DataMatrix con il codice completo** e, accanto, un testo con **le ultime quattro cifre dello stesso codice**.

| Zona | Contenuto | Valore (generatore `@Codice` = `FT2026A001234`) |
| --- | --- | --- |
| DataMatrix | `{@Codice}` | `FT2026A001234` |
| Testo | `{@Codice\|right:4}` | `1234` |
| Testo, solo cifre | `{@Codice\|digits\|right:4}` | `1234` |

Con `AB12CD34`: `right:4` → `CD34`, `digits|right:4` → `1234`.

## 2. Principi

1. **Un solo motore** per testo, QR, DataMatrix e codici a barre: stesso parser, stesso compilatore, stesso risultato.
2. **Compilazione una volta per zona**; per ogni record solo funzioni testo → testo e concatenazione.
3. **Tutto è testo**: nessuna conversione numerica implicita, gli zeri iniziali non si perdono.
4. **I filtri valgono solo dove sono scritti**: `{@Codice}` resta completo anche se un'altra zona usa `{@Codice|right:4}`.
5. **Sorgenti intatte**: i filtri non modificano dati, generatori, chiavi HMAC, indice assoluto o `Job.now`. Anteprima, PDF, ristampa parziale e riapertura danno lo stesso risultato per lo stesso record (salvo la data "alla creazione del PDF", come oggi).
6. **Errori espliciti**, mai risultati silenziosamente diversi.
7. **Nessuna compatibilità con i formati sperimentali**: nessuna migrazione, nessun convertitore.
8. **Sicurezza**: nessun `eval`/`new Function`, nessuna regex scritta dall'utente, nessuna interpretazione del valore ottenuto come nuova formula, valori sempre inseriti come testo (mai HTML).

## 3. Formato del progetto: `.dvp.zip` versione 5

- La **versione 5 è il primo formato stabile** e l'unico letto e scritto. Contenitore, manifest e controlli restano quelli attuali (vedi `docs/FORMATO_PROGETTO.md`), con `version: 5` e il nuovo significato del campo `content` delle zone (questa specifica).
- Apertura:
  - `version` uguale a 5 → letto;
  - `version` > 5 → `Progetto in un formato più recente (versione N): aggiorna DatoVariabile`;
  - qualsiasi altra versione (1–4, sperimentali) → `Progetto in un formato non supportato (versione N)`; **senza** il prefisso "Progetto danneggiato o incompleto";
  - file non ZIP (es. vecchi `.dvp.json`) → `Non è un progetto DatoVariabile (.dvp.zip)`;
  - il riconoscimento di un foglio di calcolo aperto per errore come progetto resta.
- `content` resta una **stringa libera**: un progetto con formule incomplete o errate si salva e si riapre (la generazione lo segnala). Restano integri tutti gli altri controlli (struttura, limiti ZIP, CRC, generatori, unicità dei nomi).

## 4. Sintassi del contenuto di una zona

### 4.1 Testo libero e graffe

- Ogni carattere è letterale **tranne `{` e `}`**.
- Una graffa letterale si scrive **raddoppiata**: `{{` produce `{`, `}}` produce `}`.
- Il backslash nel testo libero è un carattere normale (`C:\Stampa` resta com'è).
- `{` apre un segnaposto, che termina alla prima `}` **fuori dalle virgolette**.

| Contenuto | Risultato |
| --- | --- |
| `Lotto {Lotto}` | `Lotto ` + valore |
| `{{Nome}}` | `{Nome}` (testo) |
| `{{{Nome}}}` | `{` + valore + `}` |
| `{A}}}` | valore + `}` |
| `{{"id":"{Codice}"}}` | `{"id":"` + valore + `"}` (JSON in un QR) |
| `Sconto :-}` | **errore**: graffa di chiusura isolata |
| `{promo` | **errore**: graffa non chiusa |

Errori lessicali (con posizione e suggerimento):

- graffa aperta e mai chiusa: `graffa non chiusa al carattere N (per una graffa letterale scrivi {{)`;
- `}` isolata nel testo: `graffa di chiusura isolata al carattere N (per una graffa letterale scrivi }})`;
- segnaposto vuoto `{}` o `{ }`: `segnaposto vuoto al carattere N`;
- `{` dentro un segnaposto, fuori dalle virgolette: `graffa non ammessa dentro il segnaposto al carattere N`;
- virgolette non chiuse: `virgolette non chiuse al carattere N`.

Le posizioni sono conservate internamente in unità UTF-16 (per selezionare il punto nel campo) e mostrate all'utente in caratteri (code point) a partire da 1.

> Raddoppiare le graffe rende il contenuto leggibile dal parser, ma **non** rende sicuro un JSON se il valore inserito contiene virgolette o backslash: servirà il filtro futuro `json` (§12).

### 4.2 Grammatica del segnaposto

```ebnf
segnaposto = "{", ws, sorgente, { ws, "|", ws, filtro }, ws, "}" ;
sorgente   = "#" | "@", ws, nudo | nudo | stringa ;
filtro     = ident, { ws, ":", ws, argomento } ;
argomento  = intero | stringa | carattere ;

nudo       = carattere-nome, { carattere-nome } ;    (* con trim; vedi regole *)
stringa    = stringa JSON tra doppi apici ;           (* escape JSON completi *)
ident      = lettera-ASCII, { lettera-ASCII | cifra-ASCII } ;
intero     = cifra-ASCII, { cifra-ASCII } ;           (* senza segno, decimali o esponente *)
carattere  = una sola lettera o cifra ASCII, senza apici ;
ws         = { spazio | tab } ;
```

Regole del **nome nudo** (`nudo`), unica e condivisa da parser, serializzatore e controllo dei nomi dei generatori:

- almeno un carattere dopo aver tolto gli spazi ai bordi;
- non contiene `{`, `}`, `|`, `"` né caratteri di controllo (C0, C1, a capo, tab);
- non inizia con `@` né con `#`;
- sono ammessi spazi interni, `:`, `,`, `[`, `]`, `(`, `)`, `-`, `.`, `/`, `€`, lettere accentate e ogni altro carattere.

Esempi validi senza virgolette: `{Prezzo, €}`, `{Cognome, Nome}`, `{Peso [kg]|upper}`, `{Codice articolo}`.

**Sorgenti:**

| Scrittura | Significato |
| --- | --- |
| `{#}` | contatore della zona (invariato: `start + indice × step`, cifre della zona) |
| `{@Nome}` | **solo** generatore, nome confrontato senza maiuscole/minuscole; spazi attorno ignorati (`{ @Lotto }` = `{@Lotto}`) |
| `{Nome}` | colonna, confronto **esatto** (maiuscole comprese) |
| `{"…"}` | colonna con il nome scritto come stringa JSON: obbligatorio per nomi che non sono nudi validi |

Esempi di colonne tra virgolette: `{"#"}`, `{"#Lotto"}`, `{"@Nome"}`, `{"Codice|right:4"}`, `{"Peso {kg}"}`, `{"Codice\narticolo"}` (intestazione Excel con a capo), `{" spazi "}`.

Non esiste più il ripiego di `{@Nome}` su una colonna chiamata `@Nome`, né l'errore di conflitto: una colonna `@Nome` si scrive `{"@Nome"}`. `{@"X"}` è un errore (`i nomi dei generatori non vanno tra virgolette`).

**Filtri e argomenti:**

- I nomi dei filtri sono in inglese e senza distinzione tra maiuscole e minuscole (`RIGHT` = `right`).
- Ogni filtro ha un numero fisso di argomenti e un tipo per ciascuno (§5). Il parser conserva il testo dell'argomento; il controllo lo interpreta secondo il filtro. In `padleft:6:0` il `6` è un numero, lo `0` è il carattere `"0"`.
- Argomenti numerici: solo `intero`. Argomenti di testo: `stringa` (ogni carattere) oppure `carattere` (una sola lettera o cifra ASCII senza apici). Una stringa vuota si scrive `""`.
- Dentro le stringhe `{`, `}`, `|`, `:` sono caratteri normali: `{Codice|prefix:"{"}` è valido.
- Escape JSON: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`; altri escape → errore.
- Spazi e tab attorno a `|` e `:` sono ignorati; dentro le stringhe sono conservati.

### 4.3 Nomi dei generatori

`nameProblem` (pannello e archivio) accetta un nome se: non è vuoto, ha al massimo 40 caratteri ed è un **nome nudo valido** (§4.2). Quindi `{@Nome}` non richiede mai virgolette. Unicità senza maiuscole/minuscole e tutti gli altri controlli dei generatori restano invariati.

### 4.4 Serializzatore dei nomi

Un'unica funzione scrive il riferimento a una colonna: il nome così com'è se è un nudo valido, altrimenti `JSON.stringify(nome)`. La usano tutti i punti che inseriscono segnaposto: chip delle colonne, suggerimento sulle intestazioni della tabella dati (`data-panel.ts`), contenuto iniziale delle zone nuove (`state.ts`), dialogo ƒx. Proprietà garantita dai test: `parse(serializza(n))` restituisce `n` per ogni nome.

## 5. I 13 filtri della prima versione

Notazione: `N` intero; `T` testo (stringa o carattere); "vuoto" = stringa `""` esatta **all'ingresso del filtro** (gli spazi non sono vuoto).

| Filtro | Etichetta italiana (ƒx) | Argomenti | Comportamento |
| --- | --- | --- | --- |
| `left:N` | Primi caratteri | N ≥ 0 | primi N caratteri; N = 0 → `""`; N oltre la lunghezza → tutto |
| `right:N` | Ultimi caratteri | N ≥ 0 | ultimi N caratteri; N = 0 → `""` (attenzione: `slice(-0)` va evitato); N oltre → tutto |
| `mid:S:N` | Caratteri da una posizione | S ≥ 1, N ≥ 0 | N caratteri dalla posizione S (base 1); S = 0 → errore; S oltre la fine → `""`; N oltre la fine → i caratteri disponibili |
| `digits` | Solo cifre | — | conserva solo `0`–`9` ASCII, nell'ordine; nessuna cifra → `""` |
| `upper` | Tutto maiuscolo | — | `toUpperCase()`, mai dipendente dalla lingua del dispositivo; può cambiare la lunghezza (`ß` → `SS`) |
| `lower` | Tutto minuscolo | — | `toLowerCase()`, idem |
| `trim` | Togli spazi ai bordi | — | `String.prototype.trim` (spazi, tab, a capo, spazio non separabile U+00A0, BOM, …) |
| `nospace` | Togli tutti gli spazi | — | rimuove ovunque lo stesso insieme di caratteri di `trim`; non rimuove U+200B né punteggiatura |
| `replace:T:T` | Sostituisci testo | cerca non vuoto, metti | sostituisce **tutte** le occorrenze, letterale, sensibile a maiuscole/minuscole, da sinistra, senza sovrapposizioni né ricorsione; le sequenze `$&`, `$1`, ecc. **non** hanno significato speciale; cerca vuoto → errore |
| `prefix:T` | Aggiungi testo prima | testo | antepone il testo; **vuoto → resta vuoto** (§6.1) |
| `suffix:T` | Aggiungi testo dopo | testo | aggiunge il testo; **vuoto → resta vuoto** (§6.1) |
| `padleft:N:T` | Completa a sinistra | lunghezza, un carattere | completa a sinistra fino alla lunghezza minima N; mai troncare; **vuoto → resta vuoto** |
| `padright:N:T` | Completa a destra | lunghezza, un carattere | come `padleft`, a destra |

Esempi: `{Matricola|padleft:8:0}` con `125` → `00000125`, con cella vuota → `""`. `{#|padleft:6:0}` con contatore `-12` → `000-12` (il filtro è testuale). `{Codice|replace:"-":""|upper}` con `ab-012345` → `AB012345`. `{Codice|right:6|padleft:6:0}`.

I filtri vedono il **valore completo** del generatore, compresi prefisso e suffisso configurati nel generatore: con suffisso `-IT`, `right:4` comprende il suffisso.

## 6. Valori vuoti, codici vuoti, codici univoci

### 6.1 I filtri che aggiungono caratteri non riempiono il vuoto

`padleft`, `padright`, `prefix` e `suffix` restituiscono `""` se il valore in ingresso è `""`. Una cella vuota non deve diventare una matricola di zeri o un codice fittizio come `FT-`. Il vuoto si sostituirà intenzionalmente solo con il futuro filtro `default`.
Conseguenze: `"ABC"|digits|padleft:6:0` → `""`; `"  "|padleft:5:0` → `000  ` (gli spazi non sono vuoto; usare `trim` prima se serve). Il testo fisso scritto **fuori** dal segnaposto resta sempre stampato (`FT-{Codice}` con cella vuota → `FT-`).

### 6.2 Codici vuoti

Una zona **QR, DataMatrix o codice a barre** il cui contenuto risolto è `""` produce l'errore `Record N, zona "Nome": il contenuto del codice è vuoto`.

- Vale solo per le zone delle **pagine attive** (generazione e riepilogo); non blocca il salvataggio.
- Le zone di testo vuote restano ammesse (nessun disegno, come oggi).
- **Controllo preliminare**: prima di disegnare le pagine, la generazione calcola il contenuto delle sole zone codice attive per tutti i record dell'intervallo e, se trova contenuti vuoti, si ferma riportando i primi 10 record (`Zona "DataMatrix": contenuto del codice vuoto nei record 125, 340, … (e altri N)`). Costo trascurabile (funzioni testo → testo, generatori già compilati).
- Il riepilogo segnala staticamente solo il caso certo (zona codice con contenuto senza testo né segnaposto). L'anteprima mostra l'errore sul record corrente, anche su una pagina esclusa (diagnostica dell'editor, non blocco della tiratura).
- Limite noto: i codici facoltativi non sono possibili finché non esisterà l'opzione per zona "consenti codice vuoto" (§12).

### 6.3 Codici univoci abbreviati

Se un segnaposto ha come sorgente un generatore di **codici univoci** e almeno un filtro che può togliere o cambiare caratteri (`left`, `right`, `mid`, `digits`, `replace`, `nospace`, `trim`, `upper`, `lower`), l'interfaccia mostra un **avviso non bloccante**: `La trasformazione riduce un codice univoco: il risultato potrebbe ripetersi su più record.` Nel dialogo ƒx, nella riga "Valore" e nel riepilogo (come avviso, non come errore). Nessuna verifica delle collisioni. `prefix`, `suffix`, `padleft`, `padright` non generano l'avviso.

## 7. Unicode

- Posizioni e lunghezze contate per **code point** (`left`, `right`, `mid`, `padleft`, `padright`); nessuna normalizzazione (i byte del QR restano quelli dei dati).
- **Controllo dei tagli** con `Intl.Segmenter` (granularità grapheme, un'istanza condivisa, usata solo come verifica): se un estremo del taglio di `left`/`right`/`mid` non cade su un confine di carattere visibile, errore `Record N, zona "Nome": il taglio spezzerebbe un carattere composto (accento separato, emoji…)`. Estrazione vuota o intera non genera errore. Stessa verifica per il riempimento: il carattere di riempimento deve essere un solo code point che formi da solo un carattere e non si unisca ai vicini nel risultato.
- Percorso veloce: stringhe tutte ASCII e senza CR non vengono segmentate.
- Se `Intl.Segmenter` non esiste nel browser → errore esplicito (`browser non supportato per questa trasformazione`), mai controllo saltato.
- Tra versioni diverse dei browser può cambiare solo l'esito **errore ↔ risultato** per caratteri molto recenti, mai il testo stampato.

## 8. Limiti anti-abuso

Controllati **prima** di allocare memoria (anche per `replace` e i riempimenti) e validi in anteprima e generazione:

| Limite | Valore |
| --- | --- |
| filtri per segnaposto | 32 |
| argomento numerico | 0–10.000 |
| argomento di testo | 4.096 caratteri |
| valore intermedio o finale di un segnaposto | 65.536 unità UTF-16 |

Superamento → errore esplicito (`valore troppo lungo`, `troppi filtri`, …). I valori sono iniziali: si confermano con le misure dell'implementazione.

## 9. Errori

Formati (invariati): `Zona "Nome": …` per gli errori statici, `Record N, zona "Nome": …` per quelli per record. Il messaggio cita il segnaposto o il filtro coinvolto.

| Tipo | Esempi | Quando |
| --- | --- | --- |
| Lessicale | graffa non chiusa / isolata, virgolette non chiuse, segnaposto vuoto | statico |
| Sintattico | `filtro "rigth" sconosciuto`, `right richiede 1 argomento`, `numero non valido "-3"`, `mid: la posizione parte da 1`, `replace: il testo da cercare non può essere vuoto`, `escape non valido "\x"`, `i nomi dei generatori non vanno tra virgolette`, `il nome {#x} va scritto tra virgolette: {"#x"}` | statico |
| Sorgente | `Colonna "X" non presente nei dati`, `generatore "X" inesistente`, generatore non valido o con capacità insufficiente (regole esistenti) | statico |
| Per record | codice vuoto, taglio di un carattere composto, valore troppo lungo, valore non valido per la simbologia (bwip-js), carattere non codificabile dal font | per record |

- **Bloccano** la generazione solo gli errori delle zone delle pagine attive (`activeComposition`).
- Il **riepilogo** di Generazione PDF esegue il controllo statico delle zone attive (senza estrarre codici univoci) e il controllo preliminare dei codici vuoti al clic su Crea PDF.
- Una cella mancante in una riga corta resta `""` (come oggi); una colonna o un generatore inesistenti restano errore.

## 10. Architettura

### 10.1 Moduli

| Modulo | Contenuto |
| --- | --- |
| `src/core/placeholders.ts` (riscritto) | scanner del contenuto, parser dei segnaposto (nodi con intervalli), predicato `isBareName`, serializzatore `columnRef`, binding (controllo statico), `compileContent`, riferimenti e rinomina |
| `src/core/filters.ts` (nuovo) | tabella dei filtri: nome, firma degli argomenti, funzione testo → testo; regole Unicode e limiti |
| `src/core/generators.ts` | `nameProblem` con la regola del nome nudo; `referencedGenerators`/`renameInContent` delegati al parser; `generationIssue` invariato nella logica |
| `src/core/generate.ts` | controllo preliminare dei codici vuoti; errore per codice vuoto in `drawField` (solo zone codice) |
| `src/core/archive.ts` | solo v5; tipi `SavedData`/`ProjectData` spostati qui da `project.ts`; messaggi di §3 |
| `src/core/project.ts` | **eliminato** |
| `src/ui/output.ts` | `plannedJob`: controllo statico delle zone attive, avvisi non bloccanti (codici univoci abbreviati) |
| `src/ui/props.ts`, `state.ts`, `data-panel.ts` | serializzatore; riga "Valore"; pulsante ƒx; guida |
| `src/ui/transform-dialog.ts` (nuovo) | dialogo ƒx |
| `src/ui/actions.ts`, `index.html` | rimozione dei rami legacy (`.json`, avviso "dati non inclusi") |

### 10.2 Pipeline

1. **Parser** (puro, senza dati): contenuto → sequenza di nodi `testo` e `segnaposto { sorgente, filtri[], intervalli }`, più gli errori. Restituisce i segnaposto letti fino al primo errore lessicale insieme all'errore.
2. **Binding** (controllo statico): verifica filtri, arità, tipi e valori degli argomenti, limiti statici; risolve le sorgenti rispetto alle colonne del dataset e ai nomi dei generatori **senza** compilare i generatori (nessuna estrazione di codici univoci). Usato dal riepilogo e come primo passo della compilazione.
3. **Compilazione**: per ogni segnaposto, resolver della sorgente (contatore, generatore dal `GeneratorSet` del job, colonna) seguito dalla composizione dei filtri già configurati. Segnaposto senza filtri → stesso costo di oggi.

### 10.3 Riferimenti e rinomina

- `referencedGenerators` e il conteggio "in N zone" usano le sorgenti riconosciute dal parser, **anche con filtri invalidi**; il testo degli argomenti non conta come riferimento (`{A|prefix:"{@Gift}"}` non usa Gift).
- Una zona con errore lessicale **blocca** comunque l'eliminazione di un generatore (in modo prudente), con messaggio "zona con formula da correggere".
- La rinomina sostituisce solo l'intervallo del nome del generatore e lascia il resto del segnaposto identico byte per byte.

### 10.4 Anteprima

- Riga "Valore (record N): …" e anteprima del dialogo ƒx usano lo stesso compilatore, con contatore della zona, indice assoluto e `state.previewNow`.
- `GeneratorSet` dell'anteprima in cache, con chiave (definizioni dei generatori, `previewNow`) e **numero di record coperti**: si ricostruisce solo quando il record corrente non vi rientra o i generatori cambiano, mai a ogni tasto.

## 11. Interfaccia

- **Chip** invariati per l'inserimento semplice (colonne, contatore, generatori), con il serializzatore.
- **Pulsante "ƒx Trasforma"** accanto al contenuto della zona, che apre un `<dialog>` nativo:
  - scelta della sorgente (colonne, contatore, generatori);
  - **catena ordinata** di filtri: aggiungi, rimuovi, sposta su/giù (es. "Solo cifre" → "Ultimi caratteri: 4");
  - descrizioni e campi in italiano (§5), con validazione immediata e messaggi del motore;
  - anteprima "originale → risultato" sul record corrente, con l'avviso dei codici univoci abbreviati;
  - se il cursore è dentro un segnaposto valido, il dialogo si apre già compilato e alla conferma **sostituisce quel segnaposto**; altrimenti inserisce al cursore; se il segnaposto ha filtri invalidi lo dice e propone solo l'inserimento;
  - selezione salvata prima dell'apertura e focus restituito al campo; tastiera ed Esc; etichette per gli screen reader.
- **Riga "Valore (record N): …"** sotto il contenuto: valore risolto (testo, mai HTML) o errore in rosso; aggiornata a ogni modifica e al cambio record senza ricostruire il campo a fuoco.
- **Guida**: graffe raddoppiate, virgolette per i nomi speciali, esempi copiabili dei filtri, JSON in un QR.

## 12. Fuori ambito (backlog)

Seconda fase, già progettati: `letters` (solo lettere ASCII), `length`, `group:N:"SEP"`, `default:"TESTO"` (unico filtro che sostituisce il vuoto; colonne o generatori inesistenti restano errore).

Futuro, da specificare a parte: filtro `json` (escape di un valore da inserire in un JSON codificato in QR/DataMatrix); opzione per zona "consenti codice vuoto" (booleano facoltativo nel manifest, predefinito `false`); rimozione degli accenti; rimozione degli zeri iniziali; cifra di controllo Luhn / mod 10 GS1.

Esclusi: calcoli, condizioni, regex, concatenazione di più sorgenti in un filtro, campi derivati nominati, linguaggio general purpose.

## 13. Test e criteri di accettazione

**Parser e lessico:** `{{`, `}}`, `{{{A}}}`, `{A}}}`, graffa non chiusa, `}` isolata, `{}`, `{ }`, `{` dentro un segnaposto, virgolette non chiuse, escape validi e non validi (`{"C:\Dati"}` → errore; `{C:\Dati}` → colonna), `C:\Stampa` nel testo, posizioni con un'emoji prima dell'errore, `{"t":"A|B"}` non raddoppiato → errore, `{{"id":"{Codice}"}}` → JSON corretto.

**Grammatica:** `{ # }`, `{#x}` (errore con suggerimento), `{@Nome}` senza generatore ma con colonna `@Nome` → generatore inesistente, `{"@Gift"}` e `{@Gift}` nella stessa zona, `{@"X"}` → errore, `{Prezzo, €}`, `{Cognome, Nome}`, `{Peso [kg]|upper}`, `{"Peso {kg}"}`, intestazione con a capo, filtri in maiuscolo, argomenti con spazi attorno.

**Proprietà:** `parse(serializza(n)) = n` su un elenco di nomi difficili; ogni nome accettato da `nameProblem` si legge come `{@n}`.

**Filtri:** ogni riga del §5 con valore normale, vuoto, oltre i limiti; `right:0`; `replace` con `$&` e con `|`, `:`, `{` negli argomenti; `ß` con `upper`; NBSP con `trim`/`nospace`; catene `trim|upper|right:4`, `digits|right:4`, `replace:"-":""|upper`, `right:4|padleft:6:0`; vuoto con `padleft`, `padright`, `prefix`, `suffix`; spazi con `padleft`.

**Unicode:** accento separato, emoji con ZWJ prima e dopo il taglio, modificatore di carnagione, bandiera, Hangul, CR+LF, riempimento che si unirebbe ai vicini, `Intl.Segmenter` assente.

**Limiti:** ogni limite del §8, verificato prima dell'allocazione.

**Riferimenti:** `{@Codice|right:4}` conta come uso di Codice; rinomina che conserva i filtri (anche con maiuscole diverse e con un errore dopo il segnaposto); eliminazione bloccata con zona in errore; il testo degli argomenti non conta come riferimento.

**Codici vuoti:** errore per record, controllo preliminare con i primi 10 record, pagina esclusa senza errore, salvataggio riuscito, zona di testo vuota senza errore.

**Archivio:** scrive v5; apre v5; v4 → "non supportato" senza "danneggiato"; v6 → "più recente"; JSON → "non è un progetto"; foglio di calcolo riconosciuto; formula errata salvata e riaperta identica.

**Integrazione:** DataMatrix `{@Codice}` + testo `{@Codice|digits|right:4}` su 1000 record con **decodifica del simbolo** (primo, centesimo, ultimo); ristampa 100–110 identica alla tiratura completa; fronte/retro con lo stesso generatore; database + generatori + contatore; avviso codici univoci abbreviati non bloccante.

**Prestazioni:** 10.000 record con e senza filtri, tempo del resolver misurato separatamente dal PDF.

**Browser:** Chromium e Firefox da `file://`: dialogo ƒx con sola tastiera, riga "Valore", errori, salvataggio e riapertura, generazione.

## 14. Decisioni aperte

Nessuna. La regola di §6.1 su `prefix`/`suffix` è stata confermata da Luca il 19/11/2026 (`""|prefix:"FT-"` → `""`, `""|suffix:"-MI"` → `""`).

**Limitazione documentata, da non risolvere in questa versione:** il testo fisso scritto fuori dai segnaposto resta sempre stampato. `FT-{Codice}` con `Codice` vuoto produce `FT-`, e il controllo dei codici vuoti (§6.2) non intercetta questo caso, perché il contenuto risolto non è vuoto.

## 15. Registro delle decisioni

| Decisione | Origine |
| --- | --- |
| `\|` per i filtri, `:` per gli argomenti | Council, unanimità |
| Motore unico parser → binding → compilazione | Council, unanimità |
| Formato v5 unico, nessuna migrazione | Luca, 19/11; Council |
| Graffe letterali raddoppiate, scanner consapevole delle virgolette | Council; Luca, 19/11 |
| Nomi speciali tra virgolette JSON `{"…"}`; virgola ammessa nei nomi nudi | Council; Luca, 19/11 |
| `{@Nome}` solo generatore; nomi dei generatori = nomi nudi | Council |
| Code point + controllo dei tagli con `Intl.Segmenter` | Council |
| Vuoto preservato da `padleft`/`padright` | Luca, 19/11; Council senza obiezioni |
| Vuoto preservato da `prefix`/`suffix` | raccomandazione unanime del Council; confermata da Luca, 19/11 |
| Testo fisso fuori dai segnaposto sempre stampato (`FT-{Codice}` → `FT-` se vuoto): limitazione documentata, non risolta in v1 | Luca, 19/11 |
| Errore sui codici vuoti con controllo preliminare | Luca, 19/11; Council (controllo preliminare) |
| Avviso non bloccante sui codici univoci abbreviati | Luca, 19/11 |
| 13 filtri in v1, `group` in fase 2, filtro `json` nel backlog | Luca, 19/11 |
| Nomi dei filtri in inglese, interfaccia in italiano | Luca, 19/11 |
| Pubblicazione solo con motore + interfaccia ƒx | Luca, 19/11 |
