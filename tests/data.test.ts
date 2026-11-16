import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { readTable, toDataSet } from '../src/core/data';

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('data files', () => {
  it('reads Excel-style CSV: semicolons, quotes, Windows-1252', () => {
    const csv = latin1('Nome;Città;Note\r\n"Rossi; Mario";Forlì;"dice ""ciao"""\r\nBianchi;Cesena;\r\n\r\n');
    const data = toDataSet(readTable('clienti.csv', csv), true);
    expect(data.columns).toEqual(['Nome', 'Città', 'Note']);
    expect(data.rows).toEqual([
      ['Rossi; Mario', 'Forlì', 'dice "ciao"'],
      ['Bianchi', 'Cesena', ''],
    ]);
  });

  it('reads UTF-8 with BOM and tab delimiters', () => {
    const tsv = new TextEncoder().encode('\uFEFFCodice\tPrezzo\nA1\t€ 3,50\n');
    const data = toDataSet(readTable('listino.txt', tsv), true);
    expect(data.columns).toEqual(['Codice', 'Prezzo']);
    expect(data.rows).toEqual([['A1', '€ 3,50']]);
  });

  it('treats a text file without delimiters as one value per line', () => {
    const table = readTable('codici.txt', new TextEncoder().encode('ABC-001\nABC-002\n\nABC-003'));
    expect(table.headerGuess).toBe(false);
    const data = toDataSet(table, false);
    expect(data.columns).toEqual(['A']);
    expect(data.rows).toEqual([['ABC-001'], ['ABC-002'], ['ABC-003']]);
  });

  it('names blank and duplicate headers uniquely', () => {
    const table = readTable('x.csv', new TextEncoder().encode('Nome,,Nome\n1,2,3\n'));
    expect(toDataSet(table, true).columns).toEqual(['Nome', 'B', 'Nome_2']);
  });

  it('reads spreadsheets as displayed text with Italian dates', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Codice', 'Data', 'Importo'],
      ['00123', new Date(2026, 10, 5), 12.5],
    ], { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Primo');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Altro'], ['x']]), 'Secondo');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

    const first = readTable('dati.xlsx', bytes);
    expect(first.sheets).toEqual(['Primo', 'Secondo']);
    expect(toDataSet(first, true).rows).toEqual([['00123', '05/11/2026', '12.5']]);
    expect(toDataSet(readTable('dati.xlsx', bytes, 'Secondo'), true).rows).toEqual([['x']]);
  });
});
