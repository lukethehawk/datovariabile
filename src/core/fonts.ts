import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontAsset } from './types';

/** PDF base-14 fonts: never embedded, cost zero bytes in the output. */
export const STANDARD_FONTS: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica Bold': StandardFonts.HelveticaBold,
  'Helvetica Oblique': StandardFonts.HelveticaOblique,
  'Helvetica Bold Oblique': StandardFonts.HelveticaBoldOblique,
  Times: StandardFonts.TimesRoman,
  'Times Bold': StandardFonts.TimesRomanBold,
  'Times Italic': StandardFonts.TimesRomanItalic,
  'Times Bold Italic': StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  'Courier Bold': StandardFonts.CourierBold,
  'Courier Oblique': StandardFonts.CourierOblique,
  'Courier Bold Oblique': StandardFonts.CourierBoldOblique,
};

/** Embeds each font at most once per document. */
export class FontCache {
  private readonly cache = new Map<string, Promise<PDFFont>>();
  private fontkitRegistered = false;

  constructor(
    private readonly doc: PDFDocument,
    private readonly assets: FontAsset[],
  ) {}

  get(name: string): Promise<PDFFont> {
    let font = this.cache.get(name);
    if (!font) {
      font = this.embed(name);
      this.cache.set(name, font);
    }
    return font;
  }

  private embed(name: string): Promise<PDFFont> {
    const standard = STANDARD_FONTS[name];
    if (standard) return this.doc.embedFont(standard);
    const asset = this.assets.find((a) => a.name === name);
    if (!asset) throw new Error(`Font "${name}" non caricato`);
    if (!this.fontkitRegistered) {
      this.doc.registerFontkit(fontkit);
      this.fontkitRegistered = true;
    }
    // fontkit's subsetter corrupts CFF outlines ("OTTO" magic): embed those whole.
    const b = asset.bytes;
    const cff = b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f;
    return this.doc.embedFont(asset.bytes, { subset: !cff });
  }
}
