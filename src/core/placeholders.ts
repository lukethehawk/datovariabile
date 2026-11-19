/**
 * Contents of a zone: free text with placeholders {Sorgente|filtro:arg…}. One scanner/parser for every
 * consumer (compilation, static check, references, renaming, the ƒx dialog), so they always agree.
 * Specification: docs/SPECIFICA_FILTRI.md §4 (lexicon and grammar), §9 (errors), §10 (architecture).
 *
 * Free text: every character is literal except braces; a literal brace is written doubled ({{ or }}).
 * A "{" opens a placeholder that ends at the first "}" outside double quotes.
 */
import { compileFilters, type ArgToken, type FilterCall } from './filters';
import type { GeneratorSet } from './generators';
import type { Counter, DataSet } from './types';

export type Source = { kind: 'counter' } | { kind: 'generator'; name: string } | { kind: 'column'; name: string };

export interface TextNode {
  type: 'text';
  value: string;
}

export interface PlaceholderNode {
  type: 'placeholder';
  /** UTF-16 range of the whole placeholder, braces included. */
  start: number;
  end: number;
  /** null when the source itself is malformed. */
  source: Source | null;
  /** UTF-16 range of the name (generator name after "@", column name or its quoted form). */
  nameStart: number;
  nameEnd: number;
  filters: FilterCall[];
  /** Syntax error inside this placeholder (the source may still be known). */
  error: string | null;
}

export interface ParsedContent {
  nodes: Array<TextNode | PlaceholderNode>;
  /** Lexical error (unbalanced braces, unclosed quotes): parsing stopped there. */
  error: string | null;
  /** UTF-16 offset of the lexical error. */
  errorAt: number;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A name usable without quotes (columns and generators alike): non-empty, no spaces at the edges,
 * no { } | " or control characters, not starting with @ or #. Commas, colons, brackets… are fine.
 */
export function isBareName(name: string): boolean {
  return name.length > 0 && name === name.trim() && !/[{}|"]/.test(name) && !CONTROL.test(name) && !/^[@#]/.test(name);
}

/** How a column is written in a placeholder: as is when possible, otherwise as a JSON string. */
export const columnRef = (name: string): string => (isBareName(name) ? name : JSON.stringify(name));

/** Position shown to the user: characters (code points) from 1. */
export const charPosition = (content: string, offset: number): number => Array.from(content.slice(0, offset)).length + 1;

class SyntaxProblem extends Error {}

/** End (exclusive) of the JSON string starting at `i` (a double quote), or -1 if unclosed. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return -1;
}

function decodeString(literal: string): string {
  try {
    return JSON.parse(literal) as string;
  } catch {
    throw new SyntaxProblem(`testo tra virgolette non valido ${literal} (escape ammessi: \\" \\\\ \\n \\t \\uXXXX…)`);
  }
}

const isWs = (c: string | undefined) => c === ' ' || c === '\t';
/** Spaces and tabs around a name are syntax; any other character (newline…) belongs to the name and is checked. */
const trimWs = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '');

/** Parses the inside of a placeholder (between the braces); offsets are relative to the content. */
function parsePlaceholder(content: string, start: number, end: number): PlaceholderNode {
  const node: PlaceholderNode = { type: 'placeholder', start, end, source: null, nameStart: start + 1, nameEnd: start + 1, filters: [], error: null };
  const close = end - 1;
  let i = start + 1;
  const skip = () => {
    while (i < close && isWs(content[i])) i++;
  };
  /** Raw text up to the next "|" outside quotes (the bare name). */
  const untilPipe = () => {
    const from = i;
    while (i < close && content[i] !== '|') i++;
    return content.slice(from, i);
  };
  try {
    skip();
    if (i >= close) throw new SyntaxProblem(`segnaposto vuoto al carattere ${charPosition(content, start)}`);
    const c = content[i];
    if (c === '"') {
      const e = stringEnd(content, i);
      if (e === -1 || e > close) throw new SyntaxProblem('virgolette non chiuse');
      node.nameStart = i;
      node.nameEnd = e;
      node.source = { kind: 'column', name: decodeString(content.slice(i, e)) };
      i = e;
    } else if (c === '@') {
      i++;
      skip();
      if (content[i] === '"') throw new SyntaxProblem('i nomi dei generatori non vanno tra virgolette');
      const from = i;
      const raw = untilPipe();
      const name = trimWs(raw);
      node.nameStart = from + (raw.length - raw.replace(/^[ \t]+/, '').length);
      node.nameEnd = node.nameStart + name.length;
      if (!name) throw new SyntaxProblem('manca il nome del generatore dopo @');
      if (!isBareName(name)) throw new SyntaxProblem(`nome di generatore non valido: ${name}`);
      node.source = { kind: 'generator', name };
    } else {
      const from = i;
      const raw = untilPipe();
      const name = trimWs(raw);
      node.nameStart = from;
      node.nameEnd = from + raw.replace(/[ \t]+$/, '').length;
      if (name === '#') node.source = { kind: 'counter' };
      else if (isBareName(name)) node.source = { kind: 'column', name };
      else throw new SyntaxProblem(`il nome ${name} va scritto tra virgolette: {${JSON.stringify(name)}}`);
    }
    skip();
    while (i < close) {
      if (content[i] !== '|') throw new SyntaxProblem(`atteso "|" prima di "${content.slice(i, close).trim()}"`);
      i++;
      skip();
      const m = /^[A-Za-z][A-Za-z0-9]*/.exec(content.slice(i, close));
      if (!m) throw new SyntaxProblem('manca il nome del filtro dopo "|"');
      const call: FilterCall = { name: m[0].toLowerCase(), args: [] };
      i += m[0].length;
      skip();
      while (content[i] === ':' && i < close) {
        i++;
        skip();
        call.args.push(readArg());
        skip();
      }
      node.filters.push(call);
      if (i < close && content[i] !== '|') throw new SyntaxProblem(`carattere inatteso "${content[i]}" dopo il filtro ${call.name}`);
    }
  } catch (e) {
    if (!(e instanceof SyntaxProblem)) throw e;
    node.error = e.message;
  }
  return node;

  function readArg(): ArgToken {
    if (content[i] === '"') {
      const e = stringEnd(content, i);
      if (e === -1 || e > close) throw new SyntaxProblem('virgolette non chiuse');
      const text = decodeString(content.slice(i, e));
      i = e;
      return { text, quoted: true };
    }
    const from = i;
    while (i < close && !isWs(content[i]) && content[i] !== '|' && content[i] !== ':') i++;
    const text = content.slice(from, i);
    if (!text) throw new SyntaxProblem('argomento mancante dopo ":"');
    if (text.includes('"')) throw new SyntaxProblem(`argomento non valido: ${text}`);
    return { text, quoted: false };
  }
}

/** Scans a content. Never throws: errors are reported in the result (placeholders read so far are kept). */
export function parseContent(content: string): ParsedContent {
  const nodes: ParsedContent['nodes'] = [];
  let text = '';
  const flush = () => {
    if (text) nodes.push({ type: 'text', value: text });
    text = '';
  };
  const fail = (message: string, at: number): ParsedContent => {
    flush();
    return { nodes, error: `${message} al carattere ${charPosition(content, at)}`, errorAt: at };
  };
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '{') {
      if (content[i + 1] === '{') {
        text += '{';
        i += 2;
        continue;
      }
      // Find the closing brace outside quoted strings; a "{" before it is an error.
      let j = i + 1;
      for (; j < content.length; j++) {
        const d = content[j];
        if (d === '"') {
          const e = stringEnd(content, j);
          if (e === -1) return fail('virgolette non chiuse', j);
          j = e - 1;
        } else if (d === '{') return fail('graffa non ammessa dentro il segnaposto (per una graffa letterale scrivi {{)', j);
        else if (d === '}') break;
      }
      if (j >= content.length) return fail('graffa non chiusa (per una graffa letterale scrivi {{)', i);
      flush();
      nodes.push(parsePlaceholder(content, i, j + 1));
      i = j + 1;
    } else if (c === '}') {
      if (content[i + 1] !== '}') return fail('graffa di chiusura isolata (per una graffa letterale scrivi }})', i);
      text += '}';
      i += 2;
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return { nodes, error: null, errorAt: -1 };
}

const placeholderText = (content: string, n: PlaceholderNode) => content.slice(n.start, n.end);

/** The first problem of a parsed content (lexical, then syntax and filters), or null. */
function syntaxProblem(content: string, parsed: ParsedContent): string | null {
  if (parsed.error) return parsed.error;
  for (const n of parsed.nodes) {
    if (n.type !== 'placeholder') continue;
    if (n.error) return `${placeholderText(content, n)}: ${n.error}`;
    try {
      compileFilters(n.filters);
    } catch (e) {
      return `${placeholderText(content, n)}: ${e instanceof Error ? e.message : e}`;
    }
  }
  return null;
}

/**
 * Static check of a content against the available columns and generator names, without compiling
 * generators (no unique codes are drawn). Same messages as compileContent; null when it would compile.
 */
export function contentProblem(content: string, columns: string[] | null, hasGenerator: (name: string) => boolean): string | null {
  const parsed = parseContent(content);
  const problem = syntaxProblem(content, parsed);
  if (problem) return problem;
  for (const n of parsed.nodes) {
    if (n.type !== 'placeholder' || !n.source) continue;
    if (n.source.kind === 'generator' && !hasGenerator(n.source.name)) return `generatore "${n.source.name}" inesistente`;
    if (n.source.kind === 'column' && !(columns ?? []).includes(n.source.name)) return `Colonna "${n.source.name}" non presente nei dati`;
  }
  return null;
}

/** True when the content cannot produce anything: no placeholder and no text (e.g. an empty code zone). */
export function isStaticallyEmpty(content: string): boolean {
  const parsed = parseContent(content);
  return !parsed.error && parsed.nodes.length === 0;
}

export function formatCounter(counter: Counter, recordIndex: number): string {
  const value = counter.start + recordIndex * counter.step;
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(Math.max(0, counter.digits), '0');
  return negative ? `-${digits}` : digits;
}

/**
 * Builds the resolver of a content: parsing, filter checks and source lookup happen once, so resolving
 * a record is source lookup, filters and concatenation. Throws the first problem (static errors).
 */
export function compileContent(
  content: string,
  counter: Counter,
  data: DataSet | null,
  generators: GeneratorSet | null = null,
): (recordIndex: number) => string {
  const parsed = parseContent(content);
  const problem = syntaxProblem(content, parsed);
  if (problem) throw new Error(problem);
  const parts: Array<string | ((i: number) => string)> = [];
  for (const n of parsed.nodes) {
    if (n.type === 'text') {
      parts.push(n.value);
      continue;
    }
    const src = n.source!;
    let read: (i: number) => string;
    if (src.kind === 'counter') {
      read = (i) => formatCounter(counter, i);
    } else if (src.kind === 'generator') {
      const gen = generators?.get(src.name);
      if (!gen) throw new Error(`generatore "${src.name}" inesistente`);
      read = gen;
    } else {
      const col = data ? data.columns.indexOf(src.name) : -1;
      if (col < 0) throw new Error(`Colonna "${src.name}" non presente nei dati`);
      const rows = data!.rows;
      read = (i) => rows[i]?.[col] ?? '';
    }
    // Also without filters: the value length limit applies to every placeholder (§8).
    const filters = compileFilters(n.filters);
    parts.push((i) => filters(read(i)));
  }
  if (parts.length === 1) {
    const only = parts[0];
    return typeof only === 'string' ? () => only : only;
  }
  return (i) => parts.map((p) => (typeof p === 'string' ? p : p(i))).join('');
}
