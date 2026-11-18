import type { GeneratorSet } from './generators';
import type { Counter, DataSet } from './types';

/** {…} tokens of a content. Global regex: use with matchAll/replace only. */
export const PLACEHOLDER = /\{([^{}]+)\}/g;
export const COUNTER_TOKEN = '#';

/** Generator name of a token ("@Nome", spaces allowed around both), or null if it is not a generator token. */
export function generatorToken(token: string): string | null {
  const t = token.trim();
  return t.startsWith('@') ? t.slice(1).trim() : null;
}

/** Column names referenced by a content string (excluding the counter and {@generators} that exist). */
export function referencedColumns(content: string, isGenerator: (name: string) => boolean = () => false): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    if (name === COUNTER_TOKEN) continue;
    if (name.startsWith('@') && isGenerator(name.slice(1).trim())) continue;
    names.add(name);
  }
  return [...names];
}

export function formatCounter(counter: Counter, recordIndex: number): string {
  const value = counter.start + recordIndex * counter.step;
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(Math.max(0, counter.digits), '0');
  return negative ? `-${digits}` : digits;
}

/**
 * Builds a resolver for a dataset: column and generator lookup is done once, so resolving
 * a record is just string concatenation. Tokens, in this order:
 * {#} the field counter; {@Nome} a data generator (an existing column literally named
 * "@Nome" is still used when no generator has that name; both existing is an error);
 * {Colonna} a data column.
 */
export function compileContent(
  content: string,
  counter: Counter,
  data: DataSet | null,
  generators: GeneratorSet | null = null,
): (recordIndex: number) => string {
  const parts: Array<string | ((i: number) => string)> = [];
  let last = 0;
  for (const m of content.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push(content.slice(last, m.index));
    const name = m[1].trim();
    const col = data ? data.columns.indexOf(name) : -1;
    const gen = name.startsWith('@') ? generators?.get(name.slice(1).trim()) : undefined;
    if (name === COUNTER_TOKEN) {
      parts.push((i) => formatCounter(counter, i));
    } else if (gen) {
      if (col >= 0) throw new Error(`{${name}} è sia un generatore sia una colonna dei dati: rinomina il generatore`);
      parts.push(gen);
    } else {
      if (col < 0) {
        throw new Error(name.startsWith('@') ? `generatore "${name.slice(1).trim()}" inesistente` : `Colonna "${name}" non presente nei dati`);
      }
      const rows = data!.rows;
      parts.push((i) => rows[i]?.[col] ?? '');
    }
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push(content.slice(last));
  return (i) => parts.map((p) => (typeof p === 'string' ? p : p(i))).join('');
}
