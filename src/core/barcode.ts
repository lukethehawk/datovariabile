import { render, type DrawingContext, type RenderOptions } from 'bwip-js';
import {
  appendBezierCurve,
  closePath,
  concatTransformationMatrix,
  lineTo,
  moveTo,
  PDFOperator,
  PDFOperatorNames,
  setLineWidth,
  stroke,
  type PDFFont,
  type PDFOperator as Op,
} from 'pdf-lib';
import type { BarcodeField } from './types';

export const SYMBOLOGIES: Record<string, { label: string; twoD: boolean }> = {
  qrcode: { label: 'QR Code', twoD: true },
  datamatrix: { label: 'DataMatrix', twoD: true },
  azteccode: { label: 'Aztec', twoD: true },
  pdf417: { label: 'PDF417', twoD: true },
  code128: { label: 'Code 128', twoD: false },
  'gs1-128': { label: 'GS1-128', twoD: false },
  ean13: { label: 'EAN-13', twoD: false },
  ean8: { label: 'EAN-8', twoD: false },
  upca: { label: 'UPC-A', twoD: false },
  code39: { label: 'Code 39', twoD: false },
  interleaved2of5: { label: 'Interleaved 2 of 5', twoD: false },
  itf14: { label: 'ITF-14', twoD: false },
};

type BarcodeOptions = Pick<BarcodeField, 'symbology' | 'showText' | 'ecLevel'>;

interface Label {
  x: number;
  y: number;
  text: string;
  size: number;
}

/** A rendered symbol in bwip-js pixel space (origin top-left, y down). */
interface Vector {
  width: number;
  height: number;
  /** Path operators, already terminated by fill/stroke. */
  ops: Op[];
  /** Human readable text, drawn with a real font instead of glyph outlines. */
  labels: Label[];
}

export interface PlacedBarcode {
  /** Operators to run in the box space (origin bottom-left). */
  ops: Op[];
  /** Baselines in box space. */
  labels: Label[];
}

/** bwip-js sizes OCR-B by cell height; Helvetica digits match it at ~95%. */
const HRI_FONT_RATIO = 0.95;
const HELVETICA_CAP_HEIGHT = 0.718;
const ELLIPSE_MAGIC = 0.55228475 - 0.00045;

/** Linear barcode height model: rendered px = intercept + slope * height(mm). */
type Calibration = { slope: number; intercept: number };

/**
 * Renders barcodes as vector paths. One instance per generation job: it caches
 * the height calibration of linear symbologies.
 */
export class BarcodeRenderer {
  private readonly calibrations = new Map<string, Calibration>();

  /**
   * Fits the barcode in a w×h box. 2D symbols keep their proportions; linear ones
   * get a bar height matching the box so the text is not distorted.
   * `font` measures and draws the human readable text.
   */
  place(opts: BarcodeOptions, text: string, w: number, h: number, font: PDFFont): PlacedBarcode {
    const sym = SYMBOLOGIES[opts.symbology];
    if (!sym) throw new Error(`Tipo di codice sconosciuto: ${opts.symbology}`);
    let v: Vector;
    let sx: number;
    let sy: number;
    let ox = 0;
    let oy = 0;
    if (sym.twoD) {
      v = draw(opts, text, font);
      sx = sy = Math.min(w / v.width, h / v.height);
      ox = (w - v.width * sx) / 2;
      oy = (h - v.height * sy) / 2;
    } else {
      const cal = this.calibrate(opts, text, font);
      const probe = draw(opts, text, font, 10);
      const pxPerPt = probe.width / w;
      const heightMm = Math.max(1, (h * pxPerPt - cal.intercept) / cal.slope);
      v = draw(opts, text, font, heightMm);
      sx = w / v.width;
      sy = h / v.height;
    }
    const top = oy + v.height * sy;
    return {
      ops: [concatTransformationMatrix(sx, 0, 0, -sy, ox, top), ...v.ops],
      labels: v.labels.map((l) => ({ x: ox + l.x * sx, y: top - l.y * sy, text: l.text, size: l.size * Math.min(sx, sy) })),
    };
  }

  private calibrate(opts: BarcodeOptions, text: string, font: PDFFont): Calibration {
    const key = `${opts.symbology}|${opts.showText}`;
    let cal = this.calibrations.get(key);
    if (!cal) {
      const h10 = draw(opts, text, font, 10).height;
      const h30 = draw(opts, text, font, 30).height;
      const slope = (h30 - h10) / 20;
      cal = { slope, intercept: h10 - 10 * slope };
      this.calibrations.set(key, cal);
    }
    return cal;
  }
}

function draw(opts: BarcodeOptions, text: string, font: PDFFont, heightMm?: number): Vector {
  const sym = SYMBOLOGIES[opts.symbology];
  const params: RenderOptions = {
    bcid: opts.symbology,
    text,
    scale: 2,
    ...(heightMm !== undefined && { height: heightMm }),
    ...(!sym.twoD && opts.showText && { includetext: true, textxalign: 'center' }),
    ...(opts.symbology === 'qrcode' && { eclevel: opts.ecLevel }),
  };
  try {
    return render(params, pdfDrawing(font));
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^bwipp\.\w+#\d+:\s*/, '') : String(e);
    throw new Error(`valore "${text}" non valido per ${sym.label}: ${msg}`);
  }
}

/** bwip-js drawing context emitting PDF path operators (same geometry as its SVG output). */
function pdfDrawing(font: PDFFont): DrawingContext<Vector> {
  const ops: Op[] = [];
  const labels: Label[] = [];
  let pad = { l: 0, t: 0, r: 0, b: 0 };
  let scaleX = 1;
  let scaleY = 1;
  let width = 0;
  let height = 0;
  let lineWidth = -1;
  let strokePending = false;
  const flushStroke = () => {
    if (strokePending) ops.push(stroke());
    strokePending = false;
  };
  const point = (x: number, y: number): [number, number] => [x + pad.l, y + pad.t];

  return {
    setopts(o) {
      pad = { l: o.paddingleft ?? 0, t: o.paddingtop ?? 0, r: o.paddingright ?? 0, b: o.paddingbottom ?? 0 };
    },
    scale(sx, sy) {
      scaleX = sx;
      scaleY = sy;
      return null;
    },
    measure(str, _font, _fwidth, fheight) {
      const size = fheight * HRI_FONT_RATIO;
      return { width: font.widthOfTextAtSize(str, size), ascent: size * HELVETICA_CAP_HEIGHT, descent: 0 };
    },
    init(w, h) {
      width = w + pad.l + pad.r;
      height = h + pad.t + pad.b;
    },
    // Bars: orthogonal stroked lines, no caps. Mirrors bwip-js DrawingSVG.line().
    line(x0, y0, x1, y1, lw) {
      x0 |= 0;
      y0 |= 0;
      x1 |= 0;
      y1 |= 0;
      lw = Math.round(lw) || 1;
      if (lw & 1) {
        if (x0 === x1) {
          const d = scaleX & 1 ? -0.5 : 0.5;
          x0 += d;
          x1 += d;
        }
        if (y0 === y1) {
          const d = scaleY & 1 ? -0.5 : 0.5;
          y0 += d;
          y1 += d;
        }
      }
      if (x0 === x1) y0++;
      else if (y0 === y1) x0++;
      if (lw !== lineWidth) {
        flushStroke();
        ops.push(setLineWidth(lw));
        lineWidth = lw;
      }
      ops.push(moveTo(...point(x0, y0)), lineTo(...point(x1, y1)));
      strokePending = true;
    },
    polygon(pts) {
      flushStroke();
      ops.push(moveTo(...point(pts[0][0], pts[0][1])));
      for (const p of pts.slice(1)) ops.push(lineTo(...point(p[0], p[1])));
      ops.push(closePath());
    },
    hexagon(pts) {
      this.polygon(pts);
    },
    ellipse(x, y, rx, ry) {
      flushStroke();
      const dx = rx * ELLIPSE_MAGIC;
      const dy = ry * ELLIPSE_MAGIC;
      const c = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
        appendBezierCurve(...point(x1, y1), ...point(x2, y2), ...point(x3, y3));
      ops.push(
        moveTo(...point(x - rx, y)),
        c(x - rx, y - dy, x - dx, y - ry, x, y - ry),
        c(x + dx, y - ry, x + rx, y - dy, x + rx, y),
        c(x + rx, y + dy, x + dx, y + ry, x, y + ry),
        c(x - dx, y + ry, x - rx, y + dy, x - rx, y),
        closePath(),
      );
    },
    fill() {
      flushStroke();
      ops.push(PDFOperator.of(PDFOperatorNames.FillEvenOdd));
    },
    text(x, y, str, _rgb, f) {
      const size = f.height * HRI_FONT_RATIO;
      const [px, py] = point(x, y);
      if (!f.dx) {
        labels.push({ x: px, y: py, text: str, size });
        return;
      }
      let cx = px;
      for (const ch of str) {
        labels.push({ x: cx, y: py, text: ch, size });
        cx += font.widthOfTextAtSize(ch, size) + f.dx;
      }
    },
    end() {
      flushStroke();
      return { width, height, ops, labels };
    },
  };
}
