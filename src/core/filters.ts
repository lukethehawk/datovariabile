/**
 * Filters of the placeholders: {Sorgente|filtro:arg|filtro}. Pure text → text functions, compiled once per
 * placeholder (arguments checked and decoded here) and run for every record. Specification:
 * docs/SPECIFICA_FILTRI.md §5–§8. No regex from the user, no eval: every filter is plain code below.
 */

/** Argument as written: unquoted text (digits or one ASCII letter/digit) or a decoded JSON string. */
export interface ArgToken {
  text: string;
  quoted: boolean;
}

/** One filter call as parsed: lower-case name and raw arguments. */
export interface FilterCall {
  name: string;
  args: ArgToken[];
}

/** int: integer 0…MAX_INT; pos: integer 1…MAX_INT; text: any text; char: exactly one character. */
export type ParamType = 'int' | 'pos' | 'text' | 'char';

export interface FilterDef {
  /** Italian label used by the ƒx dialog. */
  label: string;
  params: Array<{ type: ParamType; label: string }>;
  /** Can remove or change characters: shortening a unique code may make it repeat. */
  reduces: boolean;
  make: (args: Array<number | string>) => (s: string) => string;
}

export const LIMITS = { filters: 32, int: 10_000, text: 4096, value: 65_536 } as const;

const tooLong = () => new Error(`valore troppo lungo (oltre ${LIMITS.value.toLocaleString('it-IT')} caratteri)`);
const checkLength = (n: number) => {
  if (n > LIMITS.value) throw tooLong();
};

// ---------------------------------------------------------------- Unicode

/** ASCII without CR: one code unit per character, no grapheme can span two of them. */
const simple = (s: string) => /^[\x00-\x0c\x0e-\x7f]*$/.test(s);

let segmenter: Intl.Segmenter | null = null;
function graphemes(): Intl.Segmenter {
  if (segmenter) return segmenter;
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    throw new Error('browser non supportato per questa trasformazione (manca Intl.Segmenter): aggiorna il browser');
  }
  return (segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }));
}

/** Throws when a cut at UTF-16 offset `at` would split a visible character (combining accent, emoji sequence…). */
function assertBoundary(s: string, at: number): void {
  if (at <= 0 || at >= s.length) return;
  if (graphemes().segment(s).containing(at)?.index !== at) {
    throw new Error('il taglio spezzerebbe un carattere composto (accento separato, emoji…)');
  }
}

/** Code points of `s` (fast path: the string itself is indexable). */
const codePoints = (s: string): string[] => Array.from(s);
const cpLength = (s: string) => (simple(s) ? s.length : codePoints(s).length);

/** Code points [start, end) of `s`, refusing cuts inside a composed character. */
function slice(s: string, start: number, end: number): string {
  if (simple(s)) return s.slice(start, end);
  const cps = codePoints(s);
  const from = Math.min(start, cps.length);
  const to = Math.min(end, cps.length);
  if (to <= from) return '';
  const offset = (cp: number) => cps.slice(0, cp).join('').length;
  assertBoundary(s, offset(from));
  assertBoundary(s, offset(to));
  return cps.slice(from, to).join('');
}

/** `count` copies of `fill` joined to `s`, checked so that the fill characters stay separate characters. */
function pad(s: string, length: number, fill: string, left: boolean): string {
  if (s === '') return '';
  const missing = length - cpLength(s);
  if (missing <= 0) return s;
  checkLength(s.length + missing * fill.length);
  const filler = fill.repeat(missing);
  const result = left ? filler + s : s + filler;
  if (!simple(result)) {
    for (let i = 1; i <= missing; i++) {
      const at = left ? i * fill.length : s.length + (i - 1) * fill.length;
      if (at > 0 && at < result.length && graphemes().segment(result).containing(at)?.index !== at) {
        throw new Error('il carattere di riempimento si unisce ai caratteri vicini: scegline un altro');
      }
    }
  }
  return result;
}

function replaceAll(s: string, find: string, put: string): string {
  let count = 0;
  for (let i = s.indexOf(find); i !== -1; i = s.indexOf(find, i + find.length)) count++;
  if (!count) return s;
  checkLength(s.length + count * (put.length - find.length));
  // split/join: the replacement is literal ($&, $1… have no special meaning).
  return s.split(find).join(put);
}

const keep = (fn: (s: string) => string) => (s: string) => (s === '' ? '' : fn(s));

// ---------------------------------------------------------------- the 13 filters

export const FILTERS: Record<string, FilterDef> = {
  left: {
    label: 'Primi caratteri',
    params: [{ type: 'int', label: 'Quanti' }],
    reduces: true,
    make: ([n]) => (s) => slice(s, 0, n as number),
  },
  right: {
    label: 'Ultimi caratteri',
    params: [{ type: 'int', label: 'Quanti' }],
    reduces: true,
    make: ([n]) => (s) => {
      if (n === 0) return '';
      const len = cpLength(s);
      return slice(s, Math.max(0, len - (n as number)), len);
    },
  },
  mid: {
    label: 'Caratteri da una posizione',
    params: [
      { type: 'pos', label: 'Dalla posizione' },
      { type: 'int', label: 'Quanti' },
    ],
    reduces: true,
    make: ([start, count]) => (s) => slice(s, (start as number) - 1, (start as number) - 1 + (count as number)),
  },
  digits: { label: 'Solo cifre', params: [], reduces: true, make: () => (s) => s.replace(/[^0-9]+/g, '') },
  upper: { label: 'Tutto maiuscolo', params: [], reduces: true, make: () => (s) => s.toUpperCase() },
  lower: { label: 'Tutto minuscolo', params: [], reduces: true, make: () => (s) => s.toLowerCase() },
  trim: { label: 'Togli spazi ai bordi', params: [], reduces: true, make: () => (s) => s.trim() },
  // \s is the same set String.prototype.trim removes (whitespace, line terminators, NBSP, BOM).
  nospace: { label: 'Togli tutti gli spazi', params: [], reduces: true, make: () => (s) => s.replace(/\s+/g, '') },
  replace: {
    label: 'Sostituisci testo',
    params: [
      { type: 'text', label: 'Cerca' },
      { type: 'text', label: 'Sostituisci con' },
    ],
    reduces: true,
    make: ([find, put]) => (s) => replaceAll(s, find as string, put as string),
  },
  prefix: {
    label: 'Aggiungi testo prima',
    params: [{ type: 'text', label: 'Testo' }],
    reduces: false,
    make: ([t]) =>
      keep((s) => {
        checkLength(s.length + (t as string).length);
        return (t as string) + s;
      }),
  },
  suffix: {
    label: 'Aggiungi testo dopo',
    params: [{ type: 'text', label: 'Testo' }],
    reduces: false,
    make: ([t]) =>
      keep((s) => {
        checkLength(s.length + (t as string).length);
        return s + (t as string);
      }),
  },
  padleft: {
    label: 'Completa a sinistra',
    params: [
      { type: 'int', label: 'Lunghezza' },
      { type: 'char', label: 'Carattere' },
    ],
    reduces: false,
    make: ([n, c]) => (s) => pad(s, n as number, c as string, true),
  },
  padright: {
    label: 'Completa a destra',
    params: [
      { type: 'int', label: 'Lunghezza' },
      { type: 'char', label: 'Carattere' },
    ],
    reduces: false,
    make: ([n, c]) => (s) => pad(s, n as number, c as string, false),
  },
};

// ---------------------------------------------------------------- compilation

function decodeArg(name: string, param: { type: ParamType; label: string }, arg: ArgToken): number | string {
  if (param.type === 'int' || param.type === 'pos') {
    if (arg.quoted || !/^\d+$/.test(arg.text)) throw new Error(`${name}: "${arg.text}" non è un numero intero (${param.label.toLowerCase()})`);
    const n = Number(arg.text);
    if (n > LIMITS.int) throw new Error(`${name}: ${arg.text} è troppo grande (massimo ${LIMITS.int.toLocaleString('it-IT')})`);
    if (param.type === 'pos' && n < 1) throw new Error(`${name}: la posizione parte da 1`);
    return n;
  }
  if (!arg.quoted && !/^[A-Za-z0-9]$/.test(arg.text)) {
    throw new Error(`${name}: scrivi il testo tra virgolette, es. "${arg.text}"`);
  }
  if (arg.text.length > LIMITS.text) throw new Error(`${name}: testo troppo lungo (massimo ${LIMITS.text} caratteri)`);
  if (param.type === 'char') {
    if (codePoints(arg.text).length !== 1) throw new Error(`${name}: il carattere di riempimento deve essere uno solo`);
    // A fill character must stay a character of its own next to letters and next to itself
    // (no combining accent, joiner, variation selector or flag half).
    if (!simple(arg.text) && [...graphemes().segment(`a${arg.text}${arg.text}a`)].length !== 4) {
      throw new Error(`${name}: il carattere di riempimento deve essere un carattere a sé (non un accento o un simbolo che si unisce ad altri)`);
    }
  }
  return arg.text;
}

/**
 * Checks the calls (unknown filters, arity, argument types and values) and returns their composition.
 * The source value and every intermediate/final value are limited to LIMITS.value: growing filters
 * (replace, prefix, suffix, pads) check before allocating; upper/lower can at most triple a value that is
 * already within the limit, so they are checked right after.
 */
export function compileFilters(calls: FilterCall[]): (s: string) => string {
  if (calls.length > LIMITS.filters) throw new Error(`troppi filtri (massimo ${LIMITS.filters})`);
  const fns = calls.map((call) => {
    const def = FILTERS[call.name];
    if (!def) throw new Error(`filtro "${call.name}" sconosciuto`);
    if (call.args.length !== def.params.length) {
      const n = def.params.length;
      throw new Error(`${call.name} richiede ${n === 0 ? 'nessun argomento' : n === 1 ? '1 argomento' : `${n} argomenti`}`);
    }
    const args = def.params.map((p, i) => decodeArg(call.name, p, call.args[i]));
    if (call.name === 'replace' && args[0] === '') throw new Error('replace: il testo da cercare non può essere vuoto');
    return def.make(args);
  });
  return (s) => {
    checkLength(s.length);
    let v = s;
    for (const fn of fns) {
      v = fn(v);
      checkLength(v.length);
    }
    return v;
  };
}

/** True when one of the calls can remove or change characters (warning for unique codes). */
export const reducesValue = (calls: FilterCall[]) => calls.some((c) => FILTERS[c.name]?.reduces);
