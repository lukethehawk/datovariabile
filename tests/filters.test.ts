import { describe, expect, it } from 'vitest';
import { compileFilters, FILTERS, LIMITS } from '../src/core/filters';
import { compileContent } from '../src/core/placeholders';
import type { Counter, DataSet } from '../src/core/types';

const counter: Counter = { start: 1, step: 1, digits: 0 };
const data = (value: string): DataSet => ({ columns: ['V'], rows: [[value]] });

/** Compiles a content over a single record whose column V holds `value`. */
const resolve = (content: string, value: string, index = 0): string => compileContent(content, counter, data(value))(index);

/** Message of the static error thrown by compileContent (fails when it compiles). */
function staticError(content: string): string {
  try {
    compileContent(content, counter, data(''));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`nessun errore statico per ${content}`);
}

/** Message of the per-record error thrown by the compiled resolver (fails when it resolves). */
function recordError(content: string, value: string): string {
  try {
    compileContent(content, counter, data(value))(0);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`nessun errore per record per ${content}`);
}

describe('filter table (§5)', () => {
  it('has the 13 approved filters with their Italian labels', () => {
    const labels = Object.fromEntries(Object.entries(FILTERS).map(([name, def]) => [name, def.label]));
    expect(labels).toEqual({
      left: 'Primi caratteri',
      right: 'Ultimi caratteri',
      mid: 'Caratteri da una posizione',
      digits: 'Solo cifre',
      upper: 'Tutto maiuscolo',
      lower: 'Tutto minuscolo',
      trim: 'Togli spazi ai bordi',
      nospace: 'Togli tutti gli spazi',
      replace: 'Sostituisci testo',
      prefix: 'Aggiungi testo prima',
      suffix: 'Aggiungi testo dopo',
      padleft: 'Completa a sinistra',
      padright: 'Completa a destra',
    });
  });

  it('marks only the filters that can shorten or change a unique code', () => {
    const reducers = Object.entries(FILTERS)
      .filter(([, def]) => def.reduces)
      .map(([name]) => name)
      .sort();
    expect(reducers).toEqual(['digits', 'left', 'lower', 'mid', 'nospace', 'replace', 'right', 'trim', 'upper']);
  });

  it('maps the empty value to empty in every filter (§5, §6.1)', () => {
    const contents = [
      '{V|left:2}',
      '{V|right:2}',
      '{V|mid:1:2}',
      '{V|digits}',
      '{V|upper}',
      '{V|lower}',
      '{V|trim}',
      '{V|nospace}',
      '{V|replace:"a":"b"}',
      '{V|prefix:"FT-"}',
      '{V|suffix:"-IT"}',
      '{V|padleft:8:0}',
      '{V|padright:8:0}',
    ];
    for (const content of contents) expect(resolve(content, ''), content).toBe('');
  });
});

describe('left, right, mid', () => {
  it('keeps the first or last N characters, empty at N=0, all beyond the length', () => {
    expect(resolve('{V|left:3}', 'ABCDEF')).toBe('ABC');
    expect(resolve('{V|left:0}', 'ABCDEF')).toBe('');
    expect(resolve('{V|left:10}', 'ABC')).toBe('ABC');
    expect(resolve('{V|right:2}', 'ABCDEF')).toBe('EF');
    expect(resolve('{V|right:0}', 'ABC')).toBe('');
    expect(resolve('{V|right:10}', 'ABC')).toBe('ABC');
  });

  it('counts mid from position 1 and clamps the end', () => {
    expect(resolve('{V|mid:2:3}', 'ABCDEF')).toBe('BCD');
    expect(resolve('{V|mid:1:0}', 'ABC')).toBe('');
    expect(resolve('{V|mid:5:2}', 'ABC')).toBe('');
    expect(resolve('{V|mid:2:100}', 'ABCDE')).toBe('BCDE');
  });

  it('rejects position 0', () => {
    expect(staticError('{V|mid:0:2}')).toContain('mid: la posizione parte da 1');
  });

  it('accepts filter names in upper case', () => {
    expect(resolve('{V|RIGHT:2}', 'ABCDE')).toBe('DE');
  });
});

describe('digits, upper, lower', () => {
  it('digits keeps only ASCII digits, in order', () => {
    expect(resolve('{V|digits}', 'AB-123-CD45')).toBe('12345');
    expect(resolve('{V|digits}', 'ABC')).toBe('');
    expect(resolve('{V|digits}', '１２３A4５')).toBe('4');
  });

  it('upper and lower are language independent and may change the length', () => {
    expect(resolve('{V|upper}', 'straße')).toBe('STRASSE');
    expect(resolve('{V|lower}', 'ÀBC')).toBe('àbc');
  });
});

describe('trim, nospace', () => {
  it('trim removes whitespace at the edges, including NBSP and BOM', () => {
    expect(resolve('{V|trim}', '\u00A0\t\uFEFF ABC \n')).toBe('ABC');
  });

  it('trim does not remove U+200B', () => {
    expect(resolve('{V|trim}', '\u200B abc \u200B')).toBe('\u200B abc \u200B');
  });

  it('nospace removes the same whitespace everywhere but not U+200B', () => {
    expect(resolve('{V|nospace}', ' A\tB\nC\u00A0D\uFEFFE ')).toBe('ABCDE');
    expect(resolve('{V|nospace}', 'A\u200BB')).toBe('A\u200BB');
  });
});

describe('replace', () => {
  it('substitutes every literal, case-sensitive occurrence', () => {
    expect(resolve('{V|replace:"-":"/"}', '2026-11-19')).toBe('2026/11/19');
    expect(resolve('{V|replace:"a":"x"}', 'aAa')).toBe('xAx');
    expect(resolve('{V|replace:"x":"y"}', 'abc')).toBe('abc');
  });

  it('treats $& and $1 in the replacement as literal text', () => {
    expect(resolve('{V|replace:"b":"$&$1"}', 'ab')).toBe('a$&$1');
  });

  it('accepts | : { inside quoted arguments', () => {
    expect(resolve('{V|replace:"|":":"}', 'A|B|C')).toBe('A:B:C');
    expect(resolve('{V|replace:"{":"}"}', 'A{B')).toBe('A}B');
    expect(resolve('{V|replace:":":"|"}', 'A:B')).toBe('A|B');
  });

  it('refuses an empty search text', () => {
    expect(staticError('{V|replace:"":""}')).toContain('replace: il testo da cercare non può essere vuoto');
  });
});

describe('prefix, suffix, padding', () => {
  it('prefix and suffix add text but never fill an empty value', () => {
    expect(resolve('{V|prefix:"FT-"}', 'ABC')).toBe('FT-ABC');
    expect(resolve('{V|suffix:"-IT"}', 'ABC')).toBe('ABC-IT');
    expect(resolve('{V|prefix:"FT-"}', '')).toBe('');
    expect(resolve('{V|suffix:"-IT"}', '')).toBe('');
  });

  it('padleft and padright pad to a minimum length and never truncate', () => {
    expect(resolve('{V|padleft:8:0}', '123')).toBe('00000123');
    expect(resolve('{V|padright:5:0}', '123')).toBe('12300');
    expect(resolve('{V|padleft:2:0}', 'ABCDE')).toBe('ABCDE');
    expect(resolve('{V|padright:2:0}', 'ABCDE')).toBe('ABCDE');
  });

  it('pads spaces (not empty) and leaves the empty value empty', () => {
    expect(resolve('{V|padleft:5:0}', '  ')).toBe('000  ');
    expect(resolve('{V|padright:5:0}', '  ')).toBe('  000');
    expect(resolve('{V|padleft:8:0}', '')).toBe('');
    expect(resolve('{V|padright:8:0}', '')).toBe('');
  });

  it('refuses a fill character that is not exactly one character', () => {
    expect(staticError('{V|padleft:5:"00"}')).toContain('padleft: il carattere di riempimento deve essere uno solo');
  });

  it('asks for quotes around unquoted multi-character text and refuses quoted numbers', () => {
    expect(staticError('{V|prefix:abc}')).toContain('prefix: scrivi il testo tra virgolette, es. "abc"');
    expect(staticError('{V|padleft:"5":0}')).toContain('padleft: "5" non è un numero intero (lunghezza)');
  });
});

describe('chains', () => {
  it('runs the filters left to right', () => {
    expect(resolve('{V|trim|upper|right:4}', ' abcd ')).toBe('ABCD');
    expect(resolve('{V|digits|right:4}', 'AB12CD345')).toBe('2345');
    expect(resolve('{V|replace:"-":""|upper}', 'ab-012345')).toBe('AB012345');
    expect(resolve('{V|right:4|padleft:6:0}', 'AB12CD34')).toBe('00CD34');
  });

  it('keeps the empty value empty through digits then padding (§6.1)', () => {
    expect(resolve('{V|digits|padleft:6:0}', 'ABC')).toBe('');
  });

  it('pads a negative counter as text', () => {
    const value = compileContent('{#|padleft:6:0}', { start: -12, step: 1, digits: 0 }, null);
    expect(value(0)).toBe('000-12');
  });
});

describe('Unicode cuts (§7)', () => {
  it('refuses a cut that splits a combining accent', () => {
    expect(recordError('{V|right:1}', 'e\u0301')).toContain('il taglio spezzerebbe un carattere composto');
  });

  it('refuses cuts before and after the ZWJ of an emoji sequence', () => {
    const family = '👨\u200D👩\u200D👧';
    expect(recordError('{V|left:1}', family)).toContain('carattere composto');
    expect(recordError('{V|left:2}', family)).toContain('carattere composto');
  });

  it('refuses cuts inside a skin-tone modifier', () => {
    expect(recordError('{V|right:1}', '👍🏽')).toContain('carattere composto');
  });

  it('refuses cuts inside a flag built from regional indicators', () => {
    expect(recordError('{V|right:1}', '🇮🇹')).toContain('carattere composto');
  });

  it('refuses cuts inside a Hangul jamo sequence', () => {
    expect(recordError('{V|left:1}', '\u1100\u1161')).toContain('carattere composto');
  });

  it('refuses a cut between CR and LF', () => {
    expect(recordError('{V|left:2}', 'a\r\nb')).toContain('carattere composto');
  });

  it('allows extracting the whole string or nothing', () => {
    expect(resolve('{V|left:2}', 'e\u0301')).toBe('e\u0301');
    expect(resolve('{V|right:2}', 'e\u0301')).toBe('e\u0301');
    expect(resolve('{V|left:0}', 'e\u0301')).toBe('');
    expect(resolve('{V|mid:1:0}', 'e\u0301')).toBe('');
  });

  it('refuses a fill character that merges with its neighbours (static check)', () => {
    expect(staticError('{V|padleft:3:"\\u0301"}')).toContain('il carattere di riempimento deve essere un carattere a sé');
    expect(staticError('{V|padright:2:"\\u200D"}')).toContain('il carattere di riempimento deve essere un carattere a sé');
    expect(staticError('{V|padleft:4:"\\uD83C\\uDDEE"}')).toContain('il carattere di riempimento deve essere un carattere a sé');
    expect(() => staticError('{V|padleft:4:"é"}')).toThrow('nessun errore statico');
  });
});

describe('limits (§8)', () => {
  it('declares the approved limits', () => {
    expect(LIMITS).toEqual({ filters: 32, int: 10_000, text: 4096, value: 65_536 });
  });

  it('rejects more than 32 filters', () => {
    const content = `{V|${Array.from({ length: 33 }, () => 'upper').join('|')}}`;
    expect(staticError(content)).toContain('troppi filtri (massimo 32)');
  });

  it('rejects an integer above 10000', () => {
    expect(staticError('{V|left:10001}')).toContain('left: 10001 è troppo grande (massimo 10.000)');
  });

  it('rejects a text argument longer than 4096 characters', () => {
    const long = 'a'.repeat(LIMITS.text + 1);
    expect(staticError(`{V|prefix:"${long}"}`)).toContain('prefix: testo troppo lungo (massimo 4096 caratteri)');
  });

  it('rejects a replace expansion beyond 65536 UTF-16 units per record', () => {
    const put = 'x'.repeat(700);
    expect(recordError(`{V|replace:"a":"${put}"}`, 'a'.repeat(100))).toContain('valore troppo lungo (oltre 65.536 caratteri)');
  });

  it('limits every placeholder value, also without filters and after upper', () => {
    expect(recordError('{V}', 'a'.repeat(65_537))).toContain('valore troppo lungo');
    expect(resolve('{V}', 'a'.repeat(65_536))).toHaveLength(65_536);
    // 40 000 ß become 80 000 units with upper.
    expect(recordError('{V|upper}', 'ß'.repeat(40_000))).toContain('valore troppo lungo');
  });

  it('rejects unknown filters and wrong arity', () => {
    expect(() => compileFilters([{ name: 'rigth', args: [] }])).toThrow('filtro "rigth" sconosciuto');
    expect(() => compileFilters([{ name: 'right', args: [] }])).toThrow('right richiede 1 argomento');
    expect(() => compileFilters([{ name: 'digits', args: [{ text: '1', quoted: false }] }])).toThrow('digits richiede nessun argomento');
  });
});
