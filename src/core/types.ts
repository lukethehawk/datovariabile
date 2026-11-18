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

// ---------------------------------------------------------------- data generators
// One value per record (absolute index), shared by every field that writes {@Nome}.
// Specification of the algorithms: docs/FORMATO_PROGETTO.md §8.

interface GeneratorBase {
  id: string;
  /** Name used in contents as {@Nome}: unique (case-insensitive), no braces, no leading/trailing spaces. */
  name: string;
  prefix: string;
  suffix: string;
}

/** Numerazione. Value index n = start + record × step (like {#}). */
export interface NumberingGenerator extends GeneratorBase {
  type: 'numbering';
  /**
   * number: n zero padded to `digits` (FT-000001);
   * letters: n-th letter group in bijective base (A…Z, AA…), n ≥ 1;
   * lettersNumber: group + number (A001…A999, B001…).
   */
  style: 'number' | 'letters' | 'lettersNumber';
  start: number;
  step: number;
  /** Minimum digits of the numeric part (zero padded); lettersNumber: also the width of the range. */
  digits: number;
  /** Letters used, in order (default A–Z). */
  alphabet: string;
  /** letters / lettersNumber: first letter group (e.g. "A"); start then counts from it. */
  groupStart: string;
  /** lettersNumber: range of the numeric part, e.g. 1…999. */
  numberMin: number;
  numberMax: number;
  /** When the groups of the starting length are used up: add a letter (Z→AA) or stop with an error. */
  overflow: 'grow' | 'error';
}

/** Codice univoco: i-th distinct code of an HMAC-SHA-256 stream keyed by `key` (no stored list). */
export interface UniqueGenerator extends GeneratorBase {
  type: 'unique';
  algorithm: 'hmac-sha256-ctr-v1';
  /** 256-bit secret, 64 hex characters, created with crypto.getRandomValues. */
  key: string;
  /** Characters of the random part, in order, all distinct (2–64). */
  alphabet: string;
  length: number;
}

/** Data/Ora. */
export interface DateTimeGenerator extends GeneratorBase {
  type: 'datetime';
  /** job: instant taken once when the PDF generation starts; fixed: `fixed` civil date-time. */
  mode: 'job' | 'fixed';
  /** IANA time zone used in job mode (default Europe/Rome). */
  timeZone: string;
  /** Civil date-time "YYYY-MM-DDTHH:mm", no time zone (fixed mode). */
  fixed: string;
  format: DateFormat;
}

export type DateFormat = 'dd/MM/yyyy' | 'dd-MM-yyyy' | 'dd/MM/yyyy HH:mm' | 'HH:mm' | 'yyyy-MM-dd' | 'yyyy-MM-dd HH:mm' | 'dd/MM/yy';

export type DataGenerator = NumberingGenerator | UniqueGenerator | DateTimeGenerator;
