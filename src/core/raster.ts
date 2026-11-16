/**
 * Raster backgrounds (JPEG/PNG) embedded without quality loss.
 *
 * JPEG: the original DCT data is copied byte for byte (DCTDecode); only metadata
 * segments that the PDF does not need (EXIF, XMP, ICC, Photoshop, comments) are
 * dropped, the ICC profile moving to an ICCBased colour space when it applies.
 * PNG: greyscale, RGB and palette images without interlacing keep their zlib
 * data as is (FlateDecode + PNG predictors, every bit depth 1–16). Images with an
 * alpha channel, palette transparency or Adam7 interlacing are decoded at their
 * native depth and re-deflated losslessly, alpha going to an SMask.
 *
 * Colour policy (decided with the user, see DIARIO_SVILUPPO.md): an RGB profile
 * becomes ICCBased; greyscale and CMYK images keep their device values and the
 * profile is ignored with a warning, so that a K-only black stays K-only on press.
 */
import { PDFHexString, type PDFDocument, type PDFRef } from 'pdf-lib';
import { crc32 } from './crc32';
import type { Matrix, RasterLayout, TemplatePage } from './types';

export type RasterKind = 'jpeg' | 'png';

export interface RasterInfo {
  kind: RasterKind;
  /** Stored pixel size (before the EXIF orientation). */
  width: number;
  height: number;
  /** EXIF orientation 1–8 (1 = as stored). */
  orientation: number;
  /** Resolution written in the file, in dots per inch, when given in a physical unit. */
  dpi: [number, number] | null;
  /** Short Italian description for the interface. */
  description: string;
}

/** Decoded images above this size (bytes of raw samples) are refused: the browser would run out of memory. */
export const MAX_DECODED_BYTES = 400 * 1024 * 1024;

/** Below this resolution the value written in the file is usually a default (72/96 dpi), not the print size. */
export const MIN_RELIABLE_DPI = 150;

export function inspectRaster(bytes: Uint8Array, kind: RasterKind): RasterInfo {
  if (kind === 'jpeg') {
    const j = parseJpeg(bytes);
    const space = j.components === 4 ? 'CMYK' : j.components === 3 ? 'RGB' : 'scala di grigi';
    return {
      kind,
      width: j.width,
      height: j.height,
      orientation: j.orientation,
      dpi: j.dpi,
      description: `JPEG ${space}${j.progressive ? ' progressivo' : ''}${j.icc ? ', profilo ICC' : ''}`,
    };
  }
  const p = parsePng(bytes);
  const types: Record<number, string> = { 0: 'scala di grigi', 2: 'RGB', 3: 'a palette', 4: 'scala di grigi', 6: 'RGB' };
  const alpha = p.colorType === 4 || p.colorType === 6 || p.trns !== null;
  return {
    kind,
    width: p.width,
    height: p.height,
    orientation: p.orientation,
    dpi: p.dpi,
    description: `PNG ${types[p.colorType]} ${p.bitDepth} bit${alpha ? ', trasparenza' : ''}${p.interlace ? ', interlacciato' : ''}${p.iccp ? ', profilo ICC' : ''}`,
  };
}

/** Embeds the image once as an Image XObject; `warn` receives non-blocking notes (ignored profiles…). */
export async function embedRaster(doc: PDFDocument, bytes: Uint8Array, kind: RasterKind, warn: (msg: string) => void): Promise<PDFRef> {
  return kind === 'jpeg' ? embedJpeg(doc, bytes, warn) : embedPng(doc, bytes, warn);
}

// ---------------------------------------------------------------- page geometry

export const PAGE_SIZES: Record<'A3' | 'A4' | 'A5', [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
};

export function defaultLayout(info: RasterInfo): RasterLayout {
  const reliable = info.dpi !== null && Math.min(...info.dpi) >= MIN_RELIABLE_DPI;
  return { size: reliable ? 'image' : 'A4', width: PAGE_SIZES.A4[0], height: PAGE_SIZES.A4[1], orientation: 'auto', fit: 'contain', dpi: null };
}

export interface RasterPage {
  geometry: TemplatePage;
  /** Image unit square → page user space (EXIF orientation included). */
  matrix: Matrix;
  /** Clip to the page (fit = cover). */
  clip: boolean;
  /** Resolution of the image as printed on this page (lowest of the two axes). */
  effectiveDpi: number;
}

/** Stored image unit square → displayed unit square for EXIF orientations 1–8 (image space: y up, row 0 on top). */
const ORIENTATION: Record<number, Matrix> = {
  1: [1, 0, 0, 1, 0, 0],
  2: [-1, 0, 0, 1, 1, 0],
  3: [-1, 0, 0, -1, 1, 1],
  4: [1, 0, 0, -1, 0, 1],
  5: [0, -1, -1, 0, 1, 1],
  6: [0, -1, 1, 0, 0, 1],
  7: [0, 1, 1, 0, 0, 0],
  8: [0, 1, -1, 0, 1, 0],
};

/** Applies m1 then m2. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

/** Page size and image placement for a raster slot. Pure: the same result feeds editor, preview and output. */
export function rasterPage(info: RasterInfo, layout: RasterLayout): RasterPage {
  const swap = info.orientation >= 5;
  const pxW = swap ? info.height : info.width;
  const pxH = swap ? info.width : info.height;
  const fileDpi = info.dpi && (swap ? ([info.dpi[1], info.dpi[0]] as [number, number]) : info.dpi);
  const dpi: [number, number] | null = layout.dpi ? [layout.dpi, layout.dpi] : fileDpi;

  let pageW: number;
  let pageH: number;
  let rect: [number, number, number, number]; // x, y, w, h in points
  if (layout.size === 'image') {
    if (!dpi) throw new Error('l’immagine non indica la risoluzione: imposta i DPI o scegli un formato pagina');
    pageW = (pxW / dpi[0]) * 72;
    pageH = (pxH / dpi[1]) * 72;
    rect = [0, 0, pageW, pageH];
  } else {
    // Physical proportions when the file gives different X/Y resolutions, pixel proportions otherwise.
    const imgW = dpi ? pxW / dpi[0] : pxW;
    const imgH = dpi ? pxH / dpi[1] : pxH;
    const [a, b] = layout.size === 'custom' ? [layout.width, layout.height] : PAGE_SIZES[layout.size];
    const short = Math.min(a, b);
    const long = Math.max(a, b);
    const landscape = layout.orientation === 'auto' ? (layout.size === 'custom' ? a > b : imgW > imgH) : layout.orientation === 'landscape';
    if (layout.size === 'custom' && layout.orientation === 'auto') [pageW, pageH] = [a, b];
    else [pageW, pageH] = landscape ? [long, short] : [short, long];
    if (layout.fit === 'stretch') rect = [0, 0, pageW, pageH];
    else {
      const k = layout.fit === 'cover' ? Math.max(pageW / imgW, pageH / imgH) : Math.min(pageW / imgW, pageH / imgH);
      const w = imgW * k;
      const h = imgH * k;
      rect = [(pageW - w) / 2, (pageH - h) / 2, w, h];
    }
  }
  const box: [number, number, number, number] = [0, 0, pageW, pageH];
  return {
    geometry: { mediaBox: box, boxes: {}, view: box, rotate: 0, viewWidth: pageW, viewHeight: pageH },
    matrix: multiply(ORIENTATION[info.orientation] ?? ORIENTATION[1], [rect[2], 0, 0, rect[3], rect[0], rect[1]]),
    clip: layout.size !== 'image' && layout.fit === 'cover',
    effectiveDpi: Math.min(pxW / (rect[2] / 72), pxH / (rect[3] / 72)),
  };
}

// ---------------------------------------------------------------- JPEG

interface JpegInfo {
  width: number;
  height: number;
  components: number;
  progressive: boolean;
  adobe: boolean;
  icc: Uint8Array | null;
  orientation: number;
  dpi: [number, number] | null;
  /** Byte ranges of segments kept in the embedded stream (SOI is implicit). */
  keep: Array<[number, number]>;
  /** Offset of the SOS marker: from here to the end the file is copied as is. */
  scanStart: number;
}

const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));

function parseJpeg(b: Uint8Array): JpegInfo {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('il file non è un JPEG valido');
  let width = 0;
  let height = 0;
  let components = 0;
  let progressive = false;
  let adobe = false;
  let orientation = 1;
  let jfifDpi: [number, number] | null = null;
  let exifDpi: [number, number] | null = null;
  const iccParts: Array<[number, Uint8Array]> = [];
  const keep: Array<[number, number]> = [];
  let p = 2;
  for (;;) {
    if (p + 4 > b.length) throw new Error('JPEG troncato: dati immagine mancanti');
    if (b[p] !== 0xff) throw new Error('JPEG danneggiato');
    const m = b[p + 1];
    if (m === 0xff) {
      p++;
      continue;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      p += 2;
      continue;
    }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) throw new Error('JPEG danneggiato: segmento troncato');
    const seg = b.subarray(p + 4, p + 2 + len);
    if (m === 0xda) {
      if (!components) throw new Error('JPEG danneggiato: intestazione SOF mancante');
      // JFIF and EXIF may disagree (e.g. a default 72 dpi in one of them): keep the higher, the print resolution.
      const dpi = jfifDpi && exifDpi ? (Math.min(...exifDpi) > Math.min(...jfifDpi) ? exifDpi : jfifDpi) : (jfifDpi ?? exifDpi);
      return { width, height, components, progressive, adobe, icc: joinIcc(iccParts), orientation, dpi, keep, scanStart: p };
    }
    let kept = true;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (m !== 0xc0 && m !== 0xc1 && m !== 0xc2) {
        throw new Error('JPEG di tipo non supportato dal PDF (lossless, gerarchico o aritmetico): risalvalo come JPEG standard o progressivo');
      }
      if (seg[0] !== 8) throw new Error(`JPEG a ${seg[0]} bit non supportato dal PDF: risalvalo a 8 bit`);
      height = (seg[1] << 8) | seg[2];
      width = (seg[3] << 8) | seg[4];
      components = seg[5];
      progressive = m === 0xc2;
      if (!width || !height) throw new Error('JPEG con dimensioni non dichiarate (DNL) non supportato');
      if (components !== 1 && components !== 3 && components !== 4) throw new Error(`JPEG con ${components} canali non supportato`);
    } else if (m === 0xe0 && ascii(seg, 0, 5) === 'JFIF\0' && seg.length >= 12) {
      const units = seg[7];
      const x = (seg[8] << 8) | seg[9];
      const y = (seg[10] << 8) | seg[11];
      if ((units === 1 || units === 2) && x && y) jfifDpi = units === 1 ? [x, y] : [x * 2.54, y * 2.54];
    } else if (m === 0xe1 && ascii(seg, 0, 6) === 'Exif\0\0') {
      const exif = readExif(seg.subarray(6));
      orientation = exif.orientation;
      exifDpi = exif.dpi;
      kept = false;
    } else if (m === 0xe2 && ascii(seg, 0, 12) === 'ICC_PROFILE\0' && seg.length > 14) {
      iccParts.push([seg[12], seg.subarray(14)]);
      kept = false;
    } else if (m === 0xee && ascii(seg, 0, 5) === 'Adobe') {
      adobe = true;
    } else if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) {
      kept = false; // XMP, Photoshop, other APPn and comments: metadata only
    }
    if (kept) keep.push([p, p + 2 + len]);
    p += 2 + len;
  }
}

function joinIcc(parts: Array<[number, Uint8Array]>): Uint8Array | null {
  if (!parts.length) return null;
  parts.sort((a, b) => a[0] - b[0]);
  const out = new Uint8Array(parts.reduce((n, [, d]) => n + d.length, 0));
  let at = 0;
  for (const [, d] of parts) {
    out.set(d, at);
    at += d.length;
  }
  return out;
}

/** Orientation and resolution from the first IFD of an EXIF block; malformed data is ignored. */
function readExif(t: Uint8Array): { orientation: number; dpi: [number, number] | null } {
  const result = { orientation: 1, dpi: null as [number, number] | null };
  try {
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const le = t[0] === 0x49;
    if (!le && t[0] !== 0x4d) return result;
    const u16 = (o: number) => dv.getUint16(o, le);
    const u32 = (o: number) => dv.getUint32(o, le);
    const ifd = u32(4);
    const n = u16(ifd);
    let xres = 0;
    let yres = 0;
    let unit = 2;
    const rational = (o: number) => {
      const den = u32(u32(o) + 4);
      return den ? u32(u32(o)) / den : 0;
    };
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      if (tag === 0x0112) result.orientation = u16(e + 8);
      else if (tag === 0x011a) xres = rational(e + 8);
      else if (tag === 0x011b) yres = rational(e + 8);
      else if (tag === 0x0128) unit = u16(e + 8);
    }
    if (result.orientation < 1 || result.orientation > 8) result.orientation = 1;
    if (xres && yres && (unit === 2 || unit === 3)) result.dpi = unit === 2 ? [xres, yres] : [xres * 2.54, yres * 2.54];
  } catch {
    // Truncated EXIF: keep defaults.
  }
  return result;
}

async function embedJpeg(doc: PDFDocument, bytes: Uint8Array, warn: (msg: string) => void): Promise<PDFRef> {
  const j = parseJpeg(bytes);
  // SOI + kept segments (JFIF, Adobe, tables, SOF…) + scan data copied unchanged.
  const size = 2 + j.keep.reduce((n, [a, z]) => n + z - a, 0) + bytes.length - j.scanStart;
  const data = new Uint8Array(size);
  data[0] = 0xff;
  data[1] = 0xd8;
  let at = 2;
  for (const [a, z] of j.keep) {
    data.set(bytes.subarray(a, z), at);
    at += z - a;
  }
  data.set(bytes.subarray(j.scanStart), at);

  const iccSpace = j.icc ? ascii(j.icc, 16, 4) : '';
  let colorSpace: unknown;
  if (j.components === 3) {
    colorSpace = j.icc && iccSpace === 'RGB ' ? iccBased(doc, j.icc, 3, 'DeviceRGB', false) : 'DeviceRGB';
  } else {
    colorSpace = j.components === 4 ? 'DeviceCMYK' : 'DeviceGray';
    if (j.icc) warn(`profilo colore ${j.components === 4 ? 'CMYK' : 'grigio'} ignorato, valori di stampa conservati così come sono`);
  }
  const dict: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: j.width,
    Height: j.height,
    BitsPerComponent: 8,
    ColorSpace: colorSpace,
    Filter: 'DCTDecode',
  };
  // Adobe (Photoshop) CMYK JPEGs store inverted values; PDF expects them complemented back.
  if (j.components === 4 && j.adobe) dict.Decode = [1, 0, 1, 0, 1, 0, 1, 0];
  return doc.context.register(doc.context.stream(data, dict as never));
}

function iccBased(doc: PDFDocument, profile: Uint8Array, n: number, alternate: string, deflated: boolean) {
  const dict = { N: n, Alternate: alternate };
  const stream = deflated ? doc.context.stream(profile, { ...dict, Filter: 'FlateDecode' }) : doc.context.flateStream(profile, dict);
  return doc.context.obj(['ICCBased', doc.context.register(stream)]);
}

// ---------------------------------------------------------------- PNG

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: boolean;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
  /** Compressed (zlib) ICC profile from iCCP. */
  iccp: Uint8Array | null;
  idat: Uint8Array[];
  dpi: [number, number] | null;
  /** EXIF orientation from an eXIf chunk (1 when absent). */
  orientation: number;
  /** gAMA/cHRM without iCCP/sRGB: colour hints the PDF cannot carry as such. */
  calibrated: boolean;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function parsePng(b: Uint8Array): PngInfo {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) throw new Error('il file non è un PNG valido');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const info: PngInfo = { width: 0, height: 0, bitDepth: 0, colorType: 0, interlace: false, palette: null, trns: null, iccp: null, idat: [], dpi: null, orientation: 1, calibrated: false };
  let srgb = false;
  let p = 8;
  let ended = false;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = ascii(b, p + 4, 4);
    if (p + 12 + len > b.length) throw new Error('PNG troncato');
    const data = b.subarray(p + 8, p + 8 + len);
    if (crc32(b.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) throw new Error(`PNG danneggiato (blocco ${type})`);
    if (type === 'IHDR') {
      info.width = dv.getUint32(p + 8);
      info.height = dv.getUint32(p + 12);
      info.bitDepth = data[8];
      info.colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) throw new Error('PNG con compressione non standard');
      info.interlace = data[12] === 1;
    } else if (type === 'PLTE') info.palette = data;
    else if (type === 'tRNS') info.trns = data;
    else if (type === 'iCCP') {
      const nul = data.indexOf(0);
      if (nul > 0 && data[nul + 1] === 0) info.iccp = data.subarray(nul + 2);
    } else if (type === 'pHYs' && len >= 9 && data[8] === 1) {
      const x = dv.getUint32(p + 8) * 0.0254;
      const y = dv.getUint32(p + 12) * 0.0254;
      if (x && y) info.dpi = [x, y];
    } else if (type === 'eXIf') info.orientation = readExif(data).orientation;
    else if (type === 'sRGB') srgb = true;
    else if (type === 'gAMA' || type === 'cHRM') info.calibrated = true;
    else if (type === 'IDAT') info.idat.push(data);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    p += 12 + len;
  }
  if (!ended && !info.idat.length) throw new Error('PNG troncato');
  if (!info.width || !info.height) throw new Error('PNG senza dimensioni');
  if (!DEPTHS[info.colorType]?.includes(info.bitDepth)) throw new Error('PNG con combinazione colore/profondità non valida');
  if (info.colorType === 3 && !info.palette) throw new Error('PNG a palette senza palette');
  if (!info.idat.length) throw new Error('PNG senza dati immagine');
  info.calibrated &&= !srgb && !info.iccp;
  return info;
}

async function embedPng(doc: PDFDocument, bytes: Uint8Array, warn: (msg: string) => void): Promise<PDFRef> {
  const png = parsePng(bytes);
  const { width: w, height: h, bitDepth: bd, colorType: ct } = png;
  const colorChannels = ct === 2 || ct === 6 ? 3 : 1;
  const hasAlpha = ct === 4 || ct === 6;
  if (png.calibrated) warn('gamma/cromaticità del PNG (blocchi gAMA/cHRM senza profilo) non conservate: pixel invariati, interpretati come RGB del dispositivo');

  // Colour space: RGB profile → ICCBased, grey profile ignored (device values kept).
  let rgbSpace: unknown = 'DeviceRGB';
  if (png.iccp) {
    const header = await inflate(png.iccp, 20);
    const space = ascii(header, 16, 4);
    if (colorChannels === 3 || ct === 3) {
      if (space === 'RGB ') rgbSpace = iccBased(doc, png.iccp, 3, 'DeviceRGB', true);
    } else warn('profilo colore grigio ignorato, valori conservati così come sono');
  }
  let colorSpace: unknown;
  if (ct === 3) {
    const pal = png.palette!;
    const entries = Math.min(pal.length / 3, 1 << bd);
    const hex = Array.from(pal.subarray(0, entries * 3), (v) => v.toString(16).padStart(2, '0')).join('');
    colorSpace = doc.context.obj(['Indexed', rgbSpace as never, entries - 1, PDFHexString.of(hex)]);
  } else colorSpace = colorChannels === 3 ? rgbSpace : 'DeviceGray';

  const base = { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: bd };
  const params = (colors: number, bits: number) => ({ Predictor: 15, Colors: colors, BitsPerComponent: bits, Columns: w });

  // Palette transparency needs an SMask built from the indices.
  const trnsAlpha = ct === 3 && png.trns && png.trns.some((a) => a !== 255) ? png.trns : null;

  if (!png.interlace && !hasAlpha) {
    // Pass-through: the zlib stream of the PNG is a valid FlateDecode stream with PNG predictors.
    const dict: Record<string, unknown> = { ...base, ColorSpace: colorSpace, Filter: 'FlateDecode', DecodeParms: params(colorChannels, bd) };
    if (png.trns && ct !== 3) dict.Mask = colorKey(png.trns, ct, bd);
    if (trnsAlpha) {
      const pixels = await decodePixels(png, 2 * w * h);
      dict.SMask = await alphaMask(doc, paletteAlpha(pixels, w, h, bd, trnsAlpha), w, h, 8);
    }
    return doc.context.register(doc.context.stream(concat(png.idat), dict as never));
  }

  const pixels = await decodePixels(png, trnsAlpha ? 2 * w * h : 0);
  const dict: Record<string, unknown> = { ...base, ColorSpace: colorSpace, Filter: 'FlateDecode', DecodeParms: params(colorChannels, bd) };
  let color = pixels;
  if (hasAlpha) {
    const split = splitAlpha(pixels, w * h, colorChannels, bd / 8);
    color = split.color;
    dict.SMask = await alphaMask(doc, split.alpha, w, h, bd);
  } else if (png.trns && ct !== 3) dict.Mask = colorKey(png.trns, ct, bd);
  else if (trnsAlpha) dict.SMask = await alphaMask(doc, paletteAlpha(pixels, w, h, bd, trnsAlpha), w, h, 8);
  const encoded = await deflate(predict(color, w, h, colorChannels, bd));
  return doc.context.register(doc.context.stream(encoded, dict as never));
}

/** tRNS for greyscale/RGB: a single transparent colour → colour key mask (exact). */
function colorKey(trns: Uint8Array, ct: number, bd: number): number[] {
  const max = (1 << bd) - 1;
  const v = (i: number) => ((trns[i] << 8) | trns[i + 1]) & max;
  return ct === 0 ? [v(0), v(0)] : [v(0), v(0), v(2), v(2), v(4), v(4)];
}

async function alphaMask(doc: PDFDocument, alpha: Uint8Array, w: number, h: number, bd: number): Promise<PDFRef> {
  const data = await deflate(predict(alpha, w, h, 1, bd));
  return doc.context.register(
    doc.context.stream(data, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      BitsPerComponent: bd,
      ColorSpace: 'DeviceGray',
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: bd, Columns: w },
    }),
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const rowBytes = (w: number, channels: number, bd: number) => Math.ceil((w * channels * bd) / 8);

const ADAM7: Array<[number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** Inflates and unfilters the image at its native depth: rows of packed samples, no filter bytes. */
async function decodePixels(png: PngInfo, extraBytes: number): Promise<Uint8Array> {
  const { width: w, height: h, bitDepth: bd } = png;
  const ch = CHANNELS[png.colorType];
  const rb = rowBytes(w, ch, bd);
  const bpp = Math.max(1, (ch * bd) >> 3);
  const expected = png.interlace
    ? ADAM7.reduce((n, [x0, y0, dx, dy]) => {
        const pw = Math.ceil((w - x0) / dx);
        const ph = Math.ceil((h - y0) / dy);
        return pw > 0 && ph > 0 ? n + (rowBytes(pw, ch, bd) + 1) * ph : n;
      }, 0)
    : (rb + 1) * h;
  // Peak memory: inflated data + unfiltered pixels + the caller's buffers (alpha split, predictor output).
  if (expected + 3 * rb * h + extraBytes > MAX_DECODED_BYTES) {
    throw new Error(`immagine troppo grande da elaborare nel browser (${w}×${h} px): riducila o salvala senza trasparenza e senza interlacciamento`);
  }
  const raw = await inflate(concat(png.idat), expected);
  if (!png.interlace) {
    if (raw.length < (rb + 1) * h) throw new Error('PNG danneggiato: dati immagine incompleti');
    const out = new Uint8Array(rb * h);
    for (let y = 0; y < h; y++) {
      unfilterRow(raw, y * (rb + 1), y ? (y - 1) * (rb + 1) + 1 : -1, rb, bpp);
      out.set(raw.subarray(y * (rb + 1) + 1, y * (rb + 1) + 1 + rb), y * rb);
    }
    return out;
  }
  const out = new Uint8Array(rb * h);
  const bitsPP = ch * bd;
  let off = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((w - x0) / dx);
    const ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const prb = rowBytes(pw, ch, bd);
    if (raw.length < off + (prb + 1) * ph) throw new Error('PNG danneggiato: dati immagine incompleti');
    for (let py = 0; py < ph; py++) {
      const rowOff = off + py * (prb + 1);
      unfilterRow(raw, rowOff, py ? rowOff - prb : -1, prb, bpp);
      const src = rowOff + 1;
      const y = y0 + py * dy;
      for (let px = 0; px < pw; px++) {
        const x = x0 + px * dx;
        if (bitsPP >= 8) {
          const n = bitsPP >> 3;
          out.set(raw.subarray(src + px * n, src + px * n + n), y * rb + x * n);
        } else {
          const sb = px * bitsPP;
          const v = (raw[src + (sb >> 3)] >> (8 - bitsPP - (sb & 7))) & ((1 << bitsPP) - 1);
          const db = x * bitsPP;
          out[y * rb + (db >> 3)] |= v << (8 - bitsPP - (db & 7));
        }
      }
    }
    off += (prb + 1) * ph;
  }
  return out;
}

/** Reverses the PNG filter of the row at `off` (filter byte + rb bytes) in place; `prev` = start of the previous unfiltered row or -1. */
function unfilterRow(buf: Uint8Array, off: number, prev: number, rb: number, bpp: number): void {
  const f = buf[off];
  const s = off + 1;
  switch (f) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < rb; i++) buf[s + i] = (buf[s + i] + buf[s + i - bpp]) & 255;
      return;
    case 2:
      if (prev < 0) return;
      for (let i = 0; i < rb; i++) buf[s + i] = (buf[s + i] + buf[prev + i]) & 255;
      return;
    case 3:
      for (let i = 0; i < rb; i++) {
        const a = i >= bpp ? buf[s + i - bpp] : 0;
        const b = prev >= 0 ? buf[prev + i] : 0;
        buf[s + i] = (buf[s + i] + ((a + b) >> 1)) & 255;
      }
      return;
    case 4:
      for (let i = 0; i < rb; i++) {
        const a = i >= bpp ? buf[s + i - bpp] : 0;
        const b = prev >= 0 ? buf[prev + i] : 0;
        const c = i >= bpp && prev >= 0 ? buf[prev + i - bpp] : 0;
        buf[s + i] = (buf[s + i] + paeth(a, b, c)) & 255;
      }
      return;
    default:
      throw new Error('PNG danneggiato: filtro di riga sconosciuto');
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Separates interleaved colour and alpha samples (1 or 2 bytes each). */
function splitAlpha(px: Uint8Array, count: number, colorChannels: number, bps: number): { color: Uint8Array; alpha: Uint8Array } {
  const cb = colorChannels * bps;
  const color = new Uint8Array(count * cb);
  const alpha = new Uint8Array(count * bps);
  for (let i = 0, s = 0; i < count; i++) {
    for (let k = 0; k < cb; k++) color[i * cb + k] = px[s++];
    for (let k = 0; k < bps; k++) alpha[i * bps + k] = px[s++];
  }
  return { color, alpha };
}

/** 8-bit alpha from palette indices and the tRNS table (missing entries are opaque). */
function paletteAlpha(px: Uint8Array, w: number, h: number, bd: number, trns: Uint8Array): Uint8Array {
  const rb = rowBytes(w, 1, bd);
  const alpha = new Uint8Array(w * h);
  const mask = (1 << bd) - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bit = x * bd;
      const idx = (px[y * rb + (bit >> 3)] >> (8 - bd - (bit & 7))) & mask;
      alpha[y * w + x] = idx < trns.length ? trns[idx] : 255;
    }
  }
  return alpha;
}

/** Applies PNG filters (per row, minimum sum of absolute differences — the libpng heuristic) for Predictor 15. */
function predict(px: Uint8Array, w: number, h: number, channels: number, bd: number): Uint8Array {
  const rb = rowBytes(w, channels, bd);
  const bpp = Math.max(1, (channels * bd) >> 3);
  const out = new Uint8Array((rb + 1) * h);
  const trial = new Uint8Array(rb);
  for (let y = 0; y < h; y++) {
    const cur = y * rb;
    const prev = y ? (y - 1) * rb : -1;
    let best = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < rb; i++) {
        const a = i >= bpp ? px[cur + i - bpp] : 0;
        const b = prev >= 0 ? px[prev + i] : 0;
        const c = i >= bpp && prev >= 0 ? px[prev + i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (px[cur + i] - pred) & 255;
        trial[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= best) break;
      }
      if (sum < best) {
        best = sum;
        out[y * (rb + 1)] = f;
        out.set(trial, y * (rb + 1) + 1);
      }
    }
  }
  return out;
}

// Native zlib streams (browser and Node): no extra dependency.
async function inflate(data: Uint8Array, limit?: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  if (limit === undefined) return new Uint8Array(await new Response(stream).arrayBuffer());
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < limit) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  await reader.cancel();
  return concat(chunks);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
