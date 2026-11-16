import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { jobPage, inspectSource } from '../src/core/composition';
import { generate, type Job, type JobSource } from '../src/core/generate';
import { defaultLayout, inspectRaster, multiply, rasterPage, type RasterInfo } from '../src/core/raster';
import type { RasterLayout, Slot, SourceKind } from '../src/core/types';
import { makeTemplate, textField } from './helpers';
import { crc32, decodePredicted, encodePng, fakeIcc, flatJpeg, pngRowBytes, zlib, type PngOptions } from './images';

/** One-page job with a single image source. */
async function imageJob(bytes: Uint8Array, kind: SourceKind, overrides: Partial<Job> = {}, raster?: Partial<RasterLayout>): Promise<Job> {
  const info = await inspectSource(bytes, kind);
  const slot: Slot = { id: 's1', sourceId: 'img', page: 0, enabled: true };
  if (info.kind !== 'pdf') slot.raster = { ...defaultLayout(info.raster), ...raster };
  return { sources: [{ id: 'img', name: `img.${kind}`, kind, bytes }], pages: [jobPage(slot, info)], fields: [], fonts: [], data: null, from: 0, to: 0, ...overrides };
}

/** Image XObjects of the output (SMasks included), with their dictionary. */
async function images(bytes: Uint8Array): Promise<PDFRawStream[]> {
  const doc = await PDFDocument.load(bytes);
  return [...doc.context.enumerateIndirectObjects()].flatMap(([, o]) =>
    o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' ? [o] : [],
  );
}

const key = (s: PDFRawStream, name: string) => s.dict.get(PDFName.of(name));

/** Pixels of the first image painted on page 1, as decoded by pdf.js (8 bit, RGB or RGBA). */
async function pdfjsPixels(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray; channels: number }> {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const page = await (await task.promise).getPage(1);
  const ops = await page.getOperatorList();
  const i = ops.fnArray.findIndex((f) => f === OPS.paintImageXObject);
  const { promise, resolve } = Promise.withResolvers<{ width: number; height: number; data: Uint8ClampedArray }>();
  page.objs.get(ops.argsArray[i][0], resolve);
  const img = await promise;
  const result = { width: img.width, height: img.height, data: img.data, channels: img.data.length / (img.width * img.height) };
  await task.destroy();
  return result;
}

describe('JPEG', () => {
  const gray = (bx: number, by: number) => [10, 90, 170, 250][(bx + by * 2) % 4];

  it('embeds the original DCT data unchanged and drops only metadata', async () => {
    const jpg = flatJpeg({ width: 16, height: 16, components: 1, value: gray, exif: { orientation: 1, dpi: 300 }, jfifDpi: 300 });
    const res = await generate(await imageJob(jpg, 'jpeg'));
    const [img] = await images(res.bytes);
    expect(key(img, 'Filter')?.toString()).toBe('/DCTDecode');
    expect(key(img, 'ColorSpace')?.toString()).toBe('/DeviceGray');
    const sos = (b: Uint8Array) => b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
    // Entropy-coded data byte for byte identical; EXIF block gone.
    expect(img.contents.subarray(sos(img.contents))).toEqual(jpg.subarray(sos(jpg)));
    expect(new TextDecoder('latin1').decode(img.contents)).not.toContain('Exif');
    const px = await pdfjsPixels(res.bytes);
    expect(px.width).toBe(16);
    for (const [x, y] of [[0, 0], [8, 0], [0, 8], [15, 15]]) expect(px.data[(y * 16 + x) * px.channels]).toBe(gray(x >> 3, y >> 3));
  });

  it('keeps an RGB profile as ICCBased and the samples exact', async () => {
    const rgbv = (bx: number, by: number, c: number) => [[200, 30, 60], [20, 120, 220]][(bx + by) % 2][c];
    const jpg = flatJpeg({ width: 16, height: 8, components: 3, adobe: true, value: rgbv, icc: fakeIcc('RGB ') });
    const res = await generate(await imageJob(jpg, 'jpeg'));
    const [img] = await images(res.bytes);
    const cs = img.dict.lookup(PDFName.of('ColorSpace'), PDFArray);
    expect(cs.get(0).toString()).toBe('/ICCBased');
    const icc = cs.lookup(1, PDFRawStream);
    expect(icc.dict.get(PDFName.of('N'))?.toString()).toBe('3');
    const px = await pdfjsPixels(res.bytes);
    expect([...px.data.subarray(0, 3)]).toEqual([200, 30, 60]);
    expect([...px.data.subarray(8 * px.channels, 8 * px.channels + 3)]).toEqual([20, 120, 220]);
  });

  it('keeps CMYK values, ignores the CMYK profile with a warning and inverts Adobe data', async () => {
    // Photoshop stores CMYK inverted: 0 = full ink. Left block 100% K, right block no ink.
    const cmyk = (bx: number, _by: number, c: number) => (bx === 0 && c === 3 ? 0 : 255);
    const jpg = flatJpeg({ width: 16, height: 8, components: 4, adobe: true, value: cmyk, icc: fakeIcc('CMYK') });
    const res = await generate(await imageJob(jpg, 'jpeg'));
    const [img] = await images(res.bytes);
    expect(key(img, 'ColorSpace')?.toString()).toBe('/DeviceCMYK');
    expect(key(img, 'Decode')?.toString()).toBe('[ 1 0 1 0 1 0 1 0 ]');
    expect(res.warnings).toEqual([expect.stringContaining('profilo colore CMYK ignorato')]);
    const px = await pdfjsPixels(res.bytes);
    expect(px.data[0]).toBeLessThan(80); // black
    expect(px.data[8 * px.channels]).toBeGreaterThan(230); // white
  });

  it('refuses JPEG variants the PDF cannot carry', async () => {
    const jpg = flatJpeg({ width: 8, height: 8, components: 1, value: () => 128 });
    const sof = jpg.findIndex((v, i) => v === 0xff && jpg[i + 1] === 0xc0);
    const twelve = jpg.slice();
    twelve[sof + 4] = 12;
    expect(() => inspectRaster(twelve, 'jpeg')).toThrow('JPEG a 12 bit');
    const lossless = jpg.slice();
    lossless[sof + 1] = 0xc3;
    expect(() => inspectRaster(lossless, 'jpeg')).toThrow('non supportato dal PDF');
  });

  it('keeps the higher of the JFIF and EXIF resolutions', () => {
    const jpg = flatJpeg({ width: 16, height: 8, components: 1, value: () => 0, jfifDpi: 72, exif: { dpi: 300 } });
    const info = inspectRaster(jpg, 'jpeg');
    expect(info.dpi).toEqual([300, 300]);
    expect(defaultLayout(info).size).toBe('image');
  });

  it('reads EXIF orientation and resolution for the page size', () => {
    const jpg = flatJpeg({ width: 16, height: 8, components: 1, value: () => 0, exif: { orientation: 6, dpi: 300 } });
    const info = inspectRaster(jpg, 'jpeg');
    expect(info).toMatchObject({ width: 16, height: 8, orientation: 6, dpi: [300, 300] });
    const layout = defaultLayout(info);
    expect(layout.size).toBe('image');
    const placed = rasterPage(info, layout);
    // Rotated 90° clockwise for display: portrait page 8×16 px at 300 dpi.
    expect(placed.geometry.viewWidth).toBeCloseTo((8 / 300) * 72);
    expect(placed.geometry.viewHeight).toBeCloseTo((16 / 300) * 72);
    // Stored top-left corner (0,1 in image space) is shown at the top-right of the page.
    const [a, b, c, d, e, f] = placed.matrix;
    expect([a * 0 + c * 1 + e, b * 0 + d * 1 + f].map((v) => Math.round(v * 1000) / 1000)).toEqual([
      Math.round(placed.geometry.viewWidth * 1000) / 1000,
      Math.round(placed.geometry.viewHeight * 1000) / 1000,
    ]);
  });
});

describe('PNG', () => {
  /** Deterministic packed samples; padding bits at the end of each row are zero (they are not samples). */
  const samples = (o: Omit<PngOptions, 'pixels'>) => {
    const rb = pngRowBytes(o.width, o.colorType, o.bitDepth);
    const px = Uint8Array.from({ length: rb * o.height }, (_, i) => (i * 97 + (i >> 3) * 31) & 255);
    const pad = rb * 8 - o.width * o.bitDepth * (o.colorType === 2 ? 3 : o.colorType === 6 ? 4 : o.colorType === 4 ? 2 : 1);
    if (pad) for (let y = 0; y < o.height; y++) px[y * rb + rb - 1] &= (0xff << pad) & 0xff;
    return px;
  };
  const png = async (o: Omit<PngOptions, 'pixels'>) => {
    const pixels = samples(o);
    return { pixels, bytes: await encodePng({ ...o, pixels }) };
  };

  it.each([
    [0, 1],
    [0, 2],
    [0, 4],
    [0, 8],
    [0, 16],
    [2, 8],
    [2, 16],
    [3, 1],
    [3, 4],
    [3, 8],
  ] as const)('passes the zlib data through for colour type %i at %i bit', async (colorType, bitDepth) => {
    const palette = colorType === 3 ? Uint8Array.from({ length: (1 << bitDepth) * 3 }, (_, i) => (i * 37) & 255) : undefined;
    const o = { width: 37, height: 23, colorType, bitDepth, palette, split: true };
    const { pixels, bytes } = await png(o);
    const res = await generate(await imageJob(bytes, 'png'));
    const [img] = await images(res.bytes);
    expect(key(img, 'BitsPerComponent')?.toString()).toBe(String(bitDepth));
    expect(key(img, 'SMask')).toBeUndefined();
    const ch = colorType === 2 ? 3 : 1;
    expect(await decodePredicted(img.contents, 37, 23, ch, bitDepth)).toEqual(pixels);
    if (colorType === 3) expect((img.dict.lookup(PDFName.of('ColorSpace'), PDFArray)).get(0).toString()).toBe('/Indexed');
    const px = await pdfjsPixels(res.bytes);
    expect([px.width, px.height]).toEqual([37, 23]);
  });

  it.each([
    [6, 8, false],
    [6, 16, false],
    [4, 8, false],
    [4, 16, true],
    [2, 16, true],
    [3, 2, true],
    [0, 1, true],
  ] as const)('decodes colour type %i at %i bit (interlaced: %s) without losing samples', async (colorType, bitDepth, interlace) => {
    const palette = colorType === 3 ? Uint8Array.from({ length: 12 }, (_, i) => i * 20) : undefined;
    const o = { width: 21, height: 13, colorType, bitDepth, palette, interlace };
    const { pixels, bytes } = await png(o);
    const res = await generate(await imageJob(bytes, 'png'));
    const all = await images(res.bytes);
    const hasAlpha = colorType === 4 || colorType === 6;
    expect(all).toHaveLength(hasAlpha ? 2 : 1);
    const color = all.find((s) => key(s, 'SMask') !== undefined) ?? all[0];
    const colorCh = colorType === 2 || colorType === 6 ? 3 : 1;
    const bps = bitDepth / 8;
    const decoded = await decodePredicted(color.contents, 21, 13, colorCh, bitDepth);
    if (!hasAlpha) expect(decoded).toEqual(pixels);
    else {
      const smask = all.find((s) => s !== color)!;
      expect(key(smask, 'BitsPerComponent')?.toString()).toBe(String(bitDepth));
      const alpha = await decodePredicted(smask.contents, 21, 13, 1, bitDepth);
      const n = 21 * 13;
      const expColor = new Uint8Array(n * colorCh * bps);
      const expAlpha = new Uint8Array(n * bps);
      const step = (colorCh + 1) * bps;
      for (let i = 0; i < n; i++) {
        expColor.set(pixels.subarray(i * step, i * step + colorCh * bps), i * colorCh * bps);
        expAlpha.set(pixels.subarray(i * step + colorCh * bps, (i + 1) * step), i * bps);
      }
      expect(decoded).toEqual(expColor);
      expect(alpha).toEqual(expAlpha);
    }
    await pdfjsPixels(res.bytes);
  });

  it('turns transparency chunks into exact masks', async () => {
    // Palette with index 1 transparent and index 2 half transparent.
    const palette = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const pixels = Uint8Array.from({ length: 4 * 2 }, (_, i) => i % 4);
    const pal = await encodePng({ width: 4, height: 2, colorType: 3, bitDepth: 8, palette, trns: Uint8Array.from([255, 0, 128]), pixels });
    const res = await generate(await imageJob(pal, 'png'));
    const all = await images(res.bytes);
    expect(all).toHaveLength(2);
    const color = all.find((s) => key(s, 'SMask'))!;
    const smask = all.find((s) => s !== color)!;
    expect(await decodePredicted(color.contents, 4, 2, 1, 8)).toEqual(pixels);
    expect([...(await decodePredicted(smask.contents, 4, 2, 1, 8))]).toEqual([255, 0, 128, 255, 255, 0, 128, 255]);

    const rgb = await encodePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, trns: Uint8Array.from([0, 10, 0, 20, 0, 30]), pixels: Uint8Array.from([10, 20, 30, 1, 2, 3]) });
    const [img] = await images((await generate(await imageJob(rgb, 'png'))).bytes);
    expect(key(img, 'Mask')?.toString()).toBe('[ 10 10 20 20 30 30 ]');
  });

  it('keeps an RGB profile (deflated as in the file) and ignores a grey one', async () => {
    const icc = fakeIcc('RGB ');
    const rgbPng = await encodePng({ width: 2, height: 2, colorType: 2, bitDepth: 8, iccp: icc, pixels: new Uint8Array(12) });
    const res = await generate(await imageJob(rgbPng, 'png'));
    const [img] = await images(res.bytes);
    const profile = img.dict.lookup(PDFName.of('ColorSpace'), PDFArray).lookup(1, PDFRawStream);
    expect(key(profile, 'Filter')?.toString()).toBe('/FlateDecode');
    expect(await zlib(profile.contents, 'in')).toEqual(icc);
    expect(res.warnings).toEqual([]);

    const grayPng = await encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 8, iccp: fakeIcc('GRAY'), pixels: new Uint8Array(4) });
    const g = await generate(await imageJob(grayPng, 'png'));
    expect(key((await images(g.bytes))[0], 'ColorSpace')?.toString()).toBe('/DeviceGray');
    expect(g.warnings).toEqual([expect.stringContaining('profilo colore grigio ignorato')]);
  });

  it('reads the EXIF orientation of the eXIf chunk', async () => {
    const { bytes } = await png({ width: 16, height: 8, colorType: 0, bitDepth: 8, dpi: 300, exifOrientation: 6 });
    const info = inspectRaster(bytes, 'png');
    expect(info).toMatchObject({ width: 16, height: 8, orientation: 6 });
    expect(info.dpi![0]).toBeCloseTo(300, 2);
    // Rotated for display: the page takes the swapped pixel size.
    const layout = defaultLayout(info);
    expect(layout.size).toBe('image');
    const placed = rasterPage(info, layout);
    expect(placed.geometry.viewWidth).toBeCloseTo((8 / 300) * 72);
    expect(placed.geometry.viewHeight).toBeCloseTo((16 / 300) * 72);
  });

  it('warns about gAMA/cHRM hints unless sRGB or a profile overrides them', async () => {
    const pixels = new Uint8Array(4 * 2 * 3);
    const plain = await encodePng({ width: 4, height: 2, colorType: 2, bitDepth: 8, gamma: 0.45455, pixels });
    const res = await generate(await imageJob(plain, 'png'));
    expect(res.warnings).toEqual([expect.stringContaining('gamma/cromaticità')]);

    const tagged = await encodePng({ width: 4, height: 2, colorType: 2, bitDepth: 8, gamma: 0.45455, srgb: true, pixels });
    const ok = await generate(await imageJob(tagged, 'png'));
    expect(ok.warnings).toEqual([]);
  });

  it('refuses a huge declared size before allocating the pixels', async () => {
    // 1×1 RGBA file whose IHDR is rewritten to 12000×12000: the tiny IDAT is inconsistent on purpose.
    const bytes = await encodePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, pixels: new Uint8Array(4) });
    const declared = bytes.slice();
    const dv = new DataView(declared.buffer);
    dv.setUint32(16, 12000);
    dv.setUint32(20, 12000);
    dv.setUint32(29, crc32(declared.subarray(12, 29)));
    const started = performance.now();
    await expect(generate(await imageJob(declared, 'png'))).rejects.toThrow(/troppo grande/);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('refuses damaged files with a readable message', async () => {
    const { bytes } = await png({ width: 4, height: 4, colorType: 2, bitDepth: 8 });
    const bad = bytes.slice();
    bad[40] ^= 0xff;
    await expect(generate(await imageJob(bytes, 'png', { sources: [{ id: 'img', name: 'rotto.png', kind: 'png', bytes: bad }] }))).rejects.toThrow(
      /File "rotto.png": PNG danneggiato/,
    );
  });
});

describe('raster pages', () => {
  const info = (w: number, h: number, dpi: [number, number] | null = null): RasterInfo => ({ kind: 'png', width: w, height: h, orientation: 1, dpi, description: '' });
  const base: RasterLayout = { size: 'A4', width: 0, height: 0, orientation: 'auto', fit: 'contain', dpi: null };

  it('uses the file resolution only when reliable', () => {
    expect(defaultLayout(info(100, 100, [300, 300])).size).toBe('image');
    expect(defaultLayout(info(100, 100, [72, 72])).size).toBe('A4');
    expect(defaultLayout(info(100, 100)).size).toBe('A4');
  });

  it('fits without cropping or distortion unless asked', () => {
    // Landscape image 2:1 on A4: landscape page, full width, centred vertically.
    const contain = rasterPage(info(2000, 1000), base);
    expect(contain.geometry.viewWidth).toBeCloseTo(841.89);
    expect(contain.matrix).toEqual([841.89, 0, 0, 420.945, 0, (595.28 - 420.945) / 2]);
    expect(contain.clip).toBe(false);
    const cover = rasterPage(info(2000, 1000), { ...base, fit: 'cover' });
    expect(cover.matrix[3]).toBeCloseTo(595.28);
    expect(cover.clip).toBe(true);
    const stretch = rasterPage(info(2000, 1000), { ...base, orientation: 'portrait', fit: 'stretch' });
    expect(stretch.matrix).toEqual([595.28, 0, 0, 841.89, 0, 0]);
    expect(rasterPage(info(2480, 3508), base).effectiveDpi).toBeCloseTo(300, 0);
  });

  it('maps every EXIF orientation onto the unit square', () => {
    for (let o = 1; o <= 8; o++) {
      const m = rasterPage({ ...info(10, 10, [72, 72]), orientation: o }, { ...base, size: 'image' }).matrix;
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]].map((v) => Math.round(v)));
      expect(corners.map((c) => c.join(',')).sort()).toEqual(['0,0', '0,10', '10,0', '10,10']);
    }
    expect(multiply([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 10, 0]);
  });
});

describe('mixed composition', () => {
  it('combines PDF, JPEG and PNG pages, each embedded once, with fields on every page', async () => {
    const pdf = await makeTemplate({ kb: 80 });
    const jpg = flatJpeg({ width: 64, height: 64, components: 3, adobe: true, value: (x, y, c) => (x * 40 + y * 20 + c * 60) & 255, jfifDpi: 300 });
    const pngBytes = await encodePng({ width: 300, height: 200, colorType: 6, bitDepth: 8, pixels: Uint8Array.from({ length: 300 * 200 * 4 }, (_, i) => (i * 7) & 255) });
    const sources: JobSource[] = [
      { id: 'p', name: 'retro.pdf', kind: 'pdf', bytes: pdf },
      { id: 'j', name: 'fronte.jpg', kind: 'jpeg', bytes: jpg },
      { id: 'n', name: 'logo.png', kind: 'png', bytes: pngBytes },
    ];
    const infos = await Promise.all(sources.map((s) => inspectSource(s.bytes, s.kind)));
    const slots: Slot[] = [
      { id: 'a', sourceId: 'j', page: 0, enabled: true },
      { id: 'b', sourceId: 'p', page: 0, enabled: true },
      { id: 'c', sourceId: 'n', page: 0, enabled: true },
    ];
    const pages = slots.map((s, i) => {
      const inf = infos[[1, 0, 2][i]];
      if (inf.kind !== 'pdf') s.raster = defaultLayout(inf.raster);
      return jobPage(s, inf);
    });
    const fields = slots.map((s, i) => textField({ id: `t${i}`, slot: s.id, content: `${s.id}{#}`, x: 5, y: 5, w: 40, h: 10, size: 6, valign: 'top' }));
    const res = await generate({ sources, pages, fields, fonts: [], data: null, from: 0, to: 199 });

    expect(res.pageCount).toBe(600);
    const imgs = await images(res.bytes);
    expect(imgs).toHaveLength(3); // JPEG, PNG colour, PNG SMask: once for 400 image pages
    const doc = await PDFDocument.load(res.bytes);
    expect(doc.getPage(0).getWidth()).toBeCloseTo((64 / 300) * 72); // JPEG at its 300 dpi size
    expect(doc.getPage(2).getWidth()).toBeCloseTo(841.89); // PNG without dpi: A4 landscape
    expect(res.bytes.length).toBeLessThan(pdf.length + jpg.length + pngBytes.length * 1.1 + 600 * 400);
  });

  it('creates a PDF from images alone, without data or fields', async () => {
    const jpg = flatJpeg({ width: 32, height: 16, components: 1, value: () => 77 });
    const res = await generate(await imageJob(jpg, 'jpeg'));
    expect(res.pageCount).toBe(1);
    const doc = await PDFDocument.load(res.bytes);
    expect(doc.getPage(0).getSize().width).toBeCloseTo(841.89); // A4 landscape, image fitted
  });
});
