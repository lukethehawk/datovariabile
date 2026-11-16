import { PDFDocument, rgb, degrees } from 'pdf-lib';
import type { BarcodeField, TextField } from '../src/core/types';

/** A template whose single page carries ~`kb` KB of vector content. */
export async function makeTemplate(opts: { kb: number; rotate?: number; trim?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  if (opts.trim) page.setTrimBox(20, 20, 555, 802);
  if (opts.rotate) page.setRotation(degrees(opts.rotate));
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Random coordinates do not compress: roughly 60 bytes per rectangle.
  for (let i = 0; i < (opts.kb * 1024) / 60; i++) {
    page.drawRectangle({ x: rnd() * 595, y: rnd() * 842, width: rnd() * 20, height: rnd() * 20, color: rgb(rnd(), rnd(), rnd()) });
  }
  return doc.save();
}

export function textField(overrides: Partial<TextField> = {}): TextField {
  return {
    id: 't1',
    name: 'Testo',
    type: 'text',
    page: 0,
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
    page: 0,
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
