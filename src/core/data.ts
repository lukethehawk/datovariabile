import * as XLSX from 'xlsx';
import type { DataSet } from './types';

export interface RawTable {
  /** Sheet names for spreadsheets, empty for text files. */
  sheets: string[];
  sheet: string;
  cells: string[][];
  /** Suggested header setting for this source. */
  headerGuess: boolean;
}

const SPREADSHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;
const DELIMITERS = ['\t', ';', ',', '|'];

export function isSpreadsheet(fileName: string): boolean {
  return SPREADSHEET_EXT.test(fileName);
}

export function readTable(fileName: string, bytes: Uint8Array, sheet?: string): RawTable {
  if (isSpreadsheet(fileName)) {
    // dateNF replaces Excel's locale dependent "short date" format (rendered as m/d/yy otherwise).
    const wb = XLSX.read(bytes, { type: 'array', dateNF: 'dd/mm/yyyy' });
    const name = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
      dateNF: 'dd/mm/yyyy',
    });
    return {
      sheets: wb.SheetNames,
      sheet: name,
      cells: rows.map((r) => r.map((c) => (c == null ? '' : String(c)))).filter((r) => r.some((c) => c.trim() !== '')),
      headerGuess: true,
    };
  }
  const text = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  return {
    sheets: [],
    sheet: '',
    cells: parseDelimited(text, delimiter).filter((r) => r.some((c) => c.trim() !== '')),
    headerGuess: delimiter !== null,
  };
}

export function toDataSet(table: RawTable, header: boolean): DataSet {
  const width = table.cells.reduce((n, r) => Math.max(n, r.length), 0);
  const first = header ? (table.cells[0] ?? []) : [];
  const columns: string[] = [];
  for (let c = 0; c < width; c++) {
    let name = (first[c] ?? '').trim() || columnLetter(c);
    if (columns.includes(name)) {
      let n = 2;
      while (columns.includes(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    columns.push(name);
  }
  return { columns, rows: header ? table.cells.slice(1) : table.cells };
}

export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/** UTF-8 if valid (BOM stripped), otherwise Windows-1252 as written by Italian Excel. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Picks the delimiter that splits the first lines into the same number of columns. */
export function detectDelimiter(text: string): string | null {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 30);
  let best: string | null = null;
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    const score = Math.max(0, ...freq.values());
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}

/** RFC 4180 parser; `delimiter === null` yields one column per line. */
export function parseDelimited(text: string, delimiter: string | null): string[][] {
  if (delimiter === null) return text.split(/\r\n|\n|\r/).map((l) => [l]);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Table CSV of the project archive (format v3): UTF-8 with BOM, ";" separator,
 * CRLF after every row, RFC 4180 quoting only where needed (";", quotes, CR/LF,
 * or a row made of one empty cell). Rows keep their own length (no padding), so
 * the exact imported cells come back with parseProjectCsv().
 */
export function writeProjectCsv(cells: string[][]): Uint8Array {
  const quote = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = cells.map((row) => (row.length === 1 && row[0] === '' ? '""' : row.map(quote).join(';')));
  return new TextEncoder().encode(`\uFEFF${lines.map((l) => `${l}\r\n`).join('')}`);
}

/** Cells a project table may hold: checked when saving and when opening, so every saved project reopens. */
export const MAX_PROJECT_CELLS = 5_000_000;

/**
 * Strict reader for writeProjectCsv(): UTF-8 only, ";" only, malformed quoting is an error.
 * TextDecoder consumes exactly the one BOM written by the writer; a U+FEFF that is part of the
 * first value is kept. Cells are sliced, not built character by character.
 */
export function parseProjectCsv(bytes: Uint8Array): string[][] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rows: string[][] = [];
  let row: string[] = [];
  let cells = 0;
  const plain = /[;\r\n"]/g;
  let i = 0;
  // Each iteration reads one cell starting at i, then its terminator.
  while (i < text.length) {
    let cell: string;
    if (text[i] === '"') {
      const parts: string[] = [];
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) throw new Error('virgolette non chiuse');
        parts.push(text.slice(j, q));
        if (text[q + 1] === '"') {
          parts.push('"');
          j = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
      cell = parts.join('');
      if (i < text.length && text[i] !== ';' && text[i] !== '\r' && text[i] !== '\n') throw new Error('testo dopo le virgolette di chiusura');
    } else {
      plain.lastIndex = i;
      const m = plain.exec(text);
      const end = m ? m.index : text.length;
      if (m && m[0] === '"') throw new Error('virgolette all’interno di un valore non racchiuso tra virgolette');
      cell = text.slice(i, end);
      i = end;
    }
    row.push(cell);
    if (++cells > MAX_PROJECT_CELLS) throw new Error(`troppi dati (oltre ${MAX_PROJECT_CELLS} celle)`);
    if (i >= text.length) break;
    const ch = text[i];
    if (ch === ';') {
      i++;
      if (i === text.length) row.push(''); // trailing ";" at the very end: one more empty cell
      continue;
    }
    // Line break: CRLF, LF or CR.
    rows.push(row);
    row = [];
    i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
  }
  if (row.length) rows.push(row);
  return rows;
}
