import type { PDFFont } from 'pdf-lib';
import type { TextField } from './types';

const MIN_SIZE = 2;

export interface TextLayout {
  size: number;
  /** Baseline positions in the inner box (origin bottom-left). */
  lines: Array<{ text: string; x: number; y: number }>;
  overflow: boolean;
}

type Style = Pick<TextField, 'size' | 'align' | 'valign' | 'lineHeight' | 'wrap' | 'shrink'>;

/** Lays out `text` inside a w×h box. Throws if the font cannot encode a character. */
export function layoutText(text: string, font: PDFFont, style: Style, w: number, h: number): TextLayout {
  const paragraphs = text.split(/\r\n|\n|\r/);
  const measure = (size: number) => {
    const lines = style.wrap ? paragraphs.flatMap((p) => wrap(p, font, size, w)) : paragraphs;
    const widths = lines.map((l) => font.widthOfTextAtSize(l, size));
    const ascent = font.heightAtSize(size, { descender: false });
    const descent = font.heightAtSize(size) - ascent;
    const height = ascent + descent + (lines.length - 1) * size * style.lineHeight;
    const fits = Math.max(0, ...widths) <= w + 1e-6 && height <= h + 1e-6;
    return { size, lines, widths, ascent, descent, height, fits };
  };

  let m = measure(style.size);
  if (style.shrink && !m.fits) {
    let lo = MIN_SIZE;
    let hi = style.size;
    let best = measure(lo);
    if (best.fits) {
      while (hi - lo > 0.05) {
        const mid = (lo + hi) / 2;
        const t = measure(mid);
        if (t.fits) {
          lo = mid;
          best = t;
        } else hi = mid;
      }
    }
    m = best;
  }

  const gap = m.size * style.lineHeight;
  const firstBaseline =
    style.valign === 'top'
      ? h - m.ascent
      : style.valign === 'bottom'
        ? m.descent + (m.lines.length - 1) * gap
        : (h + m.height) / 2 - m.ascent;
  return {
    size: m.size,
    overflow: !m.fits,
    lines: m.lines.map((text, i) => ({
      text,
      x: style.align === 'left' ? 0 : style.align === 'right' ? w - m.widths[i] : (w - m.widths[i]) / 2,
      y: firstBaseline - i * gap,
    })),
  };
}

function wrap(paragraph: string, font: PDFFont, size: number, width: number): string[] {
  const words = paragraph.split(' ');
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) > width && line !== '') {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  lines.push(line);
  return lines;
}
