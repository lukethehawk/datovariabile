import {
  cmyk,
  concatTransformationMatrix,
  decodePDFRawStream,
  degrees,
  drawObject,
  EncryptedPDFError,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  type PDFObject,
  type PDFPage,
  PDFRawStream,
  type PDFRef,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  setStrokingColor,
  type Color,
} from 'pdf-lib';
import { BarcodeRenderer } from './barcode';
import { FontCache } from './fonts';
import { compileContent } from './placeholders';
import { layoutText } from './text';
import type { Box, ColorSpec, DataSet, Field, FontAsset, Rotation, TemplatePage } from './types';

export interface Job {
  /** Template PDF bytes; null renders only the variable data (used by the live preview). */
  template: Uint8Array | null;
  pages: TemplatePage[];
  /** Template pages emitted for every record, in order. */
  pageIndices: number[];
  fields: Field[];
  fonts: FontAsset[];
  data: DataSet | null;
  /** Record range, 0-based, inclusive. */
  from: number;
  to: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface JobResult {
  bytes: Uint8Array;
  pageCount: number;
  warnings: string[];
}

const MAX_WARNINGS = 50;
const PROGRESS_EVERY = 100;

export async function loadTemplate(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new Error('Il PDF è protetto da password: rimuovi la protezione prima di usarlo come velina');
    }
    throw e;
  }
}

export async function inspectTemplate(bytes: Uint8Array): Promise<TemplatePage[]> {
  const doc = await loadTemplate(bytes);
  return doc.getPages().map((page) => {
    const mb = page.getMediaBox();
    const mediaBox: Box = normalize([mb.x, mb.y, mb.x + mb.width, mb.y + mb.height]);
    const boxes: TemplatePage['boxes'] = {};
    for (const name of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox'] as const) {
      const arr = page.node[name]();
      if (arr) {
        const r = arr.asRectangle();
        boxes[name] = normalize([r.x, r.y, r.x + r.width, r.y + r.height]);
      }
    }
    const view = intersect(mediaBox, boxes.CropBox ?? mediaBox);
    const rotate = ((((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360) as Rotation;
    const swap = rotate === 90 || rotate === 270;
    const w = view[2] - view[0];
    const h = view[3] - view[1];
    return { mediaBox, boxes, view, rotate, viewWidth: swap ? h : w, viewHeight: swap ? w : h };
  });
}

/**
 * Builds the variable data PDF. Every template page is embedded once as a Form
 * XObject and referenced by all output pages, so the output grows only by the
 * per-record text/barcode operators, not by a copy of the template per page.
 */
export async function generate(job: Job): Promise<JobResult> {
  const doc = await PDFDocument.create();
  doc.setProducer('DatoVariabile');
  doc.setCreator('DatoVariabile');
  const fonts = new FontCache(doc, job.fonts);
  const barcodes = new BarcodeRenderer();
  const warnings: string[] = [];

  const templatePages = job.template ? embedTemplatePages(doc, await loadTemplate(job.template), job.pageIndices) : null;

  const compiled = job.fields.map((f) => {
    try {
      return { field: f, resolve: compileContent(f.content, f.counter, job.data) };
    } catch (e) {
      throw new Error(`Zona "${f.name}": ${e instanceof Error ? e.message : e}`);
    }
  });
  const total = job.to - job.from + 1;

  for (let rec = job.from; rec <= job.to; rec++) {
    for (const pageIndex of job.pageIndices) {
      const tp = job.pages[pageIndex];
      const page = doc.addPage();
      let viewMatrix: Matrix;
      if (templatePages) {
        const [l, b, r, t] = tp.mediaBox;
        page.setMediaBox(l, b, r - l, t - b);
        for (const [name, box] of Object.entries(tp.boxes)) page.node.set(PDFName.of(name), doc.context.obj(box));
        page.setRotation(degrees(tp.rotate));
        const tpl = templatePages.get(pageIndex)!;
        if (tpl.group) page.node.set(PDFName.of('Group'), tpl.group);
        page.pushOperators(drawObject(page.node.newXObject('Velina', tpl.ref)));
        const [vl, vb, vr, vt] = tp.view;
        viewMatrix = rotationMatrix(tp.rotate, vr - vl, vt - vb, vl, vb);
      } else {
        page.setMediaBox(0, 0, tp.viewWidth, tp.viewHeight);
        viewMatrix = [1, 0, 0, 1, 0, 0];
      }
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...viewMatrix));
      for (const { field, resolve } of compiled) {
        if (field.page !== pageIndex) continue;
        try {
          const text = resolve(rec);
          const overflow = await drawField(page, field, text, tp.viewHeight, fonts, barcodes);
          if (overflow && warnings.length < MAX_WARNINGS) {
            warnings.push(`Record ${rec + 1}, zona "${field.name}": il testo non entra nella zona`);
          }
        } catch (e) {
          throw new Error(`Record ${rec + 1}, zona "${field.name}": ${e instanceof Error ? e.message : e}`);
        }
      }
      page.pushOperators(popGraphicsState());
    }
    const done = rec - job.from + 1;
    if (done % PROGRESS_EVERY === 0) {
      job.onProgress?.(done, total);
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve);
      await tick.promise;
      if (job.signal?.aborted) throw new DOMException('Generazione annullata', 'AbortError');
    }
  }
  job.onProgress?.(total, total);
  const bytes = await doc.save({ useObjectStreams: true, objectsPerTick: 2000 });
  return { bytes, pageCount: doc.getPageCount(), warnings };
}

/**
 * Turns template pages into Form XObjects. Unlike pdf-lib's embedPages (which
 * also copies the original content stream, doubling the template size), the
 * single compressed content stream is reused byte for byte.
 */
function embedTemplatePages(
  doc: PDFDocument,
  src: PDFDocument,
  indices: number[],
): Map<number, { ref: PDFRef; group?: PDFObject }> {
  const copier = PDFObjectCopier.for(src.context, doc.context);
  const srcPages = src.getPages();
  const result = new Map<number, { ref: PDFRef; group?: PDFObject }>();
  for (const index of new Set(indices)) {
    const node = srcPages[index].node;
    const mb = srcPages[index].getMediaBox();
    const resources = node.Resources();
    const groupObj = node.get(PDFName.of('Group'));
    const group = groupObj ? copier.copy(groupObj) : undefined;
    const dict: Record<string, PDFObject | number[] | string> = {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height],
      Resources: resources ? copier.copy(resources) : doc.context.obj({}),
    };
    if (group) dict.Group = group;

    const contents = node.Contents();
    const streams = (contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []).map((s) =>
      src.context.lookup(s),
    );
    let stream;
    if (streams.length === 1 && streams[0] instanceof PDFRawStream) {
      const raw = streams[0];
      for (const key of ['Filter', 'DecodeParms']) {
        const v = raw.dict.get(PDFName.of(key));
        if (v) dict[key] = copier.copy(v);
      }
      stream = doc.context.stream(raw.contents, dict);
    } else {
      const parts = streams.filter((s): s is PDFRawStream => s instanceof PDFRawStream).map((s) => decodePDFRawStream(s).decode());
      const joined = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        joined[at + p.length] = 0x0a;
        at += p.length + 1;
      }
      stream = doc.context.flateStream(joined, dict);
    }
    result.set(index, { ref: doc.context.register(stream), group });
  }
  return result;
}

type Matrix = [number, number, number, number, number, number];

/**
 * Maps a rotated local space onto a w×h rectangle placed at (ox, oy) in the outer
 * space; local axes are rotated counter-clockwise by `rot`. Used both for page
 * /Rotate (view → user space) and for field rotation (content → box).
 */
function rotationMatrix(rot: Rotation, w: number, h: number, ox: number, oy: number): Matrix {
  switch (rot) {
    case 90:
      return [0, 1, -1, 0, ox + w, oy];
    case 180:
      return [-1, 0, 0, -1, ox + w, oy + h];
    case 270:
      return [0, -1, 1, 0, ox, oy + h];
    default:
      return [1, 0, 0, 1, ox, oy];
  }
}

/** Draws one field in view space (y up). Returns true when the text overflows. */
async function drawField(
  page: PDFPage,
  field: Field,
  text: string,
  viewHeight: number,
  fonts: FontCache,
  barcodes: BarcodeRenderer,
): Promise<boolean> {
  const swap = field.rotation === 90 || field.rotation === 270;
  const lw = swap ? field.h : field.w;
  const lh = swap ? field.w : field.h;
  const color = pdfColor(field.color);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...rotationMatrix(field.rotation, field.w, field.h, field.x, viewHeight - field.y - field.h)),
  );
  if (field.whiteBackground) {
    page.drawRectangle({ x: 0, y: 0, width: lw, height: lh, color: field.color.mode === 'cmyk' ? cmyk(0, 0, 0, 0) : rgb(1, 1, 1) });
  }
  const m = field.margin;
  const iw = Math.max(1, lw - 2 * m);
  const ih = Math.max(1, lh - 2 * m);
  let overflow = false;
  if (text !== '') {
    if (field.type === 'text') {
      const font = await fonts.get(field.font);
      const layout = layoutText(text, font, field, iw, ih);
      overflow = layout.overflow;
      for (const line of layout.lines) {
        page.drawText(line.text, { x: m + line.x, y: m + line.y, size: layout.size, font, color });
      }
    } else {
      const font = await fonts.get('Helvetica');
      const placed = barcodes.place(field, text, iw, ih, font);
      page.pushOperators(
        pushGraphicsState(),
        setFillingColor(color),
        setStrokingColor(color),
        concatTransformationMatrix(1, 0, 0, 1, m, m),
        ...placed.ops,
        popGraphicsState(),
      );
      for (const l of placed.labels) {
        page.drawText(l.text, { x: m + l.x, y: m + l.y, size: l.size, font, color });
      }
    }
  }
  page.pushOperators(popGraphicsState());
  return overflow;
}

export function pdfColor(c: ColorSpec): Color {
  if (c.mode === 'cmyk') return cmyk(c.c / 100, c.m / 100, c.y / 100, c.k / 100);
  const n = parseInt(c.hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function normalize(b: Box): Box {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

function intersect(a: Box, b: Box): Box {
  const r: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : a;
}
