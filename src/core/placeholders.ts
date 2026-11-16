import type { Counter, DataSet } from './types';

const PLACEHOLDER = /\{([^{}]+)\}/g;
export const COUNTER_TOKEN = '#';

/** Column names referenced by a content string (excluding the counter). */
export function referencedColumns(content: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    if (name !== COUNTER_TOKEN) names.add(name);
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
 * Builds a resolver for a dataset: column lookup is done once, so resolving
 * a record is just string concatenation.
 */
export function compileContent(
  content: string,
  counter: Counter,
  data: DataSet | null,
): (recordIndex: number) => string {
  const parts: Array<string | ((i: number) => string)> = [];
  let last = 0;
  for (const m of content.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push(content.slice(last, m.index));
    const name = m[1].trim();
    if (name === COUNTER_TOKEN) {
      parts.push((i) => formatCounter(counter, i));
    } else {
      const col = data ? data.columns.indexOf(name) : -1;
      if (col < 0) throw new Error(`Colonna "${name}" non presente nei dati`);
      const rows = data!.rows;
      parts.push((i) => rows[i]?.[col] ?? '');
    }
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push(content.slice(last));
  return (i) => parts.map((p) => (typeof p === 'string' ? p : p(i))).join('');
}
