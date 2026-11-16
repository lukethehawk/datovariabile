import { PDFDocument, rgb, degrees } from 'pdf-lib';
import { inspectTemplate, type Job, type JobPage, type JobSource } from '../src/core/generate';
import type { BarcodeField, TextField } from '../src/core/types';

/** A template whose single page carries ~`kb` KB of vector content. */
export async function makeTemplate(opts: { kb: number; rotate?: number; trim?: boolean; seed?: number }): Promise<Uint8Array> {
  return makePdf([{ kb: opts.kb, rotate: opts.rotate, trim: opts.trim }], opts.seed);
}

/** A PDF with one page per entry (size in points, default A4). */
export async function makePdf(
  pages: Array<{ kb: number; size?: [number, number]; rotate?: number; trim?: boolean }>,
  seed = 1,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const opts of pages) {
    const [w, h] = opts.size ?? [595, 842];
    const page = doc.addPage([w, h]);
    if (opts.trim) page.setTrimBox(20, 20, w - 40, h - 40);
    if (opts.rotate) page.setRotation(degrees(opts.rotate));
    // Random coordinates do not compress: roughly 60 bytes per rectangle.
    for (let i = 0; i < (opts.kb * 1024) / 60; i++) {
      page.drawRectangle({ x: rnd() * w, y: rnd() * h, width: rnd() * 20, height: rnd() * 20, color: rgb(rnd(), rnd(), rnd()) });
    }
  }
  return doc.save();
}

/** A job over PDF sources: `pages` lists [source index, page index, slot id] in output order. */
export async function pdfJob(sources: Uint8Array[], pages: Array<[number, number, string]>, overrides: Partial<Job> = {}): Promise<Job> {
  const jobSources: JobSource[] = sources.map((bytes, i) => ({ id: `src${i}`, name: `file${i}.pdf`, kind: 'pdf', bytes }));
  const geometry = await Promise.all(sources.map((b) => inspectTemplate(b)));
  const jobPages: JobPage[] = pages.map(([s, p, slot]) => ({ slot, sourceId: `src${s}`, page: p, geometry: geometry[s][p] }));
  return { sources: jobSources, pages: jobPages, fields: [], fonts: [], data: null, from: 0, to: 0, ...overrides };
}

export function textField(overrides: Partial<TextField> = {}): TextField {
  return {
    id: 't1',
    name: 'Testo',
    type: 'text',
    slot: 's1',
    x: 100,
    y: 100,
    w: 200,
    h: 40,
    rotation: 0,
    color: { mode: 'cmyk', c: 0, m: 0, y: 0, k: 100 },
    content: '{Nome}',
    counter: { start: 1, step: 1, digits: 0 },
    whiteBackground: false,
    margin: 0,
    font: 'Helvetica',
    size: 12,
    align: 'left',
    valign: 'middle',
    lineHeight: 1.2,
    wrap: false,
    shrink: false,
    ...overrides,
  };
}

export function barcodeField(overrides: Partial<BarcodeField> = {}): BarcodeField {
  return {
    id: 'b1',
    name: 'Codice',
    type: 'barcode',
    slot: 's1',
    x: 300,
    y: 300,
    w: 100,
    h: 100,
    rotation: 0,
    color: { mode: 'cmyk', c: 0, m: 0, y: 0, k: 100 },
    content: '{#}',
    counter: { start: 1, step: 1, digits: 6 },
    whiteBackground: true,
    margin: 2,
    symbology: 'qrcode',
    showText: false,
    ecLevel: 'M',
    ...overrides,
  };
}
