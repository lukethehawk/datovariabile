/** Geometry is stored in PDF points (1/72 inch) in "view space": the page as
 * displayed (after /Rotate), origin at the top-left corner, y growing down. */

export type ColorSpec =
  | { mode: 'cmyk'; c: number; m: number; y: number; k: number } // 0..100
  | { mode: 'rgb'; hex: string }; // #rrggbb

export type Rotation = 0 | 90 | 180 | 270;
export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

export interface Counter {
  start: number;
  step: number;
  /** Minimum digits, zero padded. 0 = no padding. */
  digits: number;
}

interface FieldBase {
  id: string;
  name: string;
  /** Index into the template pages (0-based). */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Counter-clockwise rotation of the content inside the box. */
  rotation: Rotation;
  color: ColorSpec;
  /** Text with placeholders: {Column name} and {#} for the counter. */
  content: string;
  counter: Counter;
  /** Paint the whole box white under the content ("bianco carta"). */
  whiteBackground: boolean;
  /** Inner margin between box border and content, in points. */
  margin: number;
}

export interface TextField extends FieldBase {
  type: 'text';
  /** Standard font name (see STANDARD_FONTS) or the name of an uploaded font. */
  font: string;
  size: number;
  align: HAlign;
  valign: VAlign;
  /** Line distance as a multiple of the font size. */
  lineHeight: number;
  wrap: boolean;
  /** Reduce the font size until the text fits the box. */
  shrink: boolean;
}

export interface BarcodeField extends FieldBase {
  type: 'barcode';
  /** bwip-js symbology id, see SYMBOLOGIES. */
  symbology: string;
  /** Human readable text under linear barcodes. */
  showText: boolean;
  /** QR Code error correction level. */
  ecLevel: 'L' | 'M' | 'Q' | 'H';
}

export type Field = TextField | BarcodeField;

export interface FontAsset {
  name: string;
  bytes: Uint8Array;
}

export interface DataSet {
  columns: string[];
  rows: string[][];
}

/** [left, bottom, right, top] in PDF user space. */
export type Box = [number, number, number, number];

export interface TemplatePage {
  mediaBox: Box;
  rotate: Rotation;
  boxes: Partial<Record<'CropBox' | 'BleedBox' | 'TrimBox' | 'ArtBox', Box>>;
  /** Visible area (CropBox ∩ MediaBox): what viewers display. */
  view: Box;
  /** Displayed size of `view` (width/height swapped for 90/270). */
  viewWidth: number;
  viewHeight: number;
}
