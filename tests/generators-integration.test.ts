import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { readProjectFile, writeProjectArchive, type ProjectData } from '../src/core/archive';
import { generate, type Job, type JobPage } from '../src/core/generate';
import { compileGenerators, UNIQUE_ALPHABETS } from '../src/core/generators';
import { compileContent } from '../src/core/placeholders';
import type { DataGenerator, DateTimeGenerator, NumberingGenerator, TemplatePage, UniqueGenerator } from '../src/core/types';
import { openZip, writeZip } from '../src/core/zip';
import { barcodeField, makePdf, makeTemplate, pdfJob, textField } from './helpers';

/** Text items of a page with their position in the displayed (rotated) page, y from the top. */
async function textPositions(bytes: Uint8Array, pageNumber: number) {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' });
  const page = await (await task.promise).getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.flatMap((it) => ('str' in it && it.str ? [it] : []));
  const result = items.map((it) => {
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    return { str: it.str, x, y };
  });
  await task.destroy();
  return result;
}

/** Text of one page, in reading order. */
async function texts(bytes: Uint8Array, pageNumber: number): Promise<string[]> {
  return (await textPositions(bytes, pageNumber)).map((t) => t.str);
}

const PAGE: TemplatePage = {
  mediaBox: [0, 0, 595, 842],
  rotate: 0,
  boxes: {},
  view: [0, 0, 595, 842],
  viewWidth: 595,
  viewHeight: 842,
};

/** One output page without a background file (the preview does the same with sources: null). */
function blank(slot: string): JobPage {
  return { slot, sourceId: '', page: 0, geometry: PAGE };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return { sources: null, pages: [blank('s1')], fields: [textField()], fonts: [], data: null, generators: [], now: 0, from: 0, to: 0, ...overrides };
}

/** Fixed 256-bit key: the codes are reproducible, so the tests can compute them without the PDF. */
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function uniqueGen(overrides: Partial<UniqueGenerator> = {}): UniqueGenerator {
  return {
    id: 'u1',
    name: 'Gift',
    type: 'unique',
    prefix: '',
    suffix: '',
    algorithm: 'hmac-sha256-ctr-v1',
    key: KEY,
    alphabet: UNIQUE_ALPHABETS.safe,
    length: 4,
    ...overrides,
  };
}

function numberingGen(overrides: Partial<NumberingGenerator> = {}): NumberingGenerator {
  return {
    id: 'n1',
    name: 'Matricola',
    type: 'numbering',
    prefix: '',
    suffix: '',
    style: 'number',
    start: 1,
    step: 1,
    digits: 4,
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    groupStart: 'A',
    numberMin: 1,
    numberMax: 999,
    overflow: 'grow',
    ...overrides,
  };
}

function dateGen(overrides: Partial<DateTimeGenerator> = {}): DateTimeGenerator {
  return {
    id: 'd1',
    name: 'Oggi',
    type: 'datetime',
    prefix: '',
    suffix: '',
    mode: 'job',
    timeZone: 'Europe/Rome',
    fixed: '2020-01-02T12:30',
    format: 'dd/MM/yyyy HH:mm',
    ...overrides,
  };
}

/** Values of a generator for records 0…count-1, as the fields see them. */
function values(g: DataGenerator, count: number, now = 0): string[] {
  const fn = compileGenerators([g], { now, count }).get(g.name)!;
  return Array.from({ length: count }, (_, i) => fn(i));
}

describe('generators in a real generation', () => {
  it('prints the same unique code on front and back of every record', async () => {
    const front = await makeTemplate({ kb: 1, seed: 1 });
    const back = await makeTemplate({ kb: 2, seed: 2 });
    const g = uniqueGen();
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: '{@Gift}' }),
      textField({ id: 'f2', name: 'Retro', slot: 'R', content: 'Codice: {@Gift}' }),
      barcodeField({ id: 'b1', name: 'QR', slot: 'R', content: '{@Gift}', symbology: 'qrcode', x: 100, y: 500, w: 120, h: 120 }),
    ];
    const res = await generate(await pdfJob([front, back], [[0, 0, 'F'], [1, 0, 'R']], { fields, generators: [g], to: 2 }));
    expect(res.pageCount).toBe(6);

    // One logical GeneratorSet for the whole job: front text, back text and QR payload share the value.
    const set = compileGenerators([g], { now: 0, count: 3 });
    const value = set.get('Gift')!;
    const counter = { start: 1, step: 1, digits: 0 };
    const codes: string[] = [];
    for (let rec = 0; rec < 3; rec++) {
      const f = await texts(res.bytes, rec * 2 + 1);
      const b = await texts(res.bytes, rec * 2 + 2);
      const expected = value(rec);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
      expect(f[0]).toBe(expected);
      expect(b).toEqual([`Codice: ${expected}`]);
      // The QR field carries the same placeholder: resolving it through the same set gives the same value.
      expect(compileContent('{@Gift}', counter, null, set)(rec)).toBe(expected);
      codes.push(f[0]);
    }
    expect(new Set(codes).size).toBe(3);
  });

  it('reprints the same codes for a partial range', async () => {
    const job = { fields: [textField({ content: '{@Gift}' })], generators: [uniqueGen({ id: 'u2' })] };
    const full = await generate(makeJob({ ...job, to: 19 }));
    const part = await generate(makeJob({ ...job, from: 9, to: 11 }));
    expect(part.pageCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      // Records 10, 11, 12 (1-based) are pages 10, 11, 12 of the full print.
      expect(await texts(part.bytes, i + 1)).toEqual(await texts(full.bytes, 10 + i));
    }
  });

  it('reprints a high record range with the codes read from the full PDF', async () => {
    const g = uniqueGen({ id: 'u6' });
    const fields = [textField({ content: '{@Gift}' })];
    const full = await generate(makeJob({ fields, generators: [g], to: 999 }));
    const part = await generate(makeJob({ fields, generators: [g], from: 500, to: 502 }));
    expect(full.pageCount).toBe(1_000);
    expect(part.pageCount).toBe(3);
    const value = compileGenerators([g], { now: 0, count: 1_000 }).get('Gift')!;
    for (let i = 0; i < 3; i++) {
      const fromFull = await texts(full.bytes, 501 + i);
      expect(fromFull).toEqual([value(500 + i)]);
      expect(await texts(part.bytes, i + 1)).toEqual(fromFull);
    }
  }, 120_000);

  it('shows one date per job on every page and keeps fixed dates independent from now', async () => {
    const day = Date.UTC(2026, 10, 18, 12, 0);
    const pages = [blank('a'), blank('b')];
    const fields = [
      textField({ id: 'a1', slot: 'a', content: '{@Oggi}' }),
      textField({ id: 'b1', slot: 'b', content: '{@Oggi}' }),
    ];
    const res = await generate(makeJob({ pages, fields, generators: [dateGen()], to: 4, now: day }));
    expect(res.pageCount).toBe(10);
    const shown: string[] = [];
    for (let p = 1; p <= 10; p++) shown.push((await texts(res.bytes, p)).join(''));
    expect(new Set(shown).size).toBe(1);
    expect(shown[0]).toMatch(/^18\/11\/2026 \d{2}:\d{2}$/);

    const nextDay = await generate(makeJob({ pages, fields, generators: [dateGen()], to: 0, now: day + 86_400_000 }));
    expect((await texts(nextDay.bytes, 1)).join('')).not.toBe(shown[0]);
    expect((await texts(nextDay.bytes, 1)).join('')).toMatch(/^19\/11\/2026 /);

    const fixed = dateGen({ id: 'd2', name: 'Data fissa', mode: 'fixed', fixed: '2020-01-02T12:30' });
    const fixedFields = [textField({ id: 'a1', slot: 'a', content: '{@Data fissa}' })];
    const one = await generate(makeJob({ pages: [blank('a')], fields: fixedFields, generators: [fixed], now: day }));
    const other = await generate(makeJob({ pages: [blank('a')], fields: fixedFields, generators: [fixed], now: day + 86_400_000 }));
    expect((await texts(one.bytes, 1)).join('')).toBe('02/01/2020 12:30');
    expect((await texts(other.bytes, 1)).join('')).toBe('02/01/2020 12:30');
  });

  it('numbers rows of a database together with column values', async () => {
    const data = { columns: ['Nome'], rows: [['Anna'], ['Bruno'], ['Carla']] };
    const res = await generate(makeJob({ data, fields: [textField({ content: '{Nome} {@Matricola}' })], generators: [numberingGen()], to: data.rows.length - 1 }));
    expect(res.pageCount).toBe(data.rows.length);
    expect(await texts(res.bytes, 1)).toEqual(['Anna 0001']);
    expect(await texts(res.bytes, 2)).toEqual(['Bruno 0002']);
    expect(await texts(res.bytes, 3)).toEqual(['Carla 0003']);
  });

  it('keeps {#} next to a generator in the same zone', async () => {
    const g = uniqueGen({ id: 'u3' });
    const codes = values(g, 2);
    const field = textField({ content: 'N. {#} {@Gift}', counter: { start: 5, step: 2, digits: 3 } });
    const res = await generate(makeJob({ fields: [field], generators: [g], to: 1 }));
    expect(await texts(res.bytes, 1)).toEqual([`N. 005 ${codes[0]}`]);
    expect(await texts(res.bytes, 2)).toEqual([`N. 007 ${codes[1]}`]);
  });

  it('reads {@Gift} as the generator and {"@Gift"} as the column, even with the same name', async () => {
    const g = uniqueGen({ id: 'u4' });
    const code = values(g, 1)[0];
    const data = { columns: ['@Gift', 'Altro'], rows: [['colonna', 'x']] };
    const both = await generate(
      makeJob({ data, fields: [textField({ content: '{@Gift} {"@Gift"}' })], generators: [g], to: 0 }),
    );
    // One zone, both sources: @ is always the generator, the quoted name is always the column.
    expect(await texts(both.bytes, 1)).toEqual([`${code} colonna`]);

    // {@Nome} never falls back to a column literally named "@Nome": only the quoted form reads it.
    const missing = await generate(
      makeJob({ data: { columns: ['@Nome'], rows: [['valore']] }, fields: [textField({ content: '{@Nome}' })], to: 0 }),
    ).catch((e: Error) => e);
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toContain('generatore "Nome" inesistente');

    const quoted = await generate(
      makeJob({ data: { columns: ['@Nome'], rows: [['valore']] }, fields: [textField({ content: '{"@Nome"}' })], to: 0 }),
    );
    expect(await texts(quoted.bytes, 1)).toEqual(['valore']);
  });

  it('refuses more unique codes than the capacity allows, naming the zone', async () => {
    const g = uniqueGen({ id: 'u5', name: 'Tessera', alphabet: '01', length: 3 });
    const error = await generate(
      makeJob({ fields: [textField({ name: 'Tessera fuori', content: '{@Tessera}' })], generators: [g], to: 10 }),
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('servono 11 codici');
    expect((error as Error).message).toContain('Zona "Tessera fuori"');
  });
});

// ---------------------------------------------------------------- project archive

async function archiveProject(overrides: Partial<ProjectData> = {}): Promise<ProjectData> {
  const pdf = await makePdf([{ kb: 2 }]);
  return {
    sources: [{ id: 'a', name: 'velina.pdf', kind: 'pdf', bytes: pdf }],
    slots: [{ id: 's1', sourceId: 'a', page: 0, enabled: true }],
    fields: [textField({ slot: 's1', content: '{@Tessera}' })],
    fonts: [],
    manualCount: 3,
    data: null,
    range: { from: '', to: '' },
    generators: [
      numberingGen({ id: 'gn', name: 'Tessera' }),
      uniqueGen({ id: 'gu', name: 'Gift' }),
      dateGen({ id: 'gd', name: 'Oggi' }),
    ],
    ...overrides,
  };
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

type Manifest = { version: number; generators?: Array<Record<string, unknown>> };

/** Rebuilds the archive with `progetto.json` edited, as a user (or a future version) would. */
async function editManifest(blob: Blob, edit: (m: Manifest) => void): Promise<Uint8Array> {
  const zip = openZip(await bytesOf(blob));
  const files = await Promise.all(
    [...zip.entries.keys()].map(async (path) => ({ path, data: await zip.read(path), deflate: true })),
  );
  const manifest = JSON.parse(new TextDecoder().decode(await zip.read('progetto.json'))) as Manifest;
  edit(manifest);
  const edited = files.map((f) =>
    f.path === 'progetto.json' ? { ...f, data: new TextEncoder().encode(JSON.stringify(manifest)) } : f,
  );
  return bytesOf(await writeZip(edited));
}

const uniqueOf = (m: Manifest) => m.generators!.find((g) => g.type === 'unique')!;

describe('generators in the project archive', () => {
  it('writes version 5 with every generator unchanged, key included', async () => {
    const p = await archiveProject();
    const { blob } = await writeProjectArchive(p);
    const bytes = await bytesOf(blob);
    const manifest = JSON.parse(new TextDecoder().decode(await openZip(bytes).read('progetto.json'))) as Manifest;
    expect(manifest.version).toBe(5);

    const opened = await readProjectFile(bytes);
    expect(opened.project.generators).toEqual(p.generators);
    expect(opened.project.generators.find((g) => g.type === 'unique')).toMatchObject({ key: KEY, length: 4 });
    expect(opened.project.sources).toEqual(p.sources);
    expect(opened.project.fields).toEqual(p.fields);
  });

  it('refuses to save invalid generators with a clear message', async () => {
    const base = await archiveProject();
    await expect(writeProjectArchive({ ...base, generators: [uniqueGen({ length: 0 })] })).rejects.toThrow(
      'Correggi il generatore prima di salvare: "Gift": lunghezza non valida',
    );
    await expect(
      writeProjectArchive({ ...base, generators: [numberingGen({ style: 'lettersNumber', start: 2_000, numberMin: 1, numberMax: 999 })] }),
    ).rejects.toThrow('Correggi il generatore prima di salvare: "Matricola": il numero iniziale deve stare tra 1 e 999');
    await expect(writeProjectArchive({ ...base, generators: [numberingGen(), numberingGen({ id: 'n2', name: 'MATRICOLA' })] })).rejects.toThrow(
      'Correggi il generatore prima di salvare: duplicato: MATRICOLA',
    );
  });

  it('reads a project saved without generators as an empty list', async () => {
    const p = await archiveProject({ generators: [] });
    const bytes = await bytesOf((await writeProjectArchive(p)).blob);
    expect((await readProjectFile(bytes)).project.generators).toEqual([]);
  });

  it('refuses a newer or unsupported format and damaged generators', async () => {
    const p = await archiveProject();
    const blob = (await writeProjectArchive(p)).blob;

    const newer = await editManifest(blob, (m) => {
      m.version = 6;
    });
    await expect(readProjectFile(newer)).rejects.toThrow('Progetto in un formato più recente (versione 6)');

    // Versions 1–4 are experimental: reported as unsupported, not as "damaged".
    const unsupported = await editManifest(blob, (m) => {
      m.version = 4;
    });
    const old = await readProjectFile(unsupported).catch((e: Error) => e);
    expect(old).toBeInstanceOf(Error);
    expect((old as Error).message).toBe('Progetto in un formato non supportato (versione 4)');
    expect((old as Error).message).not.toContain('danneggiato');

    const algorithm = await editManifest(blob, (m) => {
      uniqueOf(m).algorithm = 'sha1-v0';
    });
    await expect(readProjectFile(algorithm)).rejects.toThrow(/Progetto danneggiato o incompleto: generatore "Gift": algoritmo sconosciuto/);

    const key = await editManifest(blob, (m) => {
      uniqueOf(m).key = 'zz';
    });
    await expect(readProjectFile(key)).rejects.toThrow(/Progetto danneggiato o incompleto: generatore "Gift": chiave non valida/);

    const duplicate = await editManifest(blob, (m) => {
      m.generators!.push({ ...m.generators![0], id: 'gdup', name: 'tessera' });
    });
    await expect(readProjectFile(duplicate)).rejects.toThrow(/Progetto danneggiato o incompleto: generatore duplicato: tessera/);
  });
});

// ---------------------------------------------------------------- performance

describe('generator performance on a real job', () => {
  it('generates 10 000 unique codes, all distinct, in a single PDF in less than 60 s', async () => {
    const g = uniqueGen({ id: 'up', name: 'Codice', alphabet: UNIQUE_ALPHABETS.digits, length: 5 });
    const codes = values(g, 10_000);
    expect(new Set(codes).size).toBe(10_000);

    const started = performance.now();
    const res = await generate(makeJob({ fields: [textField({ content: '{@Codice}' })], generators: [g], to: 9_999 }));
    const elapsed = performance.now() - started;
    expect(res.pageCount).toBe(10_000);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it('numbers 1 000 alphanumeric serials, all distinct, in less than 60 s', async () => {
    const g = numberingGen({
      id: 'np',
      name: 'Seriale',
      style: 'lettersNumber',
      start: 1,
      step: 1,
      digits: 3,
      alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      groupStart: 'A',
      numberMin: 1,
      numberMax: 999,
      overflow: 'grow',
    });
    const serials = values(g, 1_000);
    expect(serials[0]).toBe('A001');
    expect(serials[998]).toBe('A999');
    expect(serials[999]).toBe('B001');
    expect(new Set(serials).size).toBe(1_000);

    const started = performance.now();
    const res = await generate(makeJob({ fields: [textField({ content: '{@Seriale}' })], generators: [g], to: 999 }));
    const elapsed = performance.now() - started;
    expect(res.pageCount).toBe(1_000);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});
