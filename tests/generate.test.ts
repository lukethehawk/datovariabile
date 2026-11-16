import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { generate, inspectTemplate, type Job } from '../src/core/generate';
import { barcodeField, makeTemplate, textField } from './helpers';

async function job(template: Uint8Array, overrides: Partial<Job> = {}): Promise<Job> {
  const rows = Array.from({ length: 20 }, (_, i) => [`Nome ${i + 1}`, String(9780201379620 + i).slice(0, 12)]);
  return {
    template,
    pages: await inspectTemplate(template),
    pageIndices: [0],
    fields: [textField()],
    fonts: [],
    data: { columns: ['Nome', 'EAN'], rows },
    from: 0,
    to: rows.length - 1,
    ...overrides,
  };
}

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

describe('generate', () => {
  it('references the template once instead of copying it per page', async () => {
    const template = await makeTemplate({ kb: 200 });
    const rows = Array.from({ length: 500 }, (_, i) => [`Cliente numero ${i}`, '']);
    const res = await generate(await job(template, { data: { columns: ['Nome', 'EAN'], rows }, to: 499 }));

    expect(res.pageCount).toBe(500);
    // A copy per page would be ~100 MB; even one extra copy would exceed this bound.
    expect(res.bytes.length).toBeLessThan(template.length * 1.3 + 500 * 400);

    const out = await PDFDocument.load(res.bytes);
    const big = [...out.context.enumerateIndirectObjects()].filter(
      ([, o]) => o instanceof PDFRawStream && o.contents.length > 100_000,
    );
    expect(big).toHaveLength(1);
  });

  it('keeps the template page boxes and rotation', async () => {
    const template = await makeTemplate({ kb: 1, trim: true, rotate: 90 });
    const res = await generate(await job(template, { to: 1 }));
    const page = (await PDFDocument.load(res.bytes)).getPage(1);
    expect(page.getRotation().angle).toBe(90);
    expect(page.getTrimBox()).toEqual({ x: 20, y: 20, width: 555, height: 802 });
    expect(page.node.get(PDFName.of('TrimBox'))).toBeDefined();
  });

  it.each([0, 90, 180, 270])('places fields where they were drawn on a page rotated %i°', async (rotate) => {
    const template = await makeTemplate({ kb: 1, rotate });
    const field = textField({ x: 100, y: 50, w: 200, h: 30, size: 20, valign: 'top' });
    const res = await generate(await job(template, { fields: [field], from: 2, to: 2 }));
    const [item] = await textPositions(res.bytes, 1);
    expect(item.str).toBe('Nome 3');
    expect(item.x).toBeCloseTo(100, 0);
    // Baseline sits one ascent (~0.72 em for Helvetica) below the top of the box.
    expect(item.y).toBeGreaterThan(50 + 12);
    expect(item.y).toBeLessThan(50 + 20);
  });

  it('renders barcodes and resolves counters per absolute record index', async () => {
    const template = await makeTemplate({ kb: 1 });
    const fields = [
      barcodeField({ content: '{EAN}', symbology: 'ean13', showText: true, w: 120, h: 60 }),
      textField({ content: 'N. {#}', counter: { start: 10, step: 5, digits: 4 } }),
    ];
    const res = await generate(await job(template, { fields, from: 3, to: 4 }));
    const texts = (await textPositions(res.bytes, 2)).map((t) => t.str);
    expect(texts).toContain('N. 0030');
    // EAN-13 human readable digits, check digit included.
    expect(texts.join('')).toContain('978020137962');
  });

  it('names record and field when a value cannot be printed', async () => {
    const template = await makeTemplate({ kb: 1 });
    const data = { columns: ['Nome', 'EAN'], rows: [['ok', '123'], ['Zażółć', 'abc']] };
    await expect(generate(await job(template, { data, to: 1 }))).rejects.toThrow(/Record 2, zona "Testo".*/);
    const ean = [barcodeField({ content: '{EAN}', symbology: 'ean13' })];
    await expect(generate(await job(template, { data, fields: ean, to: 1 }))).rejects.toThrow(/Record 1, zona "Codice"/);
  });

  it('warns about overflowing text and shrinks it when asked', async () => {
    const template = await makeTemplate({ kb: 1 });
    const data = { columns: ['Nome', 'EAN'], rows: [['Un nome davvero molto lungo per questa zona', '']] };
    const narrow = textField({ w: 60, size: 12 });
    const res = await generate(await job(template, { data, fields: [narrow], to: 0 }));
    expect(res.warnings).toHaveLength(1);
    const shrunk = await generate(await job(template, { data, fields: [{ ...narrow, shrink: true }], to: 0 }));
    expect(shrunk.warnings).toHaveLength(0);
  });

  it('rejects placeholders for missing columns', async () => {
    const template = await makeTemplate({ kb: 1 });
    await expect(generate(await job(template, { fields: [textField({ content: '{Cognome}' })] }))).rejects.toThrow(
      'Colonna "Cognome" non presente',
    );
  });
});
