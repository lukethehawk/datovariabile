/**
 * Data generators: numbering, unique codes, date/time. A generator gives one value
 * per record (absolute index, invariant 4), shared by every field that writes {@Nome},
 * so text, QR, barcode, front and back show the same value.
 *
 * Every value is a pure function of the generator settings, the record index and,
 * for dates in "job" mode, the instant captured once when the generation starts:
 * preview, PDF, reopened project and partial reprints always agree. Nothing random
 * happens while resolving; the only randomness is the key created with the generator.
 * Algorithms are frozen: changing them changes codes already printed (see
 * docs/FORMATO_PROGETTO.md §8 and the golden vectors in tests/generators.test.ts).
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generatorToken, PLACEHOLDER } from './placeholders';
import type { DataGenerator, DateFormat, DateTimeGenerator, NumberingGenerator, UniqueGenerator } from './types';

export const DEFAULT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const UNIQUE_ALPHABETS = {
  /** Letters and digits without 0/O, 1/I/L (31 characters). */
  safe: '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
  alnum: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  /** Letters without I, L, O (23 characters). */
  safeLetters: 'ABCDEFGHJKMNPQRSTUVWXYZ',
} as const;
export const DATE_FORMATS: Array<[DateFormat, string]> = [
  ['dd/MM/yyyy', '18/11/2026'],
  ['dd-MM-yyyy', '18-11-2026'],
  ['dd/MM/yy', '18/11/26'],
  ['dd/MM/yyyy HH:mm', '18/11/2026 14:35'],
  ['HH:mm', '14:35'],
  ['yyyy-MM-dd', '2026-11-18 (ISO)'],
  ['yyyy-MM-dd HH:mm', '2026-11-18 14:35 (ISO)'],
];
export const DEFAULT_TIME_ZONE = 'Europe/Rome';
/** At most this share of the possible codes may be used: beyond, drawing distinct codes slows down sharply. */
export const MAX_UNIQUE_FILL = 0.5;

/** Resolves {@Nome} by name (case-insensitive); built once per generation, values computed lazily. */
export interface GeneratorSet {
  /** Value function for a generator name, or undefined if no generator has that name. */
  get(name: string): ((record: number) => string) | undefined;
  has(name: string): boolean;
}

export interface GeneratorContext {
  /** Instant (ms since epoch) captured once per generation, for date generators in job mode. */
  now: number;
  /** Records the job may resolve (absolute index < count): unique codes are drawn up to here. */
  count: number;
}

export function compileGenerators(generators: DataGenerator[], ctx: GeneratorContext): GeneratorSet {
  const byName = new Map(generators.map((g) => [g.name.toLowerCase(), g]));
  const compiled = new Map<string, (record: number) => string>();
  return {
    has: (name) => byName.has(name.toLowerCase()),
    get(name) {
      const key = name.toLowerCase();
      const g = byName.get(key);
      if (!g) return undefined;
      let fn = compiled.get(key);
      if (!fn) {
        const problem = generatorProblem(g);
        if (problem) throw new Error(`generatore "${g.name}": ${problem}`);
        fn = compileOne(g, ctx);
        compiled.set(key, fn);
      }
      return fn;
    },
  };
}

function compileOne(g: DataGenerator, ctx: GeneratorContext): (record: number) => string {
  if (g.type === 'numbering') return (i) => g.prefix + numberingBody(g, i) + g.suffix;
  if (g.type === 'unique') {
    const codes = uniqueCodes(g, ctx.count);
    return (i) => {
      const code = codes[i];
      if (code === undefined) throw new Error(`generatore "${g.name}": nessun codice per il record ${i + 1}`);
      return g.prefix + code + g.suffix;
    };
  }
  const text = g.prefix + formatDateTime(g, ctx.now) + g.suffix;
  return () => text;
}

// ---------------------------------------------------------------- numbering

/** Letters of the bijective base-k numeral `o` ≥ 1 (1 = A, k = Z, k+1 = AA), as in spreadsheet columns. */
export function lettersOf(o: number, alphabet: string): string {
  const k = alphabet.length;
  let s = '';
  for (let n = o; n > 0; n = Math.floor((n - 1) / k)) s = alphabet[(n - 1) % k] + s;
  return s;
}

/** Inverse of lettersOf(); NaN if a character is not in the alphabet. */
export function ordinalOf(letters: string, alphabet: string): number {
  let o = 0;
  for (const c of letters) {
    const d = alphabet.indexOf(c);
    if (d < 0) return NaN;
    o = o * alphabet.length + d + 1;
  }
  return o;
}

const pad = (n: number, digits: number) => String(n).padStart(Math.max(0, digits), '0');

export function numberingBody(g: NumberingGenerator, record: number): string {
  // Every intermediate must be an exact integer: beyond 2^53 JavaScript rounds silently.
  const exact = (...values: number[]) => {
    if (!values.every(Number.isSafeInteger)) throw new Error(`generatore "${g.name}": sequenza troppo lunga (numeri oltre il limite di calcolo)`);
  };
  const offset = record * g.step;
  exact(offset);
  if (g.style === 'number') {
    const n = g.start + offset;
    exact(n);
    if (n < 0) throw new Error(`generatore "${g.name}": numero negativo (${n})`);
    return pad(n, g.digits);
  }
  const first = ordinalOf(g.groupStart, g.alphabet);
  let groupOrdinal: number;
  let number = '';
  if (g.style === 'letters') {
    groupOrdinal = first + offset;
  } else {
    // Number runs numberMin…numberMax, then the group advances by one and the number restarts.
    const range = g.numberMax - g.numberMin + 1;
    const t = g.start - g.numberMin + offset;
    exact(range, t);
    const q = Math.floor(t / range);
    const n = g.numberMin + (t - q * range);
    exact(q, n);
    number = pad(n, g.digits);
    groupOrdinal = first + q;
  }
  exact(first, groupOrdinal);
  if (groupOrdinal < 1) throw new Error(`generatore "${g.name}": valore prima del primo gruppo di lettere`);
  const letters = lettersOf(groupOrdinal, g.alphabet);
  if (g.overflow === 'error' && letters.length > g.groupStart.length) {
    const last = g.alphabet[g.alphabet.length - 1].repeat(g.groupStart.length);
    throw new Error(`generatore "${g.name}": numerazione esaurita (ultimo valore ${last}${g.style === 'lettersNumber' ? pad(g.numberMax, g.digits) : ''})`);
  }
  return letters + number;
}

// ---------------------------------------------------------------- unique codes

/** Number of possible codes (may exceed 2^53: then it is only an approximation, always "enough"). */
export function uniqueCapacity(g: Pick<UniqueGenerator, 'alphabet' | 'length'>): number {
  return g.alphabet.length ** g.length;
}

/** Most records a unique generator accepts (MAX_UNIQUE_FILL of the capacity). */
export function uniqueMaxRecords(g: Pick<UniqueGenerator, 'alphabet' | 'length'>): number {
  return Math.floor(uniqueCapacity(g) * MAX_UNIQUE_FILL);
}

export function newUniqueKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface CodeStream {
  codes: string[];
  seen: Set<string>;
  next: () => string;
}

/** Streams per key/alphabet/length, extended on demand: the preview does not redraw codes it already has. */
const streams = new Map<string, CodeStream>();
const MAX_STREAMS = 8;

/** Drops the cached streams (tests: prove that a cold start gives the same codes). */
export function clearUniqueCache(): void {
  streams.clear();
}

/**
 * hmac-sha256-ctr-v1 (frozen):
 * block_c = HMAC-SHA-256(key, "DVP-U1" 0x00 alphabet(UTF-8) 0x00 u32be(length) u64be(c)), c = 0, 1, 2…
 * Bytes of consecutive blocks form one stream; a byte b is used only if b < 256 − (256 mod k)
 * (no modulo bias) and gives alphabet[b mod k]. Every `length` accepted characters form a candidate;
 * candidates already seen are skipped. The code of record i is the i-th distinct candidate, so
 * adding records never changes earlier codes.
 */
export function uniqueCodes(g: UniqueGenerator, count: number): string[] {
  const max = uniqueMaxRecords(g);
  if (count > max) {
    throw new Error(`generatore "${g.name}": servono ${count} codici ma con ${g.length} caratteri tra ${g.alphabet.length} se ne possono usare al massimo ${max}: aumenta la lunghezza`);
  }
  const id = `${g.algorithm}|${g.key}|${g.alphabet}|${g.length}`;
  let stream = streams.get(id);
  if (!stream) {
    stream = createStream(g);
    streams.set(id, stream);
    if (streams.size > MAX_STREAMS) streams.delete(streams.keys().next().value!);
  }
  while (stream.codes.length < count) {
    const code = stream.next();
    if (!stream.seen.has(code)) {
      stream.seen.add(code);
      stream.codes.push(code);
    }
  }
  return stream.codes;
}

function createStream(g: UniqueGenerator): CodeStream {
  const key = Uint8Array.from(g.key.match(/../g)!, (h) => parseInt(h, 16));
  const k = g.alphabet.length;
  const limit = 256 - (256 % k);
  const enc = new TextEncoder();
  const head = new Uint8Array([...enc.encode('DVP-U1'), 0, ...enc.encode(g.alphabet), 0, 0, 0, 0, 0]);
  new DataView(head.buffer).setUint32(head.length - 4, g.length);
  const msg = new Uint8Array(head.length + 8);
  msg.set(head);
  const counterView = new DataView(msg.buffer, head.length, 8);
  const keyed = hmac.create(sha256, key);
  let counter = 0n;
  let block = new Uint8Array(0);
  let at = 0;
  const nextChar = (): string => {
    for (;;) {
      if (at >= block.length) {
        counterView.setBigUint64(0, counter++);
        block = keyed.clone().update(msg).digest();
        at = 0;
      }
      const b = block[at++];
      if (b < limit) return g.alphabet[b % k];
    }
  };
  return {
    codes: [],
    seen: new Set(),
    next: () => {
      let code = '';
      for (let j = 0; j < g.length; j++) code += nextChar();
      return code;
    },
  };
}

// ---------------------------------------------------------------- date / time

interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Numeric parts of an instant in a time zone; separators are added by formatParts(), not by the locale. */
export function civilTime(instant: number, timeZone: string): CivilTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new Error(`fuso orario non valido: ${timeZone}`);
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** "YYYY-MM-DDTHH:mm" (years 1000–9999) → civil time, or null if not a real date. */
export function parseCivil(s: string): CivilTime | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (year < 1000) return null; // Date.UTC treats years 0–99 as 1900–1999
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

export function formatParts(t: CivilTime, format: DateFormat): string {
  const dmy = (sep: string) => `${two(t.day)}${sep}${two(t.month)}${sep}${t.year}`;
  const hm = `${two(t.hour)}:${two(t.minute)}`;
  switch (format) {
    case 'dd/MM/yyyy':
      return dmy('/');
    case 'dd-MM-yyyy':
      return dmy('-');
    case 'dd/MM/yy':
      return `${two(t.day)}/${two(t.month)}/${two(t.year % 100)}`;
    case 'dd/MM/yyyy HH:mm':
      return `${dmy('/')} ${hm}`;
    case 'HH:mm':
      return hm;
    case 'yyyy-MM-dd':
      return `${t.year}-${two(t.month)}-${two(t.day)}`;
    case 'yyyy-MM-dd HH:mm':
      return `${t.year}-${two(t.month)}-${two(t.day)} ${hm}`;
  }
}

export function formatDateTime(g: DateTimeGenerator, now: number): string {
  if (g.mode === 'fixed') {
    const t = parseCivil(g.fixed);
    if (!t) throw new Error(`generatore "${g.name}": data fissata non valida`);
    return formatParts(t, g.format);
  }
  return formatParts(civilTime(now, g.timeZone), g.format);
}

// ---------------------------------------------------------------- validation

const isInt = (v: unknown, min = -1e12, max = 1e12) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const distinct = (s: string) => new Set(s).size === [...s].length;

/** Why a generator name cannot be used in {@Nome}, or null. Uniqueness is checked by the caller. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return 'nome vuoto';
  if (name !== name.trim()) return 'il nome non può iniziare o finire con uno spazio';
  if (/[{}]/.test(name)) return 'il nome non può contenere parentesi graffe';
  if (name.length > 40) return 'nome troppo lungo (massimo 40 caratteri)';
  return null;
}

/** Why a generator cannot produce values (Italian), or null. Used on opening a project and by the panel. */
export function generatorProblem(g: DataGenerator): string | null {
  if (typeof g.prefix !== 'string' || typeof g.suffix !== 'string' || /[{}]/.test(g.prefix + g.suffix)) return 'prefisso o suffisso non valido';
  if (g.type === 'numbering') {
    if (!['number', 'letters', 'lettersNumber'].includes(g.style)) return 'tipo di numerazione non valido';
    if (!isInt(g.start) || !isInt(g.step) || !isInt(g.digits, 0, 20)) return 'inizio, passo o cifre non validi';
    if (g.style === 'number') return null;
    // One UTF-16 unit per character (no emoji or other surrogate pairs): lettersOf/ordinalOf index by unit.
    if (typeof g.alphabet !== 'string' || g.alphabet.length < 2 || !distinct(g.alphabet) || /[{}\s\uD800-\uDFFF]/.test(g.alphabet)) {
      return 'alfabeto non valido (almeno 2 caratteri diversi, senza spazi né emoji)';
    }
    if (typeof g.groupStart !== 'string' || !g.groupStart || !(ordinalOf(g.groupStart, g.alphabet) >= 1)) return 'gruppo iniziale non valido (solo lettere dell’alfabeto)';
    if (g.overflow !== 'grow' && g.overflow !== 'error') return 'comportamento a fine sequenza non valido';
    if (g.style === 'lettersNumber') {
      if (!isInt(g.numberMin, 0) || !isInt(g.numberMax, 0) || g.numberMax < g.numberMin) return 'intervallo del numero non valido';
      if (g.start < g.numberMin || g.start > g.numberMax) return `il numero iniziale deve stare tra ${g.numberMin} e ${g.numberMax}`;
      if (g.step === 0) return 'il passo non può essere 0';
    }
    return null;
  }
  if (g.type === 'unique') {
    if (g.algorithm !== 'hmac-sha256-ctr-v1') return `algoritmo sconosciuto (${String(g.algorithm)})`;
    if (typeof g.key !== 'string' || !/^[0-9a-f]{64}$/.test(g.key)) return 'chiave non valida';
    if (typeof g.alphabet !== 'string' || g.alphabet.length < 2 || g.alphabet.length > 64 || !distinct(g.alphabet) || /[^\x21-\x7e]|[{}]/.test(g.alphabet)) {
      return 'caratteri ammessi non validi (2–64 caratteri ASCII diversi)';
    }
    if (!isInt(g.length, 1, 32)) return 'lunghezza non valida (1–32)';
    return null;
  }
  if (g.type === 'datetime') {
    if (g.mode !== 'job' && g.mode !== 'fixed') return 'modalità non valida';
    if (!DATE_FORMATS.some(([f]) => f === g.format)) return 'formato non valido';
    if (g.mode === 'fixed' && !parseCivil(g.fixed)) return 'data fissata non valida';
    if (g.mode === 'job') {
      if (typeof g.timeZone !== 'string' || !g.timeZone.trim()) return 'fuso orario mancante';
      try {
        civilTime(0, g.timeZone);
      } catch {
        return `fuso orario non valido: ${g.timeZone}`;
      }
    }
    return null;
  }
  return 'tipo di generatore sconosciuto';
}

/** First values for the panel (records 0…n-1); errors are shown instead of values. */
export function generatorExamples(g: DataGenerator, n: number, now: number): string[] {
  const problem = generatorProblem(g);
  if (problem) return [problem];
  try {
    const set = compileGenerators([g], { now, count: n });
    const fn = set.get(g.name)!;
    return Array.from({ length: n }, (_, i) => fn(i));
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

/** Generator names written as {@Nome} in a content, read exactly as compileContent() reads them. */
export function referencedGenerators(content: string): string[] {
  return [...content.matchAll(PLACEHOLDER)].flatMap((m) => {
    const name = generatorToken(m[1]);
    return name === null ? [] : [name];
  });
}

/** Content with {@old} replaced by {@new} (case-insensitive match), used when a generator is renamed. */
export function renameInContent(content: string, oldName: string, newName: string): string {
  return content.replace(PLACEHOLDER, (all, token: string) => (generatorToken(token)?.toLowerCase() === oldName.toLowerCase() ? `{@${newName}}` : all));
}
