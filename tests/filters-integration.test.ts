import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { readProjectFile, writeProjectArchive, type ProjectData, type SavedData } from '../src/core/archive';
import { toDataSet } from '../src/core/data';
import { generate, inspectTemplate, type Job, type JobPage, type JobResult } from '../src/core/generate';
import { compileGenerators, UNIQUE_ALPHABETS } from '../src/core/generators';
import { compileContent } from '../src/core/placeholders';
import type { TemplatePage, UniqueGenerator } from '../src/core/types';
import { barcodeField, makePdf, makeTemplate, pdfJob, textField } from './helpers';

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

/** Text of the given pages (1-based), one array per page, in drawing order. */
async function pageTexts(bytes: Uint8Array, pages: number[]): Promise<string[][]> {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' });
  const doc = await task.promise;
  const result: string[][] = [];
  for (const number of pages) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    result.push(content.items.flatMap((item) => ('str' in item && item.str ? [item.str] : [])));
  }
  await task.destroy();
  return result;
}

/**
 * Decoded content streams of the given pages (1-based): the exact operators the page draws.
 * pdf-lib names every page resource with a random suffix (`/Helvetica-5749991914`), which has no
 * meaning for the drawing: it is collapsed to the bare font name before comparing.
 */
async function pageStreams(bytes: Uint8Array, pages: number[]): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const decoder = new TextDecoder('latin1');
  return pages.map((number) => {
    const contents = doc.getPage(number - 1).node.Contents();
    const streams = (contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []).map((s) => doc.context.lookup(s));
    return streams
      .map((stream) => {
        if (!(stream instanceof PDFRawStream)) throw new Error(`contenuto della pagina ${number} non leggibile`);
        return decoder.decode(decodePDFRawStream(stream).decode()).replace(/\/Helvetica-\d+\b/g, '/Helvetica');
      })
      .join('\n');
  });
}

/** A job built from a project exactly as the UI does: enabled slots only, fields of those slots. */
async function jobFromProject(project: ProjectData): Promise<Job> {
  const geometry = new Map<string, TemplatePage[]>();
  const pages: JobPage[] = [];
  for (const slot of project.slots.filter((s) => s.enabled)) {
    const source = project.sources.find((s) => s.id === slot.sourceId);
    if (!source) throw new Error(`sorgente mancante: ${slot.sourceId}`);
    let sourceGeometry = geometry.get(source.id);
    if (!sourceGeometry) {
      sourceGeometry = await inspectTemplate(source.bytes);
      geometry.set(source.id, sourceGeometry);
    }
    pages.push({ slot: slot.id, sourceId: slot.sourceId, page: slot.page, geometry: sourceGeometry[slot.page] });
  }
  const enabled = new Set(pages.map((p) => p.slot));
  const data = project.data ? toDataSet(project.data.table, project.data.header) : null;
  const records = data ? data.rows.length : Math.max(1, project.manualCount);
  return {
    sources: project.sources,
    pages,
    fields: project.fields.filter((f) => enabled.has(f.slot)),
    fonts: project.fonts,
    data,
    generators: project.generators,
    now: 0,
    from: 0,
    to: records - 1,
  };
}

// ---------------------------------------------------------------- 1–2. unique codes, 1000 records

describe('filters on a full run of 1000 records', () => {
  const COUNT = 1_000;
  const codeGen = uniqueGen({ id: 'uc', name: 'Codice', alphabet: UNIQUE_ALPHABETS.alnum, length: 12 });
  const codes = compileGenerators([codeGen], { now: 0, count: COUNT }).get('Codice')!;
  /** What {|digits|right:4} must print, computed without the PDF. */
  const lastDigits = (record: number) => codes(record).replace(/[^0-9]+/g, '').slice(-4);

  const codeField = barcodeField({
    id: 'dm',
    name: 'DataMatrix',
    slot: 's1',
    content: '{@Codice}',
    symbology: 'datamatrix',
    x: 300,
    y: 320,
    w: 140,
    h: 140,
  });
  const digitsField = textField({ id: 'tx', name: 'Ultime cifre', slot: 's1', content: '{@Codice|digits|right:4}', x: 100, y: 100, w: 200, h: 40 });
  const fields = [codeField, digitsField];

  let full: JobResult;

  beforeAll(async () => {
    full = await generate(makeJob({ fields, generators: [codeGen], to: COUNT - 1 }));
  }, 300_000);

  it('prints the last four digits next to the full DataMatrix code', async () => {
    expect(full.pageCount).toBe(COUNT);
    const sampled = [1, 100, 1_000];
    const printed = await pageTexts(full.bytes, sampled);
    expect(printed).toEqual(sampled.map((page) => [lastDigits(page - 1)]));
  });

  it('encodes exactly the full code in the DataMatrix symbol', async () => {
    const sampled = [0, 99, 999];
    const fullStreams = await pageStreams(full.bytes, sampled.map((rec) => rec + 1));
    for (const [i, rec] of sampled.entries()) {
      // A reference job with the same geometry and literal contents: any difference in the page
      // stream can only come from what the placeholders resolved to.
      const reference = await generate(
        makeJob({
          fields: [
            { ...codeField, content: codes(rec) },
            { ...digitsField, content: lastDigits(rec) },
          ],
          to: 0,
        }),
      );
      expect(await pageStreams(reference.bytes, [1])).toEqual([fullStreams[i]]);
    }
  });

  it('reprints records 100–110 with identical texts and page streams', async () => {
    const part = await generate(makeJob({ fields, generators: [codeGen], from: 99, to: 109 }));
    expect(part.pageCount).toBe(11);
    const fullPages = Array.from({ length: 11 }, (_, i) => 100 + i);
    const partPages = Array.from({ length: 11 }, (_, i) => 1 + i);
    expect(await pageTexts(part.bytes, partPages)).toEqual(await pageTexts(full.bytes, fullPages));
    expect(await pageStreams(part.bytes, partPages)).toEqual(await pageStreams(full.bytes, fullPages));
  });
});

// ---------------------------------------------------------------- 3. front / back

describe('front and back pages', () => {
  it('prints the same generator value on both pages and ignores a disabled back zone', async () => {
    const front = await makeTemplate({ kb: 1, seed: 1 });
    const back = await makeTemplate({ kb: 1, seed: 2 });
    const g = uniqueGen({ id: 'uf', name: 'Gift', length: 6 });
    const value = compileGenerators([g], { now: 0, count: 3 }).get('Gift')!;
    const frontField = textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Fronte {@Gift}' });
    const backText = textField({ id: 'f2', name: 'Retro', slot: 'R', content: 'Retro {@Gift}' });
    const backQr = barcodeField({ id: 'b1', name: 'QR retro', slot: 'R', content: '{@Gift}', symbology: 'qrcode', x: 100, y: 500, w: 120, h: 120 });

    const both = await generate(await pdfJob([front, back], [[0, 0, 'F'], [1, 0, 'R']], { fields: [frontField, backText, backQr], generators: [g], to: 2 }));
    expect(both.pageCount).toBe(6);
    for (let rec = 0; rec < 3; rec++) {
      expect(await pageTexts(both.bytes, [rec * 2 + 1, rec * 2 + 2])).toEqual([
        [`Fronte ${value(rec)}`],
        [`Retro ${value(rec)}`],
      ]);
    }

    // The UI builds the job from the enabled slots only: the invalid formula of the excluded back
    // zone is not compiled, so it cannot block the run.
    const brokenBack = textField({ id: 'f2', name: 'Retro', slot: 'R', content: '{@Gift|rigth:4}' });
    const enabledOnly = await pdfJob([front], [[0, 0, 'F']], { fields: [frontField], generators: [g], to: 2 });
    const onlyFront = await generate(enabledOnly);
    expect(onlyFront.pageCount).toBe(3);
    expect(await pageTexts(onlyFront.bytes, [1, 2, 3])).toEqual([[`Fronte ${value(0)}`], [`Fronte ${value(1)}`], [`Fronte ${value(2)}`]]);

    // The same formula on an active zone is an error: the test above really excluded a broken zone.
    const withBrokenBack = await generate(
      await pdfJob([front, back], [[0, 0, 'F'], [1, 0, 'R']], { fields: [frontField, brokenBack], generators: [g], to: 2 }),
    ).catch((e: Error) => e);
    expect(withBrokenBack).toBeInstanceOf(Error);
    expect((withBrokenBack as Error).message).toContain('Zona "Retro"');
    expect((withBrokenBack as Error).message).toContain('filtro "rigth" sconosciuto');
  });

  it('combines a database, a numbering generator, the counter and filters', async () => {
    const data = { columns: ['Nome', 'Peso'], rows: [['anna', '12'], ['bruno', ''], ['carla', '7']] };
    const numbering = {
      id: 'n1',
      name: 'Matricola',
      type: 'numbering' as const,
      prefix: '',
      suffix: '',
      style: 'number' as const,
      start: 1,
      step: 1,
      digits: 4,
      alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      groupStart: 'A',
      numberMin: 1,
      numberMax: 999,
      overflow: 'grow' as const,
    };
    const field = textField({
      content: '{#|padleft:3:0} {@Matricola|lower} {Nome|upper} <{Peso|padleft:4:0}>',
      counter: { start: 1, step: 1, digits: 0 },
      w: 500,
    });
    const res = await generate(makeJob({ data, fields: [field], generators: [numbering], to: data.rows.length - 1 }));
    expect(await pageTexts(res.bytes, [1, 2, 3])).toEqual([['001 0001 ANNA <0012>'], ['002 0002 BRUNO <>'], ['003 0003 CARLA <0007>']]);
  });
});

// ---------------------------------------------------------------- 5. empty codes

describe('empty code zones', () => {
  const rowsWithEmpty = (length: number, emptyAt: number[]) =>
    Array.from({ length }, (_, i) => [emptyAt.includes(i + 1) ? '' : `R${i + 1}`]);

  it('reports every empty record of a QR zone', async () => {
    const data = { columns: ['V'], rows: rowsWithEmpty(10, [3, 7]) };
    const job = makeJob({ data, fields: [barcodeField({ name: 'QR', content: '{V}', symbology: 'qrcode' })], to: data.rows.length - 1 });
    await expect(generate(job)).rejects.toThrow('Zona "QR": il contenuto del codice è vuoto nei record 3, 7');
  });

  it('uses the single-record form for one empty record', async () => {
    const data = { columns: ['V'], rows: rowsWithEmpty(5, [3]) };
    const job = makeJob({ data, fields: [barcodeField({ name: 'QR', content: '{V}', symbology: 'qrcode' })], to: data.rows.length - 1 });
    await expect(generate(job)).rejects.toThrow('Record 3, zona "QR": il contenuto del codice è vuoto');
  });

  it('lists the first ten empty records and counts the others', async () => {
    const data = { columns: ['V'], rows: rowsWithEmpty(20, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) };
    const job = makeJob({ data, fields: [barcodeField({ name: 'QR', content: '{V}', symbology: 'qrcode' })], to: data.rows.length - 1 });
    await expect(generate(job)).rejects.toThrow('Zona "QR": il contenuto del codice è vuoto nei record 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (e altri 2)');
  });

  it('leaves empty text zones alone', async () => {
    const data = { columns: ['V'], rows: rowsWithEmpty(4, [2, 4]) };
    const res = await generate(makeJob({ data, fields: [textField({ name: 'Testo', content: '{V}' })], to: data.rows.length - 1 }));
    expect(res.pageCount).toBe(4);
    expect(res.warnings).toEqual([]);
  });

  it('treats padding of an empty code as empty, but not fixed text around it', async () => {
    const data = { columns: ['V'], rows: rowsWithEmpty(10, [3, 7]) };
    const padded = makeJob({ data, fields: [barcodeField({ name: 'Padded', content: '{V|padleft:6:0}', symbology: 'qrcode' })], to: data.rows.length - 1 });
    await expect(generate(padded)).rejects.toThrow('Zona "Padded": il contenuto del codice è vuoto nei record 3, 7');

    // Documented limitation: FT- is not empty, so the empty-code check does not catch it.
    const fixed = makeJob({ data, fields: [barcodeField({ name: 'Fisso', content: 'FT-{V}', symbology: 'qrcode' })], to: data.rows.length - 1 });
    const res = await generate(fixed);
    expect(res.pageCount).toBe(10);
  });
});

// ---------------------------------------------------------------- 6. archive round trip

describe('filters in the project archive', () => {
  const cells = [
    ['Codice', 'Peso {kg}'],
    ['AB12', 'ciao'],
    ['CD34', 'mondo'],
  ];
  const saved: SavedData = {
    name: 'dati.csv',
    original: new TextEncoder().encode('Codice;Peso {kg}\r\nAB12;ciao\r\nCD34;mondo\r\n'),
    table: { sheets: [], sheet: '', cells, headerGuess: true },
    header: true,
    columns: ['Codice', 'Peso {kg}'],
  };
  const project = async (): Promise<ProjectData> => ({
    sources: [{ id: 'a', name: 'velina.pdf', kind: 'pdf', bytes: await makePdf([{ kb: 1 }]) }],
    slots: [{ id: 's1', sourceId: 'a', page: 0, enabled: true }],
    fields: [
      textField({ id: 'a', name: 'Codice breve', slot: 's1', content: '{@Codice|right:4}', x: 100, y: 100 }),
      textField({ id: 'b', name: 'Peso', slot: 's1', content: '{"Peso {kg}"|upper}', x: 100, y: 200 }),
      textField({ id: 'c', name: 'Graffe', slot: 's1', content: '{{literal}}', x: 100, y: 300 }),
    ],
    fonts: [],
    manualCount: 2,
    data: saved,
    range: { from: '', to: '' },
    generators: [uniqueGen({ id: 'uc', name: 'Codice', alphabet: UNIQUE_ALPHABETS.alnum, length: 12 })],
  });

  it('keeps filtered contents and generated texts identical after save and reopen', async () => {
    const before = await project();
    const opened = await readProjectFile(new Uint8Array(await (await writeProjectArchive(before)).blob.arrayBuffer()));
    expect(opened.project.fields.map((f) => f.content)).toEqual(before.fields.map((f) => f.content));
    expect(opened.warnings).toEqual([]);

    const textsBefore = await pageTexts((await generate(await jobFromProject(before))).bytes, [1, 2]);
    const textsAfter = await pageTexts((await generate(await jobFromProject(opened.project))).bytes, [1, 2]);
    expect(textsAfter).toEqual(textsBefore);
    expect(textsAfter[0]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- 7. performance

describe('filter performance on 10 000 records', () => {
  it('measures resolver and generation with and without filters', async () => {
    const COUNT = 10_000;
    const data = { columns: ['V'], rows: Array.from({ length: COUNT }, (_, i) => [`  abc${i}  `]) };
    const counter = { start: 1, step: 1, digits: 0 };
    const plain = compileContent('{V}', counter, data, null);
    const filtered = compileContent('{V|trim|upper|right:4|padleft:6:0}', counter, data, null);
    expect(filtered(1234)).toBe('001234');

    const resolve = (fn: (record: number) => string): number => {
      let sink = 0;
      const start = performance.now();
      for (let i = 0; i < COUNT; i++) sink += fn(i).length;
      const ms = performance.now() - start;
      expect(sink).toBeGreaterThan(0);
      return ms;
    };
    for (let i = 0; i < 1_000; i++) plain(i) + filtered(i); // warm up both resolvers
    const plainResolveMs = resolve(plain);
    const filteredResolveMs = resolve(filtered);

    const timeGenerate = async (content: string): Promise<number> => {
      const start = performance.now();
      const res = await generate(makeJob({ data, fields: [textField({ content, w: 400 })], to: COUNT - 1 }));
      expect(res.pageCount).toBe(COUNT);
      return performance.now() - start;
    };
    const plainPdfMs = await timeGenerate('{V}');
    const filteredPdfMs = await timeGenerate('{V|trim|upper|right:4|padleft:6:0}');

    console.log(
      `[prestazioni] ${COUNT} record — resolver {V}: ${plainResolveMs.toFixed(1)} ms, con filtri: ${filteredResolveMs.toFixed(1)} ms; ` +
        `generate() {V}: ${plainPdfMs.toFixed(0)} ms, con filtri: ${filteredPdfMs.toFixed(0)} ms`,
    );
    expect(filteredResolveMs).toBeLessThan(1_000);
  }, 600_000);
});
