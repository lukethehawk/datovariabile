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
  /** Id of the composition slot (page of the record) the field belongs to. */
  slot: string;
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

/** PDF affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

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

export type SourceKind = 'pdf' | 'jpeg' | 'png';

/** A loaded background file: PDF (any number of pages) or a single raster image. */
export interface SourceFile {
  id: string;
  name: string;
  kind: SourceKind;
  bytes: Uint8Array;
}

/** How a raster image becomes a page. Never crops or distorts unless `fit` says so. */
export interface RasterLayout {
  /** 'image' = physical size from the image resolution (`dpi`). */
  size: 'image' | 'A3' | 'A4' | 'A5' | 'custom';
  /** Custom page size in points (used when size = 'custom'). */
  width: number;
  height: number;
  orientation: 'auto' | 'portrait' | 'landscape';
  /** contain = whole image, centred; cover = fills the page, edges cut; stretch = distorted to the page. */
  fit: 'contain' | 'cover' | 'stretch';
  /** Resolution for size = 'image'; null = the one written in the file. */
  dpi: number | null;
}

/** One page of every record: a page of a source, in composition order. */
export interface Slot {
  id: string;
  sourceId: string;
  /** Page index in the source (0 for images). */
  page: number;
  /** Disabled slots keep their fields but are not generated. */
  enabled: boolean;
  /** Page setup, raster sources only. */
  raster?: RasterLayout;
}
