import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { readProjectFile, writeProjectArchive } from '../src/core/archive';
import { blankPageName, blankPagePdf, blankSizeProblem, parseMm } from '../src/core/blank';
import { generate } from '../src/core/generate';
import { UNIQUE_ALPHABETS } from '../src/core/generators';
import type { ProjectData } from '../src/core/project';
import type { NumberingGenerator, UniqueGenerator } from '../src/core/types';
import { openZip } from '../src/core/zip';
import { barcodeField, makePdf, pdfJob, textField } from './helpers';

const MM = 72 / 25.4;

/** The requirement is 1/100 mm. */
function expectMm(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.01);
}

/** Text of one page, in reading order. */
async function texts(bytes: Uint8Array, pageNumber: number): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' });
  const page = await (await task.promise).getPage(pageNumber);
  const content = await page.getTextContent();
  const items = content.items.flatMap((it) => ('str' in it && it.str ? [it.str] : []));
  await task.destroy();
  return items;
}

interface PageBox {
  widthMm: number;
  heightMm: number;
  x: number;
  y: number;
  rotation: number;
  cropBox: boolean;
}

/** MediaBox (mm), origin, /Rotate and CropBox presence of the requested pages, in one load. */
async function pdfPages(bytes: Uint8Array, pageNumbers: number[]): Promise<{ pageCount: number; pages: PageBox[] }> {
  const doc = await PDFDocument.load(bytes);
  return {
    pageCount: doc.getPageCount(),
    pages: pageNumbers.map((n) => {
      const page = doc.getPage(n - 1);
      const mb = page.getMediaBox();
      return {
        widthMm: mb.width / MM,
        heightMm: mb.height / MM,
        x: mb.x,
        y: mb.y,
        rotation: page.getRotation().angle,
        cropBox: page.node.get(PDFName.of('CropBox')) !== undefined,
      };
    }),
  };
}

/** Sizes (mm) of every Form XObject in the output: one per background used. */
async function formBoxes(bytes: Uint8Array): Promise<Array<[number, number]>> {
  const doc = await PDFDocument.load(bytes);
  const boxes: Array<[number, number]> = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form') continue;
    const bbox = obj.dict.get(PDFName.of('BBox'));
    if (!(bbox instanceof PDFArray)) continue;
    const [x0, y0, x1, y1] = bbox.asArray().map((v) => Number(v.toString()));
    boxes.push([(x1 - x0) / MM, (y1 - y0) / MM]);
  }
  return boxes;
}

/** Form XObjects of a given size: the blank page must be embedded exactly once. */
function blankForms(boxes: Array<[number, number]>, widthMm: number, heightMm: number): Array<[number, number]> {
  return boxes.filter(([w, h]) => Math.abs(w - widthMm) <= 0.02 && Math.abs(h - heightMm) <= 0.02);
}

/** Fixed 256-bit key: the codes are reproducible, so the tests can compute them without the PDF. */
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function uniqueGen(overrides: Partial<UniqueGenerator> = {}): UniqueGenerator {
  return {
    id: 'u1',
    name: 'Codice',
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
    name: 'Numero',
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

// ---------------------------------------------------------------- size and name

describe('blank page size and name', () => {
  it('parses millimetres with the Italian comma or a point', () => {
    expect(parseMm('50')).toBe(50);
    expect(parseMm('50,5')).toBe(50.5);
    expect(parseMm('50.25')).toBe(50.25);
    expect(parseMm(' 30 ')).toBe(30);
    // At most 2 decimals: more would be silently rounded in names and in the dialog.
    for (const bad of ['', '-5', '0x10', '5 mm', '1,2,3', 'abc', '50,004', '50.']) expect(parseMm(bad)).toBeNull();
  });

  it('explains which side is wrong when a size cannot be used', () => {
    expect(blankSizeProblem(50, 30)).toBeNull();

    // Out of range: the message names the wrong side and the allowed range.
    expect(blankSizeProblem(0, 30)).toMatch(/larghezza.*tra 2 e 5080 mm/);
    expect(blankSizeProblem(50, 0)).toMatch(/altezza.*tra 2 e 5080 mm/);
    // 1 mm is below the 3 pt (1,06 mm) minimum page size of PDF readers.
    expect(blankSizeProblem(1, 30)).toMatch(/larghezza.*tra 2 e 5080 mm/);
    expect(blankSizeProblem(50, 1.5)).toMatch(/altezza.*tra 2 e 5080 mm/);
    expect(blankSizeProblem(2, 2)).toBeNull();
    expect(blankSizeProblem(5081, 30)).toMatch(/larghezza.*tra 2 e 5080 mm/);
    expect(blankSizeProblem(50, 5081)).toMatch(/altezza.*tra 2 e 5080 mm/);

    // Missing or non-numeric values.
    expect(blankSizeProblem(null, 30)).toMatch(/larghezza.*numero/);
    expect(blankSizeProblem(50, null)).toMatch(/altezza.*numero/);
    expect(blankSizeProblem(NaN, 30)).toMatch(/larghezza.*numero/);
    expect(blankSizeProblem(50, NaN)).toMatch(/altezza.*numero/);
  });

  it('names the file after the user or after the size in millimetres', () => {
    expect(blankPageName(50, 30, 'Etichetta prodotto')).toBe('Etichetta prodotto.pdf');
    expect(blankPageName(50, 30, '')).toBe('Pagina vuota 50 × 30 mm.pdf');
    expect(blankPageName(50, 30, '   ')).toBe('Pagina vuota 50 × 30 mm.pdf');
    expect(blankPageName(50, 30)).toBe('Pagina vuota 50 × 30 mm.pdf');
    expect(blankPageName(50.5, 30.25)).toBe('Pagina vuota 50,5 × 30,25 mm.pdf');
  });
});

// ---------------------------------------------------------------- geometry

const SIZES: Array<[number, number]> = [
  [50, 30],
  [100, 150],
  [30, 20],
  [210, 297],
  [50.5, 30.25],
];

describe('blank page geometry', () => {
  it('builds a one-page PDF of exactly the requested size, no crop box and no rotation', async () => {
    for (const [width, height] of SIZES) {
      const bytes = await blankPagePdf(width, height, 'Prova');
      const { pageCount, pages } = await pdfPages(bytes, [1]);
      expect(pageCount).toBe(1);
      const [box] = pages;
      expectMm(box.widthMm, width);
      expectMm(box.heightMm, height);
      expect(box.x).toBe(0);
      expect(box.y).toBe(0);
      expect(box.rotation).toBe(0);
      expect(box.cropBox).toBe(false);
    }
  });

  it('keeps that MediaBox in the generated PDF', async () => {
    for (const [width, height] of SIZES) {
      const blank = await blankPagePdf(width, height, 'Prova');
      const res = await generate(await pdfJob([blank], [[0, 0, 's1']], { to: 0 }));
      expect(res.pageCount).toBe(1);
      const { pageCount, pages } = await pdfPages(res.bytes, [1]);
      expect(pageCount).toBe(1);
      const [box] = pages;
      expectMm(box.widthMm, width);
      expectMm(box.heightMm, height);
      expect(box.x).toBe(0);
      expect(box.y).toBe(0);
      expect(box.rotation).toBe(0);
      expect(box.cropBox).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- file

describe('blank page file', () => {
  it('is byte-for-byte reproducible and stays under 2 KB', async () => {
    const first = await blankPagePdf(50, 30, 'Etichetta');
    const second = await blankPagePdf(50, 30, 'Etichetta');
    expect(second).toEqual(first);
    expect(first.length).toBeLessThan(2 * 1024);
    expect(await blankPagePdf(30, 50, 'Etichetta')).not.toEqual(first);
  });

  it('refuses sizes outside the allowed range', async () => {
    await expect(blankPagePdf(0, 30, 'Prova')).rejects.toThrow(/larghezza.*tra 2 e 5080 mm/);
    await expect(blankPagePdf(5081, 30, 'Prova')).rejects.toThrow(/larghezza.*tra 2 e 5080 mm/);
    await expect(blankPagePdf(50, 0, 'Prova')).rejects.toThrow(/altezza.*tra 2 e 5080 mm/);
    await expect(blankPagePdf(50, 5081, 'Prova')).rejects.toThrow(/altezza.*tra 2 e 5080 mm/);
  });
});

// ---------------------------------------------------------------- 1000 labels

describe('blank page as a label in a real generation', () => {
  it('generates 1000 labels with DataMatrix, counter and QR on a blank 50 × 30 page', async () => {
    const blank = await blankPagePdf(50, 30, 'Etichetta');
    const generators = [uniqueGen()];
    const fields = [
      textField({ id: 't1', name: 'Progressivo', slot: 's1', content: '{#}', x: 4, y: 4, w: 60, h: 8, size: 6 }),
      barcodeField({
        id: 'b1',
        name: 'Matrice',
        slot: 's1',
        content: '{@Codice}',
        symbology: 'datamatrix',
        x: 8,
        y: 16,
        w: 40,
        h: 40,
      }),
      barcodeField({
        id: 'b2',
        name: 'QR',
        slot: 's1',
        content: '{@Codice}',
        symbology: 'qrcode',
        x: 60,
        y: 16,
        w: 40,
        h: 40,
      }),
    ];

    const started = performance.now();
    const res = await generate(await pdfJob([blank], [[0, 0, 's1']], { fields, generators, to: 999 }));
    const elapsed = performance.now() - started;
    console.log(
      `1000 etichette su pagina vuota 50 × 30: ${Math.round(elapsed)} ms, PDF ${(res.bytes.length / 1024).toFixed(1)} KB, una Form XObject`,
    );

    expect(res.pageCount).toBe(1_000);
    expect(res.bytes.length).toBeLessThan(3 * 1024 * 1024);
    // Only a layout regression could get close to a minute: the bound is a guard, not a measure.
    expect(elapsed).toBeLessThan(60_000);

    const { pageCount, pages } = await pdfPages(res.bytes, [1, 100, 1_000]);
    expect(pageCount).toBe(1_000);
    for (const box of pages) {
      expectMm(box.widthMm, 50);
      expectMm(box.heightMm, 30);
      expect(box.x).toBe(0);
      expect(box.y).toBe(0);
    }

    expect(await texts(res.bytes, 1)).toEqual(['1']);
    expect(await texts(res.bytes, 1_000)).toEqual(['1000']);

    // A copy of the background per page would leave 1000 Form XObjects here.
    const forms = await formBoxes(res.bytes);
    expect(blankForms(forms, 50, 30)).toHaveLength(1);
    expect(forms).toHaveLength(1);
  }, 120_000);
});

// ---------------------------------------------------------------- composition

describe('blank pages in mixed compositions', () => {
  it('alternates a loaded PDF front and a blank back, sharing the numbering value', async () => {
    const front = await makePdf([{ kb: 1 }], 3);
    const back = await blankPagePdf(50, 30, 'Retro');
    const generators = [numberingGen({ digits: 4 })];
    const data = { columns: ['Nome'], rows: [['Anna'], ['Bruno'], ['Carla']] };
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: '{Nome} {@Numero}' }),
      textField({ id: 'f2', name: 'Retro', slot: 'R', content: 'Retro {@Numero}', x: 4, y: 4, w: 80, h: 8, size: 6 }),
    ];
    const res = await generate(
      await pdfJob([front, back], [[0, 0, 'F'], [1, 0, 'R']], { fields, generators, data, to: 2 }),
    );
    expect(res.pageCount).toBe(6);

    const { pages } = await pdfPages(res.bytes, [1, 2, 3, 4, 5, 6]);
    for (const i of [0, 2, 4]) {
      expectMm(pages[i].widthMm, 595 / MM);
      expectMm(pages[i].heightMm, 842 / MM);
    }
    for (const i of [1, 3, 5]) {
      expectMm(pages[i].widthMm, 50);
      expectMm(pages[i].heightMm, 30);
    }

    const expected = ['0001', '0002', '0003'];
    for (let rec = 0; rec < 3; rec++) {
      const f = await texts(res.bytes, rec * 2 + 1);
      const b = await texts(res.bytes, rec * 2 + 2);
      expect(f).toEqual([`${data.rows[rec][0]} ${expected[rec]}`]);
      expect(b).toEqual([`Retro ${expected[rec]}`]);
    }

    const forms = await formBoxes(res.bytes);
    expect(forms).toHaveLength(2);
    expect(blankForms(forms, 50, 30)).toHaveLength(1);
  });

  it('duplicates one blank page in two slots with independent zones, embedding it once', async () => {
    const blank = await blankPagePdf(50, 30, 'Etichetta');
    const fields = [
      textField({ id: 'a1', name: 'Lato A', slot: 'a', content: 'Lato A {#}', x: 4, y: 4, w: 80, h: 8, size: 6 }),
      textField({ id: 'b1', name: 'Lato B', slot: 'b', content: 'Lato B {#}', x: 4, y: 20, w: 80, h: 8, size: 6 }),
    ];
    const res = await generate(await pdfJob([blank], [[0, 0, 'a'], [0, 0, 'b']], { fields, to: 1 }));
    expect(res.pageCount).toBe(4);

    expect(await texts(res.bytes, 1)).toEqual(['Lato A 1']);
    expect(await texts(res.bytes, 2)).toEqual(['Lato B 1']);
    expect(await texts(res.bytes, 3)).toEqual(['Lato A 2']);
    expect(await texts(res.bytes, 4)).toEqual(['Lato B 2']);

    const { pages } = await pdfPages(res.bytes, [1, 2, 3, 4]);
    for (const box of pages) {
      expectMm(box.widthMm, 50);
      expectMm(box.heightMm, 30);
    }

    const forms = await formBoxes(res.bytes);
    expect(blankForms(forms, 50, 30)).toHaveLength(1);
    expect(forms).toHaveLength(1);
  });

  it('respects the slot order when the blank page comes before the loaded PDF', async () => {
    const front = await makePdf([{ kb: 1 }], 4);
    const back = await blankPagePdf(50, 30, 'Retro');
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Fronte {#}' }),
      textField({ id: 'r1', name: 'Retro', slot: 'R', content: 'Retro {#}', x: 4, y: 4, w: 80, h: 8, size: 6 }),
    ];
    const res = await generate(await pdfJob([front, back], [[1, 0, 'R'], [0, 0, 'F']], { fields, to: 0 }));
    expect(res.pageCount).toBe(2);

    const { pages } = await pdfPages(res.bytes, [1, 2]);
    expectMm(pages[0].widthMm, 50);
    expectMm(pages[0].heightMm, 30);
    expectMm(pages[1].widthMm, 595 / MM);
    expectMm(pages[1].heightMm, 842 / MM);

    expect(await texts(res.bytes, 1)).toEqual(['Retro 1']);
    expect(await texts(res.bytes, 2)).toEqual(['Fronte 1']);

    const forms = await formBoxes(res.bytes);
    expect(forms).toHaveLength(2);
    expect(blankForms(forms, 50, 30)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- project archive

describe('blank page in the project archive', () => {
  it('saves and reopens a project whose only source is a blank page, as format 4', async () => {
    const bytes = await blankPagePdf(50, 30, 'Etichetta prodotto');
    const generators = [numberingGen({ digits: 4 })];
    const fields = [
      textField({
        id: 't1',
        name: 'Etichetta',
        slot: 's1',
        content: 'Etichetta {@Numero}',
        x: 5,
        y: 5,
        w: 120,
        h: 10,
        size: 8,
      }),
    ];
    const project: ProjectData = {
      sources: [{ id: 'src', name: 'Etichetta prodotto.pdf', kind: 'pdf', bytes }],
      slots: [{ id: 's1', sourceId: 'src', page: 0, enabled: true }],
      fields,
      fonts: [],
      manualCount: 25,
      data: null,
      range: { from: '5', to: '9' },
      generators,
    };

    const { blob, warnings } = await writeProjectArchive(project);
    expect(warnings).toEqual([]);
    const archive = new Uint8Array(await blob.arrayBuffer());

    const zip = openZip(archive);
    const manifest = JSON.parse(new TextDecoder().decode(await zip.read('progetto.json'))) as { version: number };
    expect(manifest.version).toBe(4);

    const opened = await readProjectFile(archive);
    expect(opened.legacy).toBe(false);
    expect(opened.warnings).toEqual([]);
    expect(opened.project.sources).toHaveLength(1);
    expect(opened.project.sources[0].name).toBe('Etichetta prodotto.pdf');
    expect(opened.project.sources[0].kind).toBe('pdf');
    expect(opened.project.sources[0].bytes).toEqual(bytes);
    expect(opened.project.slots).toEqual(project.slots);
    expect(opened.project.fields).toEqual(fields);
    expect(opened.project.generators).toEqual(generators);
    expect(opened.project.manualCount).toBe(25);
    expect(opened.project.range).toEqual({ from: '5', to: '9' });
  });
});
