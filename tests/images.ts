// Web streams and plain arrays only: tests are type-checked without Node types.
export const zlib = async (data: Uint8Array, mode: 'in' | 'out') => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(mode === 'out' ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- JPEG

export interface FlatJpegOptions {
  width: number; // multiple of 8
  height: number; // multiple of 8
  components: 1 | 3 | 4;
  /** Value (0–255) of component `c` in the 8×8 block (bx, by). */
  value: (bx: number, by: number, c: number) => number;
  /** Adobe APP14 with transform 0: components stored as is (RGB / CMYK). */
  adobe?: boolean;
  exif?: { orientation?: number; dpi?: number };
  jfifDpi?: number;
  icc?: Uint8Array;
}

/**
 * Baseline JPEG made of flat 8×8 blocks with an all-ones quantisation table: only
 * DC coefficients, so decoding gives back the exact block values (pixel-exact tests).
 */
export function flatJpeg(o: FlatJpegOptions): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const seg = (marker: number, body: number[]) => out.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  const str = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const u16 = (v: number) => [v >> 8, v & 255];
  if (o.jfifDpi) seg(0xe0, [...str('JFIF\0'), 1, 2, 1, ...u16(o.jfifDpi), ...u16(o.jfifDpi), 0, 0]);
  if (o.exif) {
    // Big-endian TIFF, IFD0 with Orientation, XResolution, YResolution, ResolutionUnit.
    const entries: number[][] = [];
    const extra: number[] = [];
    const n = (o.exif.orientation ? 1 : 0) + (o.exif.dpi ? 3 : 0);
    const dataStart = 8 + 2 + n * 12 + 4;
    if (o.exif.orientation) entries.push([0x01, 0x12, 0, 3, 0, 0, 0, 1, ...u16(o.exif.orientation), 0, 0]);
    if (o.exif.dpi) {
      for (const tag of [0x1a, 0x1b]) {
        const off = dataStart + extra.length;
        entries.push([0x01, tag, 0, 5, 0, 0, 0, 1, 0, 0, ...u16(off)]);
        extra.push(0, 0, ...u16(o.exif.dpi), 0, 0, 0, 1);
      }
      entries.push([0x01, 0x28, 0, 3, 0, 0, 0, 1, 0, 2, 0, 0]);
    }
    seg(0xe1, [...str('Exif\0\0'), ...str('MM'), 0, 42, 0, 0, 0, 8, ...u16(n), ...entries.flat(), 0, 0, 0, 0, ...extra]);
  }
  if (o.icc) {
    // Two APP2 parts, to exercise reassembly.
    const half = Math.ceil(o.icc.length / 2);
    seg(0xe2, [...str('ICC_PROFILE\0'), 1, 2, ...o.icc.subarray(0, half)]);
    seg(0xe2, [...str('ICC_PROFILE\0'), 2, 2, ...o.icc.subarray(half)]);
  }
  if (o.adobe) seg(0xee, [...str('Adobe'), 0, 100, 0, 0, 0, 0, 0]);
  seg(0xdb, [0, ...new Array(64).fill(1)]);
  seg(0xc0, [8, ...u16(o.height), ...u16(o.width), o.components, ...Array.from({ length: o.components }, (_, i) => [i + 1, 0x11, 0]).flat()]);
  // DC: categories 0–11, all 4-bit codes. AC: only EOB, code "0".
  seg(0xc4, [0x00, 0, 0, 0, 12, ...new Array(12).fill(0), ...Array.from({ length: 12 }, (_, i) => i)]);
  seg(0xc4, [0x10, 1, ...new Array(15).fill(0), 0]);
  seg(0xda, [o.components, ...Array.from({ length: o.components }, (_, i) => [i + 1, 0]).flat(), 0, 63, 0]);

  let acc = 0;
  let nbits = 0;
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0);
        acc = 0;
        nbits = 0;
      }
    }
  };
  const prev = new Array(o.components).fill(0);
  for (let by = 0; by < o.height / 8; by++) {
    for (let bx = 0; bx < o.width / 8; bx++) {
      for (let c = 0; c < o.components; c++) {
        const dc = 8 * (o.value(bx, by, c) - 128);
        const diff = dc - prev[c];
        prev[c] = dc;
        const s = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
        put(s, 4);
        if (s) put(diff >= 0 ? diff : diff + (1 << s) - 1, s);
        put(0, 1); // EOB
      }
    }
  }
  if (nbits) put(0xff, 8 - nbits);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- PNG

export interface PngOptions {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  bitDepth: 1 | 2 | 4 | 8 | 16;
  /** Packed samples, rows of ceil(width·channels·depth/8) bytes, no filter bytes. */
  pixels: Uint8Array;
  palette?: Uint8Array;
  trns?: Uint8Array;
  interlace?: boolean;
  iccp?: Uint8Array;
  dpi?: number;
  /** Several IDAT chunks. */
  split?: boolean;
  /** EXIF orientation written in an eXIf chunk (bare TIFF, no "Exif\0\0" prefix). */
  exifOrientation?: number;
  /** gAMA chunk holding this decoded gamma (value × 100000). */
  gamma?: number;
  /** sRGB chunk with rendering intent 0. */
  srgb?: boolean;
}

const CH: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
export const pngRowBytes = (w: number, ct: number, bd: number) => Math.ceil((w * CH[ct] * bd) / 8);

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Filters rows cycling through all five PNG filters (exercises every unfilter path). */
function filterRows(px: Uint8Array, w: number, h: number, ct: number, bd: number): Uint8Array {
  const rb = pngRowBytes(w, ct, bd);
  const bpp = Math.max(1, (CH[ct] * bd) >> 3);
  const out = new Uint8Array((rb + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    out[y * (rb + 1)] = f;
    for (let i = 0; i < rb; i++) {
      const a = i >= bpp ? px[y * rb + i - bpp] : 0;
      const b = y ? px[(y - 1) * rb + i] : 0;
      const c = i >= bpp && y ? px[(y - 1) * rb + i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * (rb + 1) + 1 + i] = (px[y * rb + i] - pred) & 255;
    }
  }
  return out;
}

function sample(px: Uint8Array, rb: number, bitsPP: number, x: number, y: number): number[] {
  if (bitsPP >= 8) return [...px.subarray(y * rb + (x * bitsPP) / 8, y * rb + ((x + 1) * bitsPP) / 8)];
  const bit = x * bitsPP;
  return [(px[y * rb + (bit >> 3)] >> (8 - bitsPP - (bit & 7))) & ((1 << bitsPP) - 1)];
}

function packRow(values: number[][], bitsPP: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((values.length * bitsPP) / 8));
  values.forEach((v, x) => {
    if (bitsPP >= 8) out.set(v, (x * bitsPP) / 8);
    else out[(x * bitsPP) >> 3] |= v[0] << (8 - bitsPP - ((x * bitsPP) & 7));
  });
  return out;
}

export async function encodePng(o: PngOptions): Promise<Uint8Array> {
  const { width: w, height: h, colorType: ct, bitDepth: bd } = o;
  const bitsPP = CH[ct] * bd;
  let raw: Uint8Array;
  if (!o.interlace) raw = filterRows(o.pixels, w, h, ct, bd);
  else {
    const rb = pngRowBytes(w, ct, bd);
    const parts: Uint8Array[] = [];
    for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
      const pw = Math.ceil((w - x0) / dx);
      const ph = Math.ceil((h - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const rows: Uint8Array[] = [];
      for (let py = 0; py < ph; py++) {
        rows.push(packRow(Array.from({ length: pw }, (_, px) => sample(o.pixels, rb, bitsPP, x0 + px * dx, y0 + py * dy)), bitsPP));
      }
      const pass = new Uint8Array(rows.reduce((n, r) => n + r.length, 0));
      rows.forEach((r, i) => pass.set(r, i * r.length));
      parts.push(filterRows(pass, pw, ph, ct, bd));
    }
    raw = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      raw.set(p, at);
      at += p.length;
    }
  }
  const z = await zlib(raw, 'out');
  const chunks: Array<[string, Uint8Array]> = [];
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([bd, ct, 0, 0, o.interlace ? 1 : 0], 8);
  chunks.push(['IHDR', ihdr]);
  if (o.srgb) chunks.push(['sRGB', Uint8Array.from([0])]);
  if (o.gamma) {
    const gama = new Uint8Array(4);
    new DataView(gama.buffer).setUint32(0, Math.round(o.gamma * 100000));
    chunks.push(['gAMA', gama]);
  }
  if (o.exifOrientation) {
    // Big-endian TIFF, IFD0 at offset 8 with a single Orientation entry (SHORT, count 1).
    const tiff = new Uint8Array(8 + 2 + 12 + 4);
    const dv = new DataView(tiff.buffer);
    tiff.set(latin1('MM'));
    dv.setUint16(2, 42);
    dv.setUint32(4, 8);
    dv.setUint16(8, 1);
    dv.setUint16(10, 0x0112);
    dv.setUint16(12, 3);
    dv.setUint32(14, 1);
    dv.setUint16(18, o.exifOrientation);
    chunks.push(['eXIf', tiff]);
  }
  if (o.iccp) chunks.push(['iCCP', Uint8Array.from([...latin1('ICC\0\0'), ...(await zlib(o.iccp, 'out'))])]);
  if (o.dpi) {
    const phys = new Uint8Array(9);
    const ppm = Math.round(o.dpi / 0.0254);
    new DataView(phys.buffer).setUint32(0, ppm);
    new DataView(phys.buffer).setUint32(4, ppm);
    phys[8] = 1;
    chunks.push(['pHYs', phys]);
  }
  if (o.palette) chunks.push(['PLTE', o.palette]);
  if (o.trns) chunks.push(['tRNS', o.trns]);
  if (o.split) {
    const mid = z.length >> 1;
    chunks.push(['IDAT', z.subarray(0, mid)], ['IDAT', z.subarray(mid)]);
  } else chunks.push(['IDAT', z]);
  chunks.push(['IEND', new Uint8Array()]);
  const parts: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const u32 = (v: number) => Uint8Array.from([24, 16, 8, 0], (s) => (v >>> s) & 255);
  for (const [type, data] of chunks) {
    const body = new Uint8Array(4 + data.length);
    body.set(latin1(type));
    body.set(data, 4);
    parts.push(u32(data.length), body, u32(crc32(body)));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Decodes a FlateDecode + PNG-predictor image stream back to packed samples (independent of src/core). */
export async function decodePredicted(data: Uint8Array, w: number, h: number, channels: number, bd: number): Promise<Uint8Array> {
  const raw = await zlib(data, 'in');
  const rb = Math.ceil((w * channels * bd) / 8);
  const bpp = Math.max(1, (channels * bd) >> 3);
  const out = new Uint8Array(rb * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rb + 1)];
    for (let i = 0; i < rb; i++) {
      const a = i >= bpp ? out[y * rb + i - bpp] : 0;
      const b = y ? out[(y - 1) * rb + i] : 0;
      const c = i >= bpp && y ? out[(y - 1) * rb + i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * rb + i] = (raw[y * (rb + 1) + 1 + i] + pred) & 255;
    }
  }
  return out;
}

/** Minimal ICC header: only the fields read by the embedder (size, data colour space). */
export function fakeIcc(space: 'RGB ' | 'GRAY' | 'CMYK', size = 400): Uint8Array {
  const icc = new Uint8Array(size);
  new DataView(icc.buffer).setUint32(0, size);
  icc.set(latin1(space), 16);
  icc.set(latin1('XYZ '), 20);
  icc.set(latin1('acsp'), 36);
  return icc;
}
