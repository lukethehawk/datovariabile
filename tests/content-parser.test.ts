import { describe, expect, it } from 'vitest';
import { compileContent, columnRef, contentProblem, isStaticallyEmpty, parseContent, type PlaceholderNode } from '../src/core/placeholders';
import { compileGenerators, DEFAULT_LETTERS, nameProblem, referencedGenerators } from '../src/core/generators';
import type { Counter, DataSet, NumberingGenerator } from '../src/core/types';

/** A generator whose value is "start", so resolved values are easy to read. */
function numbering(overrides: Partial<NumberingGenerator> = {}): NumberingGenerator {
  return {
    id: 'n1',
    name: 'Codice',
    type: 'numbering',
    prefix: '',
    suffix: '',
    style: 'number',
    start: 1000,
    step: 1,
    digits: 6,
    alphabet: DEFAULT_LETTERS,
    groupStart: 'A',
    numberMin: 1,
    numberMax: 999,
    overflow: 'grow',
    ...overrides,
  };
}

const data: DataSet = {
  columns: ['A', 'Nome', 'Prezzo, €', 'Cognome, Nome', 'Peso [kg]', '@Gift', '@Nome', 'C:\\Dati', 'Codice\narticolo', 'Peso {kg}', ' spazi ', 'Codice'],
  rows: [['abcde', 'Anna', '12,50 €', 'Rossi, Mario', '10 kg', 'col-gift', 'col-nome', 'dati', 'riga\narticolo', 'peso', 'spazi', 'FT2026A001234']],
};

const generators = compileGenerators(
  [numbering(), numbering({ id: 'n2', name: 'Gift', start: 7, digits: 0 })],
  { now: 0, count: 10 },
);

const counter: Counter = { start: 5, step: 2, digits: 0 };
const resolve = (content: string, record = 0) => compileContent(content, counter, data, generators)(record);
const problem = (content: string) => contentProblem(content, data.columns, (n) => generators.has(n));

const placeholder = (content: string): PlaceholderNode => {
  const node = parseContent(content).nodes[0];
  expect(node?.type).toBe('placeholder');
  return node as PlaceholderNode;
};

describe('content lexicon and free text', () => {
  it('reads doubled braces as literal text', () => {
    expect(parseContent('{{').nodes).toEqual([{ type: 'text', value: '{' }]);
    expect(parseContent('}}').nodes).toEqual([{ type: 'text', value: '}' }]);
    expect(parseContent('{{Nome}}').nodes).toEqual([{ type: 'text', value: '{Nome}' }]);
    expect(resolve('{{Nome}}')).toBe('{Nome}');
  });

  it('wraps a value in literal braces', () => {
    expect(resolve('{{{A}}}')).toBe('{abcde}');
    expect(resolve('{A}}}')).toBe('abcde}');
  });

  it('keeps backslashes literal in free text', () => {
    expect(resolve('C:\\Stampa')).toBe('C:\\Stampa');
    expect(parseContent('C:\\Stampa').nodes).toEqual([{ type: 'text', value: 'C:\\Stampa' }]);
  });

  it('reports an unclosed brace with its 1-based character position', () => {
    const parsed = parseContent('{promo');
    expect(parsed.error).toContain('graffa non chiusa');
    expect(parsed.error).toContain('al carattere 1');
    expect(parsed.errorAt).toBe(0);
  });

  it('keeps the placeholders read before a lexical error', () => {
    const parsed = parseContent('{A} {promo');
    expect(parsed.error).toContain('graffa non chiusa');
    expect(parsed.nodes[0]).toMatchObject({ type: 'placeholder', source: { kind: 'column', name: 'A' } });
    expect(parsed.nodes[1]).toEqual({ type: 'text', value: ' ' });
  });

  it('reports an isolated closing brace', () => {
    expect(parseContent('Sconto :-}').error).toContain('graffa di chiusura isolata');
    expect(parseContent('Sconto :-}').error).toContain('al carattere 10');
  });

  it('reports an empty placeholder', () => {
    expect(problem('{}')).toContain('segnaposto vuoto');
    expect(problem('{ }')).toContain('segnaposto vuoto');
    expect(parseContent('{}').nodes[0]).toMatchObject({ type: 'placeholder', error: 'segnaposto vuoto al carattere 1' });
  });

  it('reports a brace inside a placeholder', () => {
    const parsed = parseContent('{A{B}');
    expect(parsed.error).toContain('graffa non ammessa dentro il segnaposto');
    expect(parsed.error).toContain('al carattere 3');
  });

  it('reports unclosed quotes with their position', () => {
    const parsed = parseContent('{A|prefix:"x}');
    expect(parsed.error).toContain('virgolette non chiuse');
    expect(parsed.error).toContain('al carattere 11');
  });

  it('counts positions in code points when an emoji precedes the error', () => {
    // The emoji is two UTF-16 units; the user must still see character 2, not 3.
    const parsed = parseContent('😀{');
    expect(parsed.error).toContain('al carattere 2');
    expect(parsed.error).not.toContain('al carattere 3');
  });

  it('rejects an undoubled JSON placeholder', () => {
    expect(problem('{"t":"A|B"}')).toContain('atteso "|"');
  });

  it('builds exact JSON in a QR from doubled braces', () => {
    expect(resolve('{{"id":"{Codice}"}}')).toBe('{"id":"FT2026A001234"}');
  });

  it('accepts JSON escapes and rejects invalid escapes', () => {
    expect(problem('{"C:\\Dati"}')).toContain('escape');
    expect(resolve('{"C:\\\\Dati"}')).toBe('dati');
  });
});

describe('placeholder grammar', () => {
  it('reads the counter with spaces around it', () => {
    expect(resolve('{ # }')).toBe('5');
    expect(resolve('{ # }', 2)).toBe('9');
  });

  it('suggests quoting a name that starts with #', () => {
    const message = problem('{#x}');
    expect(message).toContain('va scritto tra virgolette');
    expect(message).toContain('{"#x"}');
  });

  it('treats {@Nome} only as a generator, even with a column named @Nome', () => {
    expect(data.columns).toContain('@Nome');
    expect(() => resolve('{@Nome}')).toThrow('generatore "Nome" inesistente');
    expect(problem('{@Nome}')).toBe('generatore "Nome" inesistente');
  });

  it('distinguishes a quoted column from a generator in the same content', () => {
    expect(resolve('{"@Gift"}')).toBe('col-gift');
    expect(resolve('{@Gift}')).toBe('7');
    expect(resolve('{"@Gift"}|{@Gift}')).toBe('col-gift|7');
  });

  it('ignores spaces around a generator name and compares it case-insensitively', () => {
    expect(resolve('{ @Gift }')).toBe('7');
    expect(resolve('{@gift}')).toBe('7');
  });

  it('rejects quoted generator names', () => {
    expect(problem('{@"X"}')).toContain('i nomi dei generatori non vanno tra virgolette');
  });

  it('accepts bare names with comma, colon, brackets and spaces', () => {
    expect(resolve('{Prezzo, €}')).toBe('12,50 €');
    expect(resolve('{Cognome, Nome}')).toBe('Rossi, Mario');
    expect(resolve('{Peso [kg]|upper}')).toBe('10 KG');
    expect(placeholder('{A:B}').source).toEqual({ kind: 'column', name: 'A:B' });
  });

  it('reads quoted column names with braces and newlines', () => {
    expect(resolve('{"Peso {kg}"}')).toBe('peso');
    expect(resolve('{"Codice\\narticolo"}')).toBe('riga\narticolo');
  });

  it('does not silently drop a newline at the edge of a bare name', () => {
    expect(problem('{A\n}')).toContain('va scritto tra virgolette');
    expect(problem('{@Gift\r\n}')).toContain('nome di generatore non valido');
    expect(resolve('{ A\t}')).toBe('abcde');
  });

  it('reads filter names case-insensitively and ignores spaces around | and :', () => {
    expect(resolve('{A|UPPER}')).toBe('ABCDE');
    expect(resolve('{A|RIGHT:2}')).toBe('de');
    expect(resolve('{A | right : 2}')).toBe('de');
    expect(placeholder('{A | right : 2}').filters).toEqual([{ name: 'right', args: [{ text: '2', quoted: false }] }]);
  });

  it('keeps { } | : inside quoted arguments', () => {
    expect(resolve('{A|prefix:"{|}:"}')).toBe('{|}:abcde');
  });

  it('names the unknown filter and quotes the placeholder', () => {
    expect(problem('{A|rigth:4}')).toBe('{A|rigth:4}: filtro "rigth" sconosciuto');
  });

  it('checks filter arity', () => {
    expect(problem('{A|right}')).toContain('right richiede 1 argomento');
    expect(problem('{A|digits:1}')).toContain('digits richiede nessun argomento');
  });

  it('reports a missing column or generator', () => {
    expect(problem('{Manca}')).toBe('Colonna "Manca" non presente nei dati');
    expect(() => resolve('{Manca}')).toThrow('Colonna "Manca" non presente nei dati');
    expect(problem('{@Manca}')).toBe('generatore "Manca" inesistente');
    expect(() => resolve('{@Manca}')).toThrow('generatore "Manca" inesistente');
  });
});

describe('serializer property', () => {
  const trickyNames = [
    'A|B',
    '{x}',
    'a}b',
    'a"b',
    'a\\b',
    '@at',
    '#hash',
    ' edge ',
    'riga\nnuova',
    'A,B',
    'Prezzo, €',
    'Peso [kg]',
    '😀 emoji',
    ' spazi ',
    'a:b',
  ];

  it('parses columnRef(n) back to the column n', () => {
    for (const name of trickyNames) {
      const parsed = parseContent('{' + columnRef(name) + '}');
      expect(parsed.error, name).toBeNull();
      expect(parsed.nodes, name).toHaveLength(1);
      expect(parsed.nodes[0], name).toMatchObject({ type: 'placeholder', error: null, source: { kind: 'column', name } });
    }
  });

  it('parses every name accepted by nameProblem as a generator', () => {
    const candidates = [
      'Codice',
      'Nome lungo',
      'A:B',
      'Prezzo, €',
      'Peso [kg]',
      'a-b.c/d',
      'è accentato',
      '😀 emoji',
      'a\\b',
      '',
      ' x',
      'x ',
      '@x',
      '#x',
      'a|b',
      'a{b',
      'a}b',
      'a"b',
      'a\nb',
      'x'.repeat(41),
    ];
    let accepted = 0;
    for (const name of candidates) {
      if (nameProblem(name) !== null) continue;
      accepted++;
      const parsed = parseContent('{@' + name + '}');
      expect(parsed.error, name).toBeNull();
      expect(parsed.nodes[0], name).toMatchObject({ type: 'placeholder', error: null, source: { kind: 'generator', name } });
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('generator references', () => {
  it('counts a generator used through filters', () => {
    expect(referencedGenerators('{@Codice|right:4}')).toEqual(['Codice']);
  });

  it('counts a generator even when a filter is invalid', () => {
    expect(referencedGenerators('{@Codice|rigth:4}')).toEqual(['Codice']);
  });

  it('does not count generator names written in argument text', () => {
    expect(referencedGenerators('{A|prefix:"{@Gift}"}')).toEqual([]);
  });

  it('lists every generator source in order', () => {
    expect(referencedGenerators('{@Codice}{@Gift}{"@Gift"}')).toEqual(['Codice', 'Gift']);
  });
});

describe('static checks', () => {
  it('accepts content that compiles against the columns', () => {
    expect(contentProblem('{A}', data.columns, () => false)).toBeNull();
    expect(contentProblem('{{testo}}', data.columns, () => false)).toBeNull();
  });

  it('treats missing columns as errors when no dataset is open', () => {
    expect(contentProblem('{A}', null, () => false)).toBe('Colonna "A" non presente nei dati');
  });

  it('detects statically empty content', () => {
    expect(isStaticallyEmpty('')).toBe(true);
    expect(isStaticallyEmpty('{{}}')).toBe(false);
    expect(isStaticallyEmpty('{A}')).toBe(false);
    expect(isStaticallyEmpty('  ')).toBe(false);
    expect(isStaticallyEmpty('{}')).toBe(false);
  });
});
