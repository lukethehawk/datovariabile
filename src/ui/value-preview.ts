import { compileGenerators, reducesUniqueCode, type GeneratorSet } from '../core/generators';
import { compileContent } from '../core/placeholders';
import type { Counter } from '../core/types';
import { state } from './state';

/**
 * Values shown in the editor ("Valore (record N)" and the ƒx dialog): the same compiler as the PDF,
 * on the current record, with the session's example instant for "date of generation" generators.
 */
export interface PreviewValue {
  value: string | null;
  error: string | null;
  /** Non-blocking: a filter shortens a unique code. */
  warning: string | null;
}

let cache: { key: string; count: number; set: GeneratorSet } | null = null;

/**
 * Generators for the preview, built once and reused while the definitions and the example instant stay
 * the same and the current record is covered (unique codes are drawn up to `count`), never per keystroke.
 */
function previewGenerators(record: number): GeneratorSet {
  const key = `${JSON.stringify(state.generators)}|${state.previewNow}`;
  // Like generate(): codes up to the requested record only (a partial reprint never needs more).
  if (!cache || cache.key !== key || cache.count < record + 1) cache = { key, count: record + 1, set: compileGenerators(state.generators, { now: state.previewNow, count: record + 1 }) };
  return cache.set;
}

export const SHORTENED_UNIQUE = 'La trasformazione riduce un codice univoco: il risultato potrebbe ripetersi su più record.';

/** Resolves `content` on the current preview record. */
export function previewValue(content: string, counter: Counter): PreviewValue {
  const record = state.record;
  const warning = reducesUniqueCode(content, state.generators) ? SHORTENED_UNIQUE : null;
  try {
    const resolve = compileContent(content, counter, state.data, previewGenerators(record));
    return { value: resolve(record), error: null, warning };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e), warning };
  }
}
