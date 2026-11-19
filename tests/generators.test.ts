import { describe, expect, it } from 'vitest';
import {
  DATE_FORMATS,
  DEFAULT_LETTERS,
  DEFAULT_TIME_ZONE,
  MAX_UNIQUE_FILL,
  UNIQUE_ALPHABETS,
  civilTime,
  clearUniqueCache,
  compileGenerators,
  formatDateTime,
  formatParts,
  generatorProblem,
  lettersOf,
  nameProblem,
  numberingBody,
  ordinalOf,
  parseCivil,
  referencedGenerators,
  renameInContent,
  uniqueCapacity,
  uniqueCodes,
  uniqueMaxRecords,
} from '../src/core/generators';
import type {
  DataGenerator,
  DateFormat,
  DateTimeGenerator,
  NumberingGenerator,
  UniqueGenerator,
} from '../src/core/types';

const SAFE = UNIQUE_ALPHABETS.safe;
const DIGITS = UNIQUE_ALPHABETS.digits;
const ZERO_KEY = '00'.repeat(32);
const AB_KEY = 'ab'.repeat(32);

function numbering(overrides: Partial<NumberingGenerator> = {}): NumberingGenerator {
  return {
    id: 'n1',
    name: 'Numero',
    type: 'numbering',
    prefix: '',
    suffix: '',
    style: 'number',
    start: 1,
    step: 1,
    digits: 0,
    alphabet: DEFAULT_LETTERS,
    groupStart: 'A',
    numberMin: 1,
    numberMax: 999,
    overflow: 'grow',
    ...overrides,
  };
}

function unique(overrides: Partial<UniqueGenerator> = {}): UniqueGenerator {
  return {
    id: 'u1',
    name: 'Codice',
    type: 'unique',
    prefix: '',
    suffix: '',
    algorithm: 'hmac-sha256-ctr-v1',
    key: ZERO_KEY,
    alphabet: SAFE,
    length: 8,
    ...overrides,
  };
}

function dateTime(overrides: Partial<DateTimeGenerator> = {}): DateTimeGenerator {
  return {
    id: 'd1',
    name: 'Data',
    type: 'datetime',
    prefix: '',
    suffix: '',
    mode: 'job',
    timeZone: DEFAULT_TIME_ZONE,
    fixed: '2026-11-18T14:35',
    format: 'dd/MM/yyyy',
    ...overrides,
  };
}

/** Value function of a single generator; a job would pass count = to + 1. */
function resolve(g: DataGenerator, count: number, now = 0): (record: number) => string {
  const set = compileGenerators([g], { now, count });
  const fn = set.get(g.name);
  expect(fn).toBeDefined();
  return fn!;
}

function values(g: DataGenerator, records: number[], count = Math.max(...records) + 1): string[] {
  const fn = resolve(g, count);
  return records.map((r) => fn(r));
}

// ---------------------------------------------------------------- numbering

describe('generatori di numerazione', () => {
  it('numera con prefisso, cifre e passo; 0 cifre significa nessun riempimento', () => {
    expect(values(numbering({ prefix: 'FT-', start: 1, step: 1, digits: 6 }), [0, 1, 2])).toEqual([
      'FT-000001',
      'FT-000002',
      'FT-000003',
    ]);
    expect(values(numbering({ start: 10, step: 5, digits: 4 }), [0, 1, 2])).toEqual(['0010', '0015', '0020']);
    expect(values(numbering({ start: 0, step: 1, digits: 0 }), [0, 1, 9, 10])).toEqual(['0', '1', '9', '10']);
  });

  it('numerazione alfabetica biiettiva: A…Z, AA…, AZ, BA, ZZ, AAA', () => {
    const g = numbering({ style: 'letters', alphabet: DEFAULT_LETTERS, groupStart: 'A', step: 1, overflow: 'grow' });
    expect(values(g, [0, 25, 26, 51, 52, 701, 702])).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('si ferma a fine sequenza con overflow "error"', () => {
    const g = numbering({ style: 'letters', alphabet: DEFAULT_LETTERS, groupStart: 'A', step: 1, overflow: 'error' });
    const fn = resolve(g, 30);
    expect(fn(25)).toBe('Z');
    expect(() => fn(26)).toThrow(/numerazione esaurita/);
    expect(() => fn(26)).toThrow(/ultimo valore Z/);
  });

  it('parte dal gruppo iniziale indicato, con il passo richiesto', () => {
    const g = numbering({ style: 'letters', alphabet: DEFAULT_LETTERS, groupStart: 'C', step: 2 });
    // C = 3, poi 5 = E … 25 = Y, 27 = AA dopo il salto di 2.
    expect(values(g, [0, 1, 11, 12])).toEqual(['C', 'E', 'Y', 'AA']);
  });

  it('usa un alfabeto personalizzato', () => {
    const g = numbering({ style: 'letters', alphabet: 'ABC', groupStart: 'A', step: 1 });
    expect(values(g, [0, 1, 2, 3, 4, 5])).toEqual(['A', 'B', 'C', 'AA', 'AB', 'AC']);
    expect(lettersOf(4, 'ABC')).toBe('AA');
    expect(ordinalOf('AB', 'ABC')).toBe(5);
    expect(Number.isNaN(ordinalOf('D', 'ABC'))).toBe(true);
  });

  it('lettere + numero: A001…A999, poi B001', () => {
    const g = numbering({
      style: 'lettersNumber',
      alphabet: DEFAULT_LETTERS,
      groupStart: 'A',
      digits: 3,
      numberMin: 1,
      numberMax: 999,
      start: 1,
      step: 1,
    });
    expect(values(g, [0, 998, 999])).toEqual(['A001', 'A999', 'B001']);
  });

  it('lettere + numero, passo 2 attraverso il confine del gruppo', () => {
    const g = numbering({
      style: 'lettersNumber',
      alphabet: DEFAULT_LETTERS,
      groupStart: 'A',
      digits: 3,
      numberMin: 1,
      numberMax: 999,
      start: 1,
      step: 2,
    });
    // t = 1 - 1 + 2i: 498 → 996 (A997), 499 → 998 (A999), 500 → 1000 → B002.
    expect(values(g, [0, 498, 499, 500])).toEqual(['A001', 'A997', 'A999', 'B002']);
  });

  it('Z999 è l’ultimo gruppo con overflow "error"; con "grow" passa ad AA001', () => {
    const common = {
      style: 'lettersNumber' as const,
      alphabet: DEFAULT_LETTERS,
      groupStart: 'Z',
      digits: 3,
      numberMin: 1,
      numberMax: 999,
      start: 1,
      step: 1,
    };
    expect(values(numbering({ ...common, overflow: 'grow' }), [0, 998, 999])).toEqual(['Z001', 'Z999', 'AA001']);
    const fn = resolve(numbering({ ...common, overflow: 'error' }), 2000);
    expect(fn(998)).toBe('Z999');
    expect(() => fn(999)).toThrow(/numerazione esaurita/);
    expect(() => fn(999)).toThrow(/ultimo valore Z999/);
  });

  it('numerazione con prefisso e quattro cifre: PROD-A0001 … PROD-B0001', () => {
    const g = numbering({
      style: 'lettersNumber',
      prefix: 'PROD-',
      digits: 4,
      numberMin: 1,
      numberMax: 9999,
      start: 1,
      step: 1,
      groupStart: 'A',
    });
    expect(values(g, [0, 9998, 9999])).toEqual(['PROD-A0001', 'PROD-A9999', 'PROD-B0001']);
  });

  it('l’intervallo parziale ripete i valori della serie completa', () => {
    const g = numbering({
      style: 'lettersNumber',
      digits: 3,
      numberMin: 1,
      numberMax: 999,
      start: 1,
      step: 2,
    });
    const full = Array.from({ length: 60 }, (_, i) => numberingBody(g, i));
    const records = Array.from({ length: 11 }, (_, i) => 49 + i);
    const partial = values(g, records, 60);
    expect(partial).toEqual(full.slice(49, 60));
    expect(partial).toEqual(['A099', 'A101', 'A103', 'A105', 'A107', 'A109', 'A111', 'A113', 'A115', 'A117', 'A119']);
    // Un job più grande non cambia i valori già assegnati ai record.
    expect(values(g, records, 1000)).toEqual(partial);
  });

  it('rifiuta i numeri negativi', () => {
    const g = numbering({ start: 10, step: -5, digits: 3 });
    expect(values(g, [0, 1, 2])).toEqual(['010', '005', '000']);
    expect(() => resolve(g, 5)(3)).toThrow(/numero negativo \(-5\)/);
  });

  it('rifiuta i valori intermedi non esatti oltre 2^53', () => {
    // Intermedio t = 1 - 0 + 10000 × 10^12 = 10^16: non più un intero esatto.
    const jump = numbering({
      style: 'lettersNumber',
      alphabet: DEFAULT_LETTERS,
      groupStart: 'A',
      digits: 0,
      numberMin: 0,
      numberMax: 9,
      start: 1,
      step: 1e12,
    });
    expect(resolve(jump, 1)(0)).toBe('A1');
    expect(() => resolve(jump, 1)(10000)).toThrow(/oltre il limite di calcolo/);

    const huge = numbering({ start: Number.MAX_SAFE_INTEGER, step: 1, digits: 0 });
    expect(numberingBody(huge, 0)).toBe('9007199254740991');
    expect(() => numberingBody(huge, 1)).toThrow(/oltre il limite di calcolo/);
  });

  it('generatorProblem segnala le configurazioni impossibili', () => {
    expect(generatorProblem(numbering())).toBeNull();
    expect(generatorProblem(numbering({ style: 'lettersNumber', numberMin: 1, numberMax: 999, start: 0 }))).toBe(
      'il numero iniziale deve stare tra 1 e 999',
    );
    expect(generatorProblem(numbering({ style: 'letters', alphabet: 'AAB' }))).toContain('alfabeto non valido');
    expect(generatorProblem(numbering({ style: 'letters', alphabet: 'A😀B' }))).toMatch(/alfabeto non valido.*emoji/);
    expect(generatorProblem(numbering({ style: 'letters', alphabet: 'ABC', groupStart: 'D' }))).toContain(
      'gruppo iniziale non valido',
    );
    expect(
      generatorProblem(numbering({ style: 'lettersNumber', numberMin: 1, numberMax: 999, start: 1, step: 0 })),
    ).toBe('il passo non può essere 0');
    expect(() => resolve(numbering({ style: 'letters', alphabet: 'AAB' }), 1)).toThrow(
      /generatore "Numero": alfabeto non valido/,
    );
  });

  it('cerca i generatori per nome senza distinzione di maiuscole', () => {
    const set = compileGenerators([numbering({ name: 'Lotto', start: 7 })], { now: 0, count: 1 });
    expect(set.has('lotto')).toBe(true);
    expect(set.has('LOTTO')).toBe(true);
    expect(set.has('altro')).toBe(false);
    expect(set.get('LoTtO')!(0)).toBe('7');
    expect(set.get('altro')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- unique codes

/**
 * Independent implementation of the first HMAC block of hmac-sha256-ctr-v1:
 * HMAC-SHA-256(key, "DVP-U1" 0x00 alphabet 0x00 u32be(length) u64be(counter)).
 */
async function hmacBlock(keyHex: string, alphabet: string, length: number, counter: number): Promise<Uint8Array> {
  const key = Uint8Array.from(keyHex.match(/../g)!, (h) => parseInt(h, 16));
  const alphabetBytes = new TextEncoder().encode(alphabet);
  const msg = new Uint8Array(6 + 1 + alphabetBytes.length + 1 + 4 + 8);
  msg.set(new TextEncoder().encode('DVP-U1'), 0);
  msg[6] = 0;
  msg.set(alphabetBytes, 7);
  msg[7 + alphabetBytes.length] = 0;
  const view = new DataView(msg.buffer);
  view.setUint32(8 + alphabetBytes.length, length);
  view.setBigUint64(12 + alphabetBytes.length, BigInt(counter));
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg));
}

/** Accepted characters of a byte stream: b < 256 − 256 mod k, then alphabet[b mod k]. */
function acceptedChars(bytes: Uint8Array, alphabet: string, n: number): string {
  const k = alphabet.length;
  const limit = 256 - (256 % k);
  let s = '';
  for (const b of bytes) {
    if (b < limit) {
      s += alphabet[b % k];
      if (s.length === n) break;
    }
  }
  return s;
}

/** First codes fixed by the frozen algorithm, computed independently and then from uniqueCodes(). */
const GOLDEN_SAFE = ['2U3CG6NN', '8W59DPFZ', '2PMMGWXV', 'G9X2RM5M', 'YM5TUX7T'];
const GOLDEN_DIGITS = ['609265', '635638', '033089', '585252', '968400'];

describe('codici univoci', () => {
  it('rispetta i vettori golden di hmac-sha256-ctr-v1', async () => {
    // Primo blocco verificato con WebCrypto, senza passare dall'implementazione.
    const block = await hmacBlock(ZERO_KEY, SAFE, 8, 0);
    const first = acceptedChars(block, SAFE, 8);
    expect(first).toBe(GOLDEN_SAFE[0]);
    // Anche la seconda configurazione: primo blocco indipendente, poi i 5 codici fissati.
    expect(acceptedChars(await hmacBlock(AB_KEY, DIGITS, 6, 0), DIGITS, 6)).toBe(GOLDEN_DIGITS[0]);

    expect(uniqueCodes(unique({ key: ZERO_KEY, alphabet: SAFE, length: 8 }), 5).slice(0, 5)).toEqual(GOLDEN_SAFE);
    expect(uniqueCodes(unique({ key: AB_KEY, alphabet: DIGITS, length: 6 }), 5).slice(0, 5)).toEqual(GOLDEN_DIGITS);
  });

  it('con la cache fredda restituisce di nuovo esattamente i golden', () => {
    // Scalda la cache con una serie più lunga (la funzione restituisce l'array interno).
    expect(uniqueCodes(unique({ key: ZERO_KEY, alphabet: SAFE, length: 8 }), 200)).toHaveLength(200);
    clearUniqueCache();
    const cold = uniqueCodes(unique({ key: ZERO_KEY, alphabet: SAFE, length: 8 }), 5);
    expect(cold).toHaveLength(5);
    expect(cold).toEqual(GOLDEN_SAFE);
  });

  it('non ripete codici su 100.000 record', () => {
    const codes = uniqueCodes(unique({ key: '01'.repeat(32), alphabet: SAFE, length: 8 }), 100_000);
    expect(codes).toHaveLength(100_000);
    expect(new Set(codes).size).toBe(100_000);
    expect(codes.every((c) => c.length === 8 && [...c].every((ch) => SAFE.includes(ch)))).toBe(true);
  });

  it('è stabile: i primi 10 codici restano tali anche estendendo la serie', () => {
    const g = unique({ key: '02'.repeat(32) });
    const first = uniqueCodes(g, 10).slice(0, 10);
    const long = uniqueCodes(g, 1000).slice(0, 1000);
    expect(long.slice(0, 10)).toEqual(first);
    // Stessa configurazione in un oggetto nuovo (cache non necessaria per la stabilità).
    expect(uniqueCodes(unique({ key: '02'.repeat(32) }), 10).slice(0, 10)).toEqual(first);
    // Chiamata ripetuta: stessi valori.
    expect(uniqueCodes(g, 10).slice(0, 10)).toEqual(first);
  });

  it('chiavi diverse danno codici diversi', () => {
    const a = uniqueCodes(unique({ key: '03'.repeat(32) }), 20).slice(0, 20);
    const b = uniqueCodes(unique({ key: '04'.repeat(32) }), 20).slice(0, 20);
    expect(a).not.toEqual(b);
    expect(a[0]).not.toBe(b[0]);
  });

  it('separa i domini per lunghezza: gli 8 caratteri non sono prefissi dei 10', () => {
    const key = '05'.repeat(32);
    const eight = uniqueCodes(unique({ key, length: 8 }), 20).slice(0, 20);
    const ten = uniqueCodes(unique({ key, length: 10 }), 20).slice(0, 20);
    expect(eight[0]).toHaveLength(8);
    expect(ten[0]).toHaveLength(10);
    for (let i = 0; i < 20; i++) expect(ten[i].startsWith(eight[i]), `codice ${i}`).toBe(false);
  });

  it('rifiuta più codici della capacità utilizzabile (metà del dominio)', () => {
    expect(uniqueCapacity({ alphabet: '01', length: 4 })).toBe(16);
    expect(MAX_UNIQUE_FILL).toBe(0.5);
    expect(uniqueMaxRecords({ alphabet: '01', length: 4 })).toBe(8);
    const g = unique({ key: '06'.repeat(32), alphabet: '01', length: 4 });
    const codes = uniqueCodes(g, 8).slice(0, 8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(() => uniqueCodes(g, 9)).toThrow(/servono 9 codici/);
    expect(() => uniqueCodes(g, 9)).toThrow(/al massimo 8/);
  });

  it('scarta i duplicati su un dominio piccolo', () => {
    const g = unique({ key: '07'.repeat(32), alphabet: 'AB', length: 3 });
    const codes = uniqueCodes(g, 4).slice(0, 4);
    expect(codes).toHaveLength(4);
    expect(new Set(codes).size).toBe(4);
    for (const c of codes) {
      expect(c).toHaveLength(3);
      expect([...c].every((ch) => ch === 'A' || ch === 'B')).toBe(true);
    }
    expect(() => uniqueCodes(g, 5)).toThrow(/servono 5 codici/);
  });

  it('compila prefisso e suffisso e dà lo stesso codice a ogni zona', () => {
    const g = unique({ key: '08'.repeat(32), prefix: 'ID-', suffix: '-X' });
    const set = compileGenerators([g], { now: 0, count: 5 });
    const fn = set.get('codice')!;
    const codes = uniqueCodes(g, 5).slice(0, 5);
    expect([0, 1, 2, 3, 4].map((i) => fn(i))).toEqual(codes.map((c) => `ID-${c}-X`));
    expect(fn(2)).toBe(fn(2));
    expect(() => fn(5)).toThrow(/nessun codice per il record 6/);
  });

  it('generatorProblem segnala chiave, alfabeto e lunghezza non validi', () => {
    expect(generatorProblem(unique())).toBeNull();
    expect(generatorProblem(unique({ key: 'zz' }))).toContain('chiave non valida');
    expect(generatorProblem(unique({ alphabet: 'AAB' }))).toContain('caratteri ammessi non validi');
    expect(generatorProblem(unique({ length: 0 }))).toContain('lunghezza non valida');
  });
});

// ---------------------------------------------------------------- date / time

const NOW = Date.UTC(2026, 10, 18, 13, 35);
const ROME = 'Europe/Rome';

describe('generatori di data e ora', () => {
  it('formatta lo stesso istante in tutti i formati', () => {
    const expected: Record<DateFormat, string> = {
      'dd/MM/yyyy': '18/11/2026',
      'dd-MM-yyyy': '18-11-2026',
      'dd/MM/yy': '18/11/26',
      'dd/MM/yyyy HH:mm': '18/11/2026 14:35',
      'HH:mm': '14:35',
      'yyyy-MM-dd': '2026-11-18',
      'yyyy-MM-dd HH:mm': '2026-11-18 14:35',
    };
    expect(civilTime(NOW, ROME)).toEqual({ year: 2026, month: 11, day: 18, hour: 14, minute: 35 });
    expect(
      DATE_FORMATS.map(([f]) => f)
        .slice()
        .sort(),
    ).toEqual((Object.keys(expected) as DateFormat[]).sort());
    for (const [format] of DATE_FORMATS) {
      expect(formatParts(civilTime(NOW, ROME), format)).toBe(expected[format]);
      expect(formatDateTime(dateTime({ mode: 'job', timeZone: ROME, format }), NOW)).toBe(expected[format]);
    }
  });

  it('applica l’ora legale estiva (UTC+2) e i due cambi d’ora del 2026', () => {
    expect(civilTime(Date.UTC(2026, 6, 15, 10, 0), ROME)).toEqual({ year: 2026, month: 7, day: 15, hour: 12, minute: 0 });
    // Ultima domenica di marzo: 01:00 UTC, le 02:00 locali diventano 03:00.
    expect(civilTime(Date.UTC(2026, 2, 29, 0, 59), ROME)).toEqual({ year: 2026, month: 3, day: 29, hour: 1, minute: 59 });
    expect(civilTime(Date.UTC(2026, 2, 29, 1, 0), ROME)).toEqual({ year: 2026, month: 3, day: 29, hour: 3, minute: 0 });
    // Ultima domenica di ottobre: 01:00 UTC, le 03:00 locali tornano alle 02:00.
    expect(civilTime(Date.UTC(2026, 9, 25, 0, 59), ROME)).toEqual({ year: 2026, month: 10, day: 25, hour: 2, minute: 59 });
    expect(civilTime(Date.UTC(2026, 9, 25, 1, 0), ROME)).toEqual({ year: 2026, month: 10, day: 25, hour: 2, minute: 0 });
  });

  it('usa UTC e America/New_York', () => {
    expect(civilTime(NOW, 'UTC')).toEqual({ year: 2026, month: 11, day: 18, hour: 13, minute: 35 });
    expect(civilTime(NOW, 'America/New_York')).toEqual({ year: 2026, month: 11, day: 18, hour: 8, minute: 35 });
    expect(formatDateTime(dateTime({ mode: 'job', timeZone: 'America/New_York', format: 'yyyy-MM-dd HH:mm' }), NOW)).toBe(
      '2026-11-18 08:35',
    );
  });

  it('scrive la mezzanotte come 00:00, mai 24:00', () => {
    const t = civilTime(Date.UTC(2026, 10, 18, 23, 0), ROME);
    expect(t).toEqual({ year: 2026, month: 11, day: 19, hour: 0, minute: 0 });
    expect(formatParts(t, 'HH:mm')).toBe('00:00');
    expect(formatParts(t, 'dd/MM/yyyy HH:mm')).toBe('19/11/2026 00:00');
  });

  it('in modalità fissata ignora `now` e il fuso orario', () => {
    const g = dateTime({
      mode: 'fixed',
      fixed: '2026-03-01T09:05',
      timeZone: 'America/New_York',
      format: 'yyyy-MM-dd HH:mm',
    });
    expect(formatDateTime(g, 0)).toBe('2026-03-01 09:05');
    expect(formatDateTime(g, Date.UTC(2031, 5, 1, 12, 0))).toBe('2026-03-01 09:05');
    // Il fuso non è usato: anche uno non valido non ha effetto.
    expect(generatorProblem(dateTime({ mode: 'fixed', fixed: '2026-03-01T09:05', timeZone: 'Marte/Olympus' }))).toBeNull();
    expect(formatDateTime(dateTime({ mode: 'fixed', fixed: '2026-03-01T09:05', timeZone: 'Marte/Olympus' }), 0)).toBe(
      '01/03/2026',
    );
  });

  it('applica prefisso e suffisso alla data', () => {
    const g = dateTime({ mode: 'fixed', fixed: '2026-11-18T14:35', format: 'dd/MM/yyyy', prefix: 'Data: ', suffix: '.' });
    expect(resolve(g, 1)(0)).toBe('Data: 18/11/2026.');
  });

  it('parseCivil accetta solo date e ore reali', () => {
    expect(parseCivil('2026-11-18T14:35')).toEqual({ year: 2026, month: 11, day: 18, hour: 14, minute: 35 });
    expect(parseCivil('2024-02-29T00:00')).toEqual({ year: 2024, month: 2, day: 29, hour: 0, minute: 0 });
    expect(parseCivil('2026-02-30T10:00')).toBeNull();
    expect(parseCivil('2026-02-29T10:00')).toBeNull();
    expect(parseCivil('2026-11-18T25:00')).toBeNull();
    expect(parseCivil('2026-11-18 14:35')).toBeNull();
    expect(parseCivil('18/11/2026')).toBeNull();
    // Anni a 4 cifre: 1000–9999 (Date.UTC interpreterebbe 0–99 come 1900–1999).
    expect(parseCivil('0999-12-31T23:59')).toBeNull();
    expect(parseCivil('1000-01-01T00:00')).toEqual({ year: 1000, month: 1, day: 1, hour: 0, minute: 0 });
  });

  it('generatorProblem segnala fusi e date non validi', () => {
    expect(generatorProblem(dateTime())).toBeNull();
    expect(generatorProblem({ ...dateTime(), timeZone: '' })).toBe('fuso orario mancante');
    expect(generatorProblem({ ...dateTime(), timeZone: undefined as unknown as string })).toBe('fuso orario mancante');
    expect(() =>
      compileGenerators([{ ...dateTime(), timeZone: '' }], { now: NOW, count: 1 }).get('Data'),
    ).toThrow(/fuso orario mancante/);
    const badZone = dateTime({ mode: 'job', timeZone: 'Marte/Olympus' });
    expect(generatorProblem(badZone)).toBe('fuso orario non valido: Marte/Olympus');
    expect(() => civilTime(NOW, 'Marte/Olympus')).toThrow(/fuso orario non valido/);
    expect(() => compileGenerators([badZone], { now: NOW, count: 1 }).get('Data')).toThrow(/fuso orario non valido/);
    expect(generatorProblem(dateTime({ mode: 'fixed', fixed: '2026-02-30T10:00' }))).toBe('data fissata non valida');
    expect(() => formatDateTime(dateTime({ mode: 'fixed', fixed: '2026-02-30T10:00' }), 0)).toThrow(/data fissata non valida/);
  });
});

// ---------------------------------------------------------------- names

describe('nomi dei generatori e segnaposto', () => {
  it('valida i nomi utilizzabili in {@Nome}', () => {
    expect(nameProblem('Lotto')).toBeNull();
    expect(nameProblem('Lotto 1')).toBeNull();
    // Virgole, due punti, parentesi e spazi interni sono ammessi.
    expect(nameProblem('Prezzo, €')).toBeNull();
    expect(nameProblem('Cognome: Nome')).toBeNull();
    expect(nameProblem('Peso [kg] (netto)')).toBeNull();
    expect(nameProblem('x'.repeat(40))).toBeNull();
    expect(nameProblem('')).toBe('nome vuoto');
    expect(nameProblem('   ')).toBe('nome vuoto');
    expect(nameProblem(' Lotto')).toBe('il nome non può iniziare o finire con uno spazio');
    expect(nameProblem('Lotto ')).toBe('il nome non può iniziare o finire con uno spazio');
    expect(nameProblem('@Lotto')).toBe('il nome non può iniziare con @ o #');
    expect(nameProblem('#Lotto')).toBe('il nome non può iniziare con @ o #');
    for (const bad of ['Lo|tto', 'Lo"tto', 'Lo{tto', 'Lotto}', 'Lo\ttto', 'Lo\n tto']) {
      expect(nameProblem(bad)).toBe('il nome non può contenere { } | " né caratteri di controllo');
    }
    expect(nameProblem('x'.repeat(41))).toBe('nome troppo lungo (massimo 40 caratteri)');
  });

  it('elenca i generatori citati, senza il contatore e le colonne', () => {
    expect(referencedGenerators('{#} {@Lotto} / {@Data} / {@lotto} / {@ Lotto }')).toEqual([
      'Lotto',
      'Data',
      'lotto',
      'Lotto',
    ]);
    // Gli spazi interni al token sono letti come in compileContent.
    expect(referencedGenerators('{ @Codice } / {@ Codice} / {@Codice }')).toEqual(['Codice', 'Codice', 'Codice']);
    expect(referencedGenerators('{Cliente} {#}')).toEqual([]);
    expect(referencedGenerators('')).toEqual([]);
  });

  it('rinomina nelle zone senza toccare contatore e colonne', () => {
    // Only the name range changes: spaces and filters inside the placeholder stay byte for byte.
    expect(renameInContent('{#} {@lotto}-{@Lotto2} {Cliente} {@ LOTTO }', 'Lotto', 'Codice')).toBe(
      '{#} {@Codice}-{@Lotto2} {Cliente} {@ Codice }',
    );
    expect(renameInContent('{ @Codice } {@ Codice} {@Altro}', 'codice', 'Nuovo')).toBe(
      '{ @Nuovo } {@ Nuovo} {@Altro}',
    );
    expect(renameInContent('{@Lotto}', 'lotto', 'Numero')).toBe('{@Numero}');
    // Case-insensitive match, everything else untouched.
    expect(renameInContent('{@CODICE} {@codice}', 'Codice', 'Nuovo')).toBe('{@Nuovo} {@Nuovo}');
    expect(renameInContent('{Lotto} {@Lotto}', 'Lotto', 'Codice')).toBe('{Lotto} {@Codice}');
    expect(renameInContent('{@Lotto}', 'Lotto', 'Lotto')).toBe('{@Lotto}');
    expect(renameInContent('{@Codice|right:4} {@ CODICE |digits|right:4}', 'codice', 'Nuovo')).toBe(
      '{@Nuovo|right:4} {@ Nuovo |digits|right:4}',
    );
    // A lexical error after the placeholder stops the parse, not the rename or the text that follows.
    expect(renameInContent('{@Codice} {rotto', 'Codice', 'Nuovo')).toBe('{@Nuovo} {rotto');
    // Argument text is not a reference: it is never renamed.
    expect(renameInContent('{A|prefix:"{@Codice}"}', 'Codice', 'Nuovo')).toBe('{A|prefix:"{@Codice}"}');
  });
});
