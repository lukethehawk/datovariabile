import { describe, expect, it } from 'vitest';
import { readProjectFile, writeProjectArchive } from '../src/core/archive';
import { MAX_PROJECT_CELLS, parseProjectCsv, readTable, toDataSet, writeProjectCsv } from '../src/core/data';
import type { ProjectData, SavedData } from '../src/core/project';
import { openZip } from '../src/core/zip';

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

function projectWith(data: SavedData | null): ProjectData {
  return { sources: [], slots: [], fields: [], fonts: [], manualCount: 1, data, range: { from: '', to: '' } };
}

/** SavedData as the app builds it from imported cells, without touching a real file. */
function savedFromCells(name: string, cells: string[][], header: boolean): SavedData {
  const table = { sheets: [], sheet: '', cells, headerGuess: header };
  return { name, original: utf8('file originale non modificato'), table, header, columns: toDataSet(table, header).columns };
}

const TRICKY_CELLS: string[][] = [
  ['Codice', 'Nome', 'Ditta', 'Note', 'Vuota', 'Coda'],
  ['001234', 'Rossi, Mario', "L'azienda", 'Dice "ciao"', '', ''],
  ['000002', 'Bianchi; snc', '', 'prima\nseconda', '', ''],
  ['000003', 'Verdi', '  spazi  ', 'a\r\nb', '', ''],
  ['000004', 'Neri', 'ritorno\rcarro', '=SOMMA(A1)', '', ''],
  ['000005', 'Ünïcødé 漢字 😀 𝄞', '', '', '', ''],
  [''], // riga con una sola cella vuota
  ['000008'], // riga più corta delle altre
];

describe('project data CSV', () => {
  it('round-trips every cell exactly, through the CSV and through the archive', async () => {
    // Direct write → strict read: every row keeps its own length and every value its bytes.
    expect(parseProjectCsv(writeProjectCsv(TRICKY_CELLS))).toEqual(TRICKY_CELLS);

    const saved = savedFromCells('clienti.csv', TRICKY_CELLS, true);
    const bytes = await bytesOf((await writeProjectArchive(projectWith(saved))).blob);
    const opened = await readProjectFile(bytes);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.data!.table.cells).toEqual(TRICKY_CELLS);
    expect(opened.project.data!.columns).toEqual(['Codice', 'Nome', 'Ditta', 'Note', 'Vuota', 'Coda']);
    expect(opened.project.data!.header).toBe(true);
    expect(opened.project.data!.original).toEqual(saved.original);
    // The used data inside the archive is itself the same table.
    expect(parseProjectCsv(await openZip(bytes).read('dati/dati-usati.csv'))).toEqual(TRICKY_CELLS);
  });

  it('writes UTF-8 with BOM, CRLF rows, ";" separator and minimal quoting', () => {
    const bytes = writeProjectCsv([
      ['Codice', 'Nome', 'Note'],
      ['001234', 'Rossi, Mario', '=SOMMA(A1)'],
      ['000007', 'Bianchi; Mario', 'ok'],
    ]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe(
      'Codice;Nome;Note\r\n001234;Rossi, Mario;=SOMMA(A1)\r\n000007;"Bianchi; Mario";ok\r\n',
    );
  });

  it('rejects malformed quoting and bytes that are not UTF-8', () => {
    expect(() => parseProjectCsv(utf8('"mai chiuso'))).toThrow('virgolette non chiuse');
    expect(() => parseProjectCsv(utf8('"chiuso"x'))).toThrow('testo dopo le virgolette di chiusura');
    expect(() => parseProjectCsv(utf8('senza"virgolette'))).toThrow('virgolette all’interno');
    expect(() => parseProjectCsv(new Uint8Array([0x41, 0x3b, 0xc3, 0x28]))).toThrow();
  });

  it('reopens a one-column TXT database as one value per CSV row', async () => {
    const original = utf8('ABC-001\nABC-002\n\nABC-003');
    const table = readTable('codici.txt', original);
    expect(table.headerGuess).toBe(false);
    const columns = toDataSet(table, false).columns;
    expect(columns).toEqual(['A']);

    const bytes = await bytesOf((await writeProjectArchive(projectWith({ name: 'codici.txt', original, table, header: false, columns }))).blob);
    const opened = await readProjectFile(bytes);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.data!.table.cells).toEqual([['ABC-001'], ['ABC-002'], ['ABC-003']]);
    expect(opened.project.data!.columns).toEqual(['A']);
    expect(opened.project.data!.header).toBe(false);

    const rows = parseProjectCsv(await openZip(bytes).read('dati/dati-usati.csv'));
    expect(rows).toEqual([['ABC-001'], ['ABC-002'], ['ABC-003']]);
    expect(rows.every((r) => r.length === 1)).toBe(true);
  });

  it('keeps unique names for duplicate or blank headers after reopening', async () => {
    const original = utf8('Nome,,Nome\n1,2,3\n');
    const table = readTable('nomi.csv', original);
    expect(table.headerGuess).toBe(true);
    const columns = toDataSet(table, true).columns;
    expect(columns).toEqual(['Nome', 'B', 'Nome_2']);

    const bytes = await bytesOf((await writeProjectArchive(projectWith({ name: 'nomi.csv', original, table, header: true, columns }))).blob);
    const zip = openZip(bytes);
    // The names are stored in the manifest: reopening keeps them instead of recomputing them.
    const manifest = JSON.parse(new TextDecoder().decode(await zip.read('progetto.json')));
    expect(manifest.data.columns).toEqual(['Nome', 'B', 'Nome_2']);
    expect(new TextDecoder().decode(await zip.read('dati/dati-usati.csv'))).toBe('Nome;;Nome\r\n1;2;3\r\n');

    const opened = await readProjectFile(bytes);
    expect(opened.project.data!.columns).toEqual(['Nome', 'B', 'Nome_2']);
  });

  it('keeps a U+FEFF that belongs to the first value', () => {
    expect(parseProjectCsv(writeProjectCsv([['\uFEFFABC', 'x']]))).toEqual([['\uFEFFABC', 'x']]);
  });

  it('refuses tables over the cell limit, both on reading and on saving', async () => {
    // One row of MAX+1 empty cells: enough to exceed the limit without building a JS array by hand.
    expect(() => parseProjectCsv(utf8(`${';'.repeat(MAX_PROJECT_CELLS)}\r\n`))).toThrow('troppi dati');

    // 5001 rows × 1000 cells, all sharing the same row object: the limit is checked before copying.
    const row = new Array(1000).fill('x');
    const saved = savedFromCells('enorme.csv', Array.from({ length: 5001 }, () => row), false);
    await expect(writeProjectArchive(projectWith(saved))).rejects.toThrow('Dati troppo grandi');
  });
});
