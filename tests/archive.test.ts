import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { readProjectFile, writeProjectArchive } from '../src/core/archive';
import { readTable, toDataSet } from '../src/core/data';
import type { ProjectData, SavedData } from '../src/core/project';
import { openZip, writeZip } from '../src/core/zip';
import { makePdf, textField } from './helpers';
import { flatJpeg } from './images';

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

function savedData(name: string, original: Uint8Array, sheet?: string, header?: boolean): SavedData {
  const table = readTable(name, original, sheet);
  const h = header ?? table.headerGuess;
  return { name, original, table, header: h, columns: toDataSet(table, h).columns };
}

async function project(overrides: Partial<ProjectData> = {}): Promise<ProjectData> {
  const pdf = await makePdf([{ kb: 20 }, { kb: 5, size: [842, 595] }]);
  const jpg = flatJpeg({ width: 16, height: 16, components: 1, value: () => 90 });
  return {
    sources: [
      { id: 'a', name: 'Fronte è retro.pdf', kind: 'pdf', bytes: pdf },
      { id: 'b', name: 'Fronte è retro.jpg', kind: 'jpeg', bytes: jpg },
    ],
    slots: [
      { id: 's1', sourceId: 'a', page: 0, enabled: true },
      { id: 's2', sourceId: 'b', page: 0, enabled: true, raster: { size: 'A5', width: 0, height: 0, orientation: 'auto', fit: 'cover', dpi: null } },
      { id: 's3', sourceId: 'a', page: 0, enabled: false },
    ],
    fields: [textField({ slot: 's1', content: '{Codice} {Nome}' }), textField({ id: 't2', slot: 's3', content: 'N. {#}', counter: { start: 7, step: 2, digits: 4 } })],
    fonts: [{ name: 'Mio Font', bytes: Uint8Array.from({ length: 3000 }, (_, i) => i % 7) }],
    manualCount: 12,
    data: null,
    range: { from: '3', to: '9' },
    generators: [],
    ...overrides,
  };
}

/** Re-zips an archive with some entries replaced, as a user rebuilding the ZIP would. */
async function rebuildArchive(blob: Blob, changes: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const zip = openZip(await bytesOf(blob));
  const files = await Promise.all(
    [...zip.entries.keys()].map(async (path) => ({ path, data: changes[path] ?? (await zip.read(path)), deflate: true })),
  );
  return bytesOf(await writeZip(files));
}

/** Rebuilds the archive with edited project fields in progetto.json. */
async function editFields(blob: Blob, edit: (fields: Array<Record<string, unknown>>) => void): Promise<Uint8Array> {
  const zip = openZip(await bytesOf(blob));
  // Our own fixture: the manifest always has the shape written by writeProjectArchive().
  const manifest: { fields: Array<Record<string, unknown>> } = JSON.parse(new TextDecoder().decode(await zip.read('progetto.json')));
  edit(manifest.fields);
  return rebuildArchive(blob, { 'progetto.json': new TextEncoder().encode(JSON.stringify(manifest)) });
}

describe('project archive (v3)', () => {
  it('stores every file once, unchanged, and restores the whole project', async () => {
    const csv = new TextEncoder().encode('Codice;Nome;Nome;\n001234;"Rossi, Mario";L\'azienda;\n000007;"Dice ""ciao""\nsu due righe";Ünïcødé 漢字 😀;\n;;;x\n');
    const p = await project({ data: savedData('clienti.csv', csv) });
    const { blob, warnings } = await writeProjectArchive(p);
    expect(warnings).toEqual([]);
    const bytes = await bytesOf(blob);

    const zip = openZip(bytes);
    expect([...zip.entries.keys()].sort()).toEqual([
      'LEGGIMI.txt',
      'dati/dati-usati.csv',
      'dati/originale-clienti.csv',
      'font/01-Mio_Font',
      'progetto.json',
      'veline/01-Fronte_e_retro.pdf',
      'veline/02-Fronte_e_retro.jpg',
    ]);
    // Already compressed files are stored, text is deflated; originals are byte-identical.
    expect(zip.entries.get('veline/01-Fronte_e_retro.pdf')!.method).toBe(0);
    expect(zip.entries.get('progetto.json')!.method).toBe(8);
    expect(await zip.read('dati/originale-clienti.csv')).toEqual(csv);
    expect(await zip.read('veline/01-Fronte_e_retro.pdf')).toEqual(p.sources[0].bytes);

    const opened = await readProjectFile(bytes);
    expect(opened.legacy).toBe(false);
    expect(opened.warnings).toEqual([]);
    expect(opened.project).toEqual(p);
    expect(opened.project.data!.table.cells[1]).toEqual(['001234', 'Rossi, Mario', "L'azienda", '']);
    expect(opened.project.data!.columns).toEqual(['Codice', 'Nome', 'Nome_2', 'D']);
  });

  it('keeps the chosen Excel sheet, header setting and displayed values', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Altro'], ['x']]), 'Primo');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Codice', 'Città'], ['00123', 'Forlì'], ['00124', 'Cesena']]), 'Clienti');
    const xlsx = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const p = await project({ data: savedData('dati.xlsx', xlsx, 'Clienti', false) });
    const bytes = await bytesOf((await writeProjectArchive(p)).blob);
    expect(openZip(bytes).entries.get('dati/originale-dati.xlsx')!.method).toBe(0);
    const { project: back } = await readProjectFile(bytes);
    expect(back.data!.table.sheet).toBe('Clienti');
    expect(back.data!.table.sheets).toEqual(['Primo', 'Clienti']);
    expect(back.data!.header).toBe(false);
    expect(back.data!.table.cells).toEqual([['Codice', 'Città'], ['00123', 'Forlì'], ['00124', 'Cesena']]);
    // SheetJS adds a few non-index properties to the array it reads: compare the bytes only.
    expect(Array.from(back.data!.original)).toEqual(Array.from(xlsx));
  });

  it('saves a project without data and without fonts', async () => {
    const p = await project({ fonts: [], data: null });
    const bytes = await bytesOf((await writeProjectArchive(p)).blob);
    expect([...openZip(bytes).entries.keys()].some((k) => k.startsWith('dati/') || k.startsWith('font/'))).toBe(false);
    expect((await readProjectFile(bytes)).project).toEqual(p);
  });

  it('uses a data CSV edited outside the app and says so', async () => {
    const p = await project({ data: savedData('c.csv', new TextEncoder().encode('Codice;Nome\n1;A\n2;B\n')) });
    const zip = openZip(await bytesOf((await writeProjectArchive(p)).blob));
    // Rebuild the archive with a different CSV, as a user editing it and zipping again would.
    const files = await Promise.all([...zip.entries.keys()].map(async (path) => ({ path, data: await zip.read(path), deflate: true })));
    const edited = files.map((f) => (f.path === 'dati/dati-usati.csv' ? { ...f, data: new TextEncoder().encode('Codice;Nome\r\n1;A\r\n2;B\r\n3;C\r\n') } : f));
    const opened = await readProjectFile(await bytesOf(await writeZip(edited)));
    expect(opened.warnings[0]).toContain('modificato fuori da DatoVariabile');
    expect(opened.project.data!.table.cells).toHaveLength(4);
  });

  it('refuses archives that are not projects, with readable messages', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a']]), 'S');
    await expect(readProjectFile(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })))).rejects.toThrow('foglio di calcolo');
    await expect(readProjectFile(new TextEncoder().encode('ciao'))).rejects.toThrow('non è un progetto');
    const bytes = await bytesOf((await writeProjectArchive(await project())).blob);
    await expect(readProjectFile(bytes.subarray(0, bytes.length - 30))).rejects.toThrow('Archivio non valido');
  });

  it('refuses a velina whose bytes changed inside a rebuilt ZIP', async () => {
    const p = await project();
    const blob = (await writeProjectArchive(p)).blob;
    const path = [...openZip(await bytesOf(blob)).entries.keys()].find((k) => k.startsWith('veline/') && k.endsWith('.pdf'))!;
    const changed = new Uint8Array(p.sources[0].bytes);
    changed[changed.length - 1] ^= 0xff;
    const bytes = await rebuildArchive(blob, { [path]: changed });
    // The size still matches: only the CRC recorded at save time catches the swap.
    expect(openZip(bytes).entries.get(path)!.size).toBe(p.sources[0].bytes.length);
    await expect(readProjectFile(bytes)).rejects.toThrow('file diverso da quello salvato');
  });

  it('refuses zones that cannot be drawn, naming the zone', async () => {
    const blob = (await writeProjectArchive(await project())).blob;

    const noCounter = await editFields(blob, (fields) => {
      delete fields[0].counter;
    });
    await expect(readProjectFile(noCounter)).rejects.toThrow(/Progetto danneggiato o incompleto: zona "Testo": contatore/);

    const noFont = await editFields(blob, (fields) => {
      fields[0].font = 'Font Mancante';
    });
    await expect(readProjectFile(noFont)).rejects.toThrow(/zona "Testo": font "Font Mancante" non disponibile/);

    const noCode = await editFields(blob, (fields) => Object.assign(fields[0], { type: 'barcode', symbology: 'sconosciuto', showText: false, ecLevel: 'M' }));
    await expect(readProjectFile(noCode)).rejects.toThrow(/Progetto danneggiato o incompleto: zona "Testo": tipo di codice/);
  });

  it('refuses a legacy v2 project whose zone has no counter', async () => {
    const field: Record<string, unknown> = { ...textField({ slot: 's1' }) };
    delete field.counter;
    const v2 = {
      app: 'DatoVariabile',
      version: 2,
      sources: [{ id: 'a', name: 'velina.pdf', kind: 'pdf', data: btoa('x') }],
      slots: [{ id: 's1', sourceId: 'a', page: 0, enabled: true }],
      fields: [field],
      fonts: [],
      manualCount: 1,
    };
    await expect(readProjectFile(new TextEncoder().encode(JSON.stringify(v2)))).rejects.toThrow(/Progetto danneggiato: zona "Testo": contatore/);
  });
});
