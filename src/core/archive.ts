/**
 * Project archive, format version 5 (the first stable format; earlier experimental versions are not
 * read): a standard ZIP (`Nome.dvp.zip`) holding the manifest `progetto.json`, the original background
 * files, the original data file, the imported table as CSV and the uploaded fonts. Zone contents use
 * the placeholder grammar of docs/SPECIFICA_FILTRI.md. Specification: docs/FORMATO_PROGETTO.md.
 *
 * Authority on reopening: the manifest plus `dati/dati-usati.csv` (the cells the app
 * imported, header row included) and the column names written in the manifest. The
 * original data file is kept unchanged and is re-read only when the user switches
 * sheet; it is never re-parsed on opening, so SheetJS updates or the delimiter
 * heuristics cannot change the values of a saved job.
 */
import { SYMBOLOGIES } from './barcode';
import { crc32Async } from './crc32';
import { MAX_PROJECT_CELLS, parseProjectCsv, readTable, toDataSet, writeProjectCsv, type RawTable } from './data';
import { STANDARD_FONTS } from './fonts';
import { generatorProblem, nameProblem } from './generators';
import type { DataGenerator, Field, FontAsset, RasterLayout, Slot, SourceFile, SourceKind } from './types';
import { isSafePath, isZip, openZip, writeZip, ZipError, type ZipArchive, type ZipInput } from './zip';

/** The only version written and read. */
export const FORMAT_VERSION = 5;
export const MANIFEST = 'progetto.json';
export const TABLE_PATH = 'dati/dati-usati.csv';
const README_PATH = 'LEGGIMI.txt';
const MAX_MANIFEST = 4 * 1024 * 1024;

/** The data file of a project and how it was read. */
export interface SavedData {
  /** Original file name and bytes, unchanged (re-read only to switch sheet). */
  name: string;
  original: Uint8Array;
  /** Imported cells (header row included) as used by the app: authoritative on reopening. */
  table: RawTable;
  header: boolean;
  /** Effective column names (blank → letter, duplicates → _2), not recomputed on reopening. */
  columns: string[];
}

/** Everything a project saves and restores. */
export interface ProjectData {
  sources: SourceFile[];
  slots: Slot[];
  fields: Field[];
  fonts: FontAsset[];
  manualCount: number;
  data: SavedData | null;
  /** Record range as typed in the output panel (1-based, empty = all). */
  range: { from: string; to: string };
  /** Data generators ({@Nome}). */
  generators: DataGenerator[];
}

export interface OpenedProject {
  project: ProjectData;
  warnings: string[];
}

export interface FileRef {
  /** Relative path inside the archive. */
  path: string;
  size: number;
  crc32: number;
}

export interface ProjectManifest {
  app: 'DatoVariabile';
  version: 5;
  /** ISO date of the save, informative. */
  savedAt: string;
  sources: Array<{ id: string; name: string; kind: SourceKind; file: FileRef }>;
  slots: Slot[];
  fields: Field[];
  fonts: Array<{ name: string; file: FileRef }>;
  manualCount: number;
  range: { from: string; to: string };
  data: null | {
    /** Original file name as loaded by the user. */
    name: string;
    original: FileRef;
    /** dati/dati-usati.csv: cells.length rows, the longest `width` cells. */
    table: FileRef & { rows: number; width: number };
    sheets: string[];
    sheet: string;
    header: boolean;
    headerGuess: boolean;
    /** Effective column names used by the {Colonna} placeholders. */
    columns: string[];
  };
  /** Data generators ({@Nome}). See docs/FORMATO_PROGETTO.md §8. */
  generators: DataGenerator[];
}

const README = `DatoVariabile - progetto salvato
================================

Questo archivio contiene tutto il lavoro: aprilo con "Apri progetto" in DatoVariabile.

progetto.json         impostazioni: pagine, zone, contatori, intervallo, riferimenti ai file
veline/               i file grafici originali (PDF, JPG e PNG), non modificati
dati/originale-...    il file dati originale (Excel, CSV o TXT), non modificato
dati/dati-usati.csv   i dati effettivamente usati: UTF-8, separatore ";", prima riga = intestazioni se attive
font/                 i font caricati

ATTENZIONE: l'archivio contiene i dati importati (nomi, indirizzi, codici...).
Condividilo solo con chi è autorizzato a vederli. Se usa codici univoci (gift card, ticket),
contiene anche la chiave da cui si ricavano tutti i codici: trattalo come un documento riservato.

Se apri dati-usati.csv con Excel, Excel può modificare alcuni valori (es. 001234 diventa 1234).
Non risalvarlo da Excel dentro l'archivio. Se modifichi il CSV e ricrei lo ZIP,
DatoVariabile userà i dati modificati e lo segnalerà all'apertura.
`;

// ---------------------------------------------------------------- save

/** Short ASCII file name, safe on Windows; the original name stays in the manifest. */
function safeName(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  const dot = ascii.lastIndexOf('.');
  const ext = dot > 0 ? ascii.slice(dot).slice(0, 12) : '';
  const base = (dot > 0 ? ascii.slice(0, dot) : ascii).slice(0, 60 - ext.length) || 'file';
  return base + ext;
}

const STORED = /\.(pdf|jpe?g|png|xlsx|xlsm|xlsb|ods|zip)$/i;

/** Builds the .dvp.zip of a project. `warnings` reports values that could not be stored exactly. */
export async function writeProjectArchive(p: ProjectData, when = new Date()): Promise<{ blob: Blob; warnings: string[] }> {
  const warnings: string[] = [];
  // Same checks as on opening: never write a project that would then be refused.
  try {
    checkGenerators(p.generators);
  } catch (e) {
    throw new Error(`Correggi il generatore prima di salvare: ${e instanceof Error ? e.message.replace(/^generatore /, '') : e}`);
  }
  const inputs: ZipInput[] = [];
  const add = async (path: string, data: Uint8Array): Promise<FileRef> => {
    const crc = await crc32Async(data);
    inputs.push({ path, data, deflate: !STORED.test(path), crc });
    return { path, size: data.length, crc32: crc };
  };
  const width = (n: number) => Math.max(2, String(n).length);
  const prefix = (i: number, n: number) => String(i + 1).padStart(width(n), '0');

  const sources: ProjectManifest['sources'] = [];
  for (const [i, s] of p.sources.entries()) {
    sources.push({ id: s.id, name: s.name, kind: s.kind, file: await add(`veline/${prefix(i, p.sources.length)}-${safeName(s.name)}`, s.bytes) });
  }
  const fonts: ProjectManifest['fonts'] = [];
  for (const [i, f] of p.fonts.entries()) {
    fonts.push({ name: f.name, file: await add(`font/${prefix(i, p.fonts.length)}-${safeName(f.name)}`, f.bytes) });
  }
  let data: ProjectManifest['data'] = null;
  if (p.data) {
    const d = p.data;
    const cellCount = d.table.cells.reduce((n, r) => n + r.length, 0);
    if (cellCount > MAX_PROJECT_CELLS) throw new Error(`Dati troppo grandi per il progetto (${cellCount} celle, massimo ${MAX_PROJECT_CELLS})`);
    // Lone surrogates cannot be written as UTF-8: TextEncoder would silently turn them into U+FFFD.
    const cells = d.table.cells.map((r) => r.map((c) => (c.isWellFormed() ? c : (warnings.push(`Valore con caratteri non validi corretto: ${c.toWellFormed()}`), c.toWellFormed()))));
    const csv = writeProjectCsv(cells);
    data = {
      name: d.name,
      original: await add(`dati/originale-${safeName(d.name)}`, d.original),
      table: { ...(await add(TABLE_PATH, csv)), rows: cells.length, width: cells.reduce((n, r) => Math.max(n, r.length), 0) },
      sheets: d.table.sheets,
      sheet: d.table.sheet,
      header: d.header,
      headerGuess: d.table.headerGuess,
      columns: d.columns,
    };
  }
  const manifest: ProjectManifest = {
    app: 'DatoVariabile',
    version: 5,
    savedAt: when.toISOString(),
    sources,
    slots: p.slots,
    fields: p.fields,
    fonts,
    manualCount: p.manualCount,
    range: p.range,
    data,
    generators: p.generators,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  if (json.length > MAX_MANIFEST) throw new Error('Progetto troppo grande: le impostazioni superano 4 MB');
  const head: ZipInput[] = [
    { path: MANIFEST, data: json, deflate: true },
    { path: README_PATH, data: new TextEncoder().encode(README.replaceAll('\n', '\r\n')), deflate: true },
  ];
  return { blob: await writeZip([...head, ...inputs], when), warnings };
}

// ---------------------------------------------------------------- open

/** Opens a project file (.dvp.zip, format version 5). */
export async function readProjectFile(bytes: Uint8Array): Promise<OpenedProject> {
  if (!isZip(bytes)) throw new Error('Il file non è un progetto DatoVariabile (.dvp.zip)');
  let zip: ZipArchive;
  try {
    zip = openZip(bytes);
  } catch (e) {
    throw new Error(`Archivio non valido: ${e instanceof Error ? e.message : e}`);
  }
  const manifestEntry = zip.entries.get(MANIFEST);
  if (!manifestEntry) {
    if (zip.entries.has('[Content_Types].xml') || zip.entries.has('mimetype')) {
      throw new Error('Questo è un file di foglio di calcolo, non un progetto: caricalo con il pulsante Dati');
    }
    throw new Error(`L'archivio non contiene ${MANIFEST}: non è un progetto DatoVariabile`);
  }
  if (manifestEntry.size > MAX_MANIFEST) throw new Error('Progetto non valido: progetto.json troppo grande');
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await zip.read(MANIFEST)));
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new Error('progetto.json non è un JSON valido');
    }
    const m = checkManifest(raw, zip);
    return await loadResources(m, zip);
  } catch (e) {
    if (e instanceof VersionError) throw e;
    throw new Error(`Progetto danneggiato o incompleto: ${e instanceof Error ? e.message : e}`);
  }
}

/** A readable archive of another format version: reported as such, never as "damaged". */
class VersionError extends Error {}

async function loadResources(m: ProjectManifest, zip: ZipArchive): Promise<OpenedProject> {
  const warnings: string[] = [];
  const read = async (ref: FileRef) => {
    const data = await zip.read(ref.path);
    if (data.length !== ref.size) throw new Error(`${ref.path}: dimensione diversa da quella registrata`);
    return data;
  };
  const sources = [];
  for (const s of m.sources) sources.push({ id: s.id, name: s.name, kind: s.kind, bytes: await read(s.file) });
  const fonts = [];
  for (const f of m.fonts) fonts.push({ name: f.name, bytes: await read(f.file) });

  let data: SavedData | null = null;
  if (m.data) {
    const d = m.data;
    const original = await read(d.original);
    const csvEntry = zip.entries.get(d.table.path)!;
    const csv = await zip.read(d.table.path);
    let cells: string[][];
    let columns = d.columns;
    if (csvEntry.crc === d.table.crc32 && csv.length === d.table.size) {
      try {
        cells = parseProjectCsv(csv);
      } catch (e) {
        throw new Error(`${d.table.path}: ${e instanceof Error ? e.message : e}`);
      }
      const width = cells.reduce((n, r) => Math.max(n, r.length), 0);
      if (cells.length !== d.table.rows || width !== d.table.width || columns.length !== width) {
        throw new Error(`${d.table.path}: righe o colonne diverse da quelle registrate`);
      }
    } else {
      // Edited outside the app (e.g. in a text editor or Excel, then zipped again): use it, say so.
      try {
        cells = parseProjectCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
      } catch {
        cells = readTable(TABLE_PATH, csv).cells;
      }
      columns = toDataSet({ sheets: d.sheets, sheet: d.sheet, cells, headerGuess: d.headerGuess }, d.header).columns;
      const records = d.header ? Math.max(0, cells.length - 1) : cells.length;
      warnings.push(`${TABLE_PATH} è stato modificato fuori da DatoVariabile: uso i dati modificati (${records} record)`);
    }
    data = { name: d.name, original, table: { sheets: d.sheets, sheet: d.sheet, cells, headerGuess: d.headerGuess }, header: d.header, columns };
  }
  return {
    project: { sources, slots: m.slots, fields: m.fields, fonts, manualCount: m.manualCount, data, range: m.range, generators: m.generators },
    warnings,
  };
}

// ---------------------------------------------------------------- validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Structural validation: every reference must resolve, inside the archive, exactly once. */
function checkManifest(raw: unknown, zip: ZipArchive): ProjectManifest {
  if (!isObj(raw) || raw.app !== 'DatoVariabile') throw new Error('progetto.json non appartiene a DatoVariabile');
  if (raw.version !== FORMAT_VERSION) {
    if (isNum(raw.version) && raw.version > FORMAT_VERSION) {
      throw new VersionError(`Progetto in un formato più recente (versione ${raw.version}): aggiorna DatoVariabile`);
    }
    if (isNum(raw.version)) throw new VersionError(`Progetto in un formato non supportato (versione ${raw.version})`);
    throw new Error(`versione del progetto non valida (${String(raw.version)})`);
  }
  const generators = checkGenerators(raw.generators);
  const used = new Set<string>();
  /** `editable`: the data CSV may have been changed by the user (checked later against its CRC). */
  const ref = (v: unknown, what: string, editable = false): FileRef => {
    if (!isObj(v) || !isStr(v.path) || !isNum(v.size) || !isNum(v.crc32)) throw new Error(`riferimento non valido per ${what}`);
    if (!isSafePath(v.path)) throw new Error(`percorso non valido: ${v.path}`);
    if (used.has(v.path)) throw new Error(`file usato due volte: ${v.path}`);
    used.add(v.path);
    const entry = zip.entries.get(v.path);
    if (!entry) throw new Error(`manca il file ${v.path}`);
    // The ZIP CRC was recomputed by whoever rebuilt the archive: compare it with the one recorded at save time.
    if (!editable && (entry.size !== v.size || entry.crc !== v.crc32)) throw new Error(`${v.path}: file diverso da quello salvato nel progetto`);
    return { path: v.path, size: v.size, crc32: v.crc32 };
  };
  const list = (v: unknown, what: string): unknown[] => {
    if (!Array.isArray(v)) throw new Error(`elenco ${what} mancante`);
    return v;
  };

  const sourceIds = new Set<string>();
  const sources = list(raw.sources, 'veline').map((s, i) => {
    if (!isObj(s) || !isStr(s.id) || !isStr(s.name) || !['pdf', 'jpeg', 'png'].includes(s.kind as string)) throw new Error(`file grafico ${i + 1} non valido`);
    if (sourceIds.has(s.id)) throw new Error(`file grafico duplicato: ${s.id}`);
    sourceIds.add(s.id);
    return { id: s.id, name: s.name, kind: s.kind as SourceKind, file: ref(s.file, s.name) };
  });
  const slotIds = new Set<string>();
  const slots = list(raw.slots, 'pagine').map((s, i) => {
    if (!isObj(s) || !isStr(s.id) || !isStr(s.sourceId) || !isNum(s.page) || s.page < 0 || !Number.isInteger(s.page) || typeof s.enabled !== 'boolean') {
      throw new Error(`pagina ${i + 1} non valida`);
    }
    if (!sourceIds.has(s.sourceId)) throw new Error(`la pagina ${i + 1} usa un file mancante`);
    if (slotIds.has(s.id)) throw new Error(`pagina duplicata: ${s.id}`);
    slotIds.add(s.id);
    if (s.raster !== undefined) checkRaster(s.raster, i);
    return s as unknown as Slot;
  });
  const fonts = list(raw.fonts, 'font').map((f, i) => {
    if (!isObj(f) || !isStr(f.name)) throw new Error(`font ${i + 1} non valido`);
    return { name: f.name, file: ref(f.file, f.name) };
  });
  const fields = list(raw.fields, 'zone') as Field[];
  checkFields(fields, slotIds, new Set(fonts.map((f) => f.name)));
  if (!isNum(raw.manualCount) || raw.manualCount < 0) throw new Error('numero di record non valido');
  if (!isObj(raw.range) || !isStr(raw.range.from) || !isStr(raw.range.to)) throw new Error('intervallo di record non valido');

  let data: ProjectManifest['data'] = null;
  if (raw.data !== null) {
    const d = raw.data;
    if (!isObj(d) || !isStr(d.name) || !isStrArray(d.sheets) || !isStr(d.sheet) || typeof d.header !== 'boolean' || typeof d.headerGuess !== 'boolean' || !isStrArray(d.columns)) {
      throw new Error('descrizione dei dati non valida');
    }
    const t = d.table;
    if (!isObj(t) || !isNum(t.rows) || !isNum(t.width)) throw new Error('descrizione della tabella dati non valida');
    data = {
      name: d.name,
      original: ref(d.original, 'file dati originale'),
      table: { ...ref(t, 'tabella dati', true), rows: t.rows, width: t.width },
      sheets: d.sheets,
      sheet: d.sheet,
      header: d.header,
      headerGuess: d.headerGuess,
      columns: d.columns,
    };
  }
  return {
    app: 'DatoVariabile',
    version: 5,
    savedAt: isStr(raw.savedAt) ? raw.savedAt : '',
    sources,
    slots,
    fields,
    fonts,
    manualCount: raw.manualCount,
    range: { from: raw.range.from, to: raw.range.to },
    data,
    generators,
  };
}

function checkRaster(r: unknown, i: number): asserts r is RasterLayout {
  const ok =
    isObj(r) &&
    ['image', 'A3', 'A4', 'A5', 'custom'].includes(r.size as string) &&
    isNum(r.width) &&
    isNum(r.height) &&
    ['auto', 'portrait', 'landscape'].includes(r.orientation as string) &&
    ['contain', 'cover', 'stretch'].includes(r.fit as string) &&
    (r.dpi === null || (isNum(r.dpi) && r.dpi > 0));
  if (!ok) throw new Error(`impostazioni della pagina immagine ${i + 1} non valide`);
}

/** Generators of the manifest: well-formed, unique ids and names, able to produce values. */
function checkGenerators(v: unknown): DataGenerator[] {
  if (!Array.isArray(v)) throw new Error('elenco dei generatori mancante');
  const ids = new Set<string>();
  const names = new Set<string>();
  return v.map((g, i) => {
    if (!isObj(g) || !isStr(g.id) || !isStr(g.name) || !['numbering', 'unique', 'datetime'].includes(g.type as string)) throw new Error(`generatore ${i + 1} non valido`);
    const problem = nameProblem(g.name) ?? generatorProblem(g as unknown as DataGenerator);
    if (problem) throw new Error(`generatore "${g.name}": ${problem}`);
    if (ids.has(g.id) || names.has(g.name.toLowerCase())) throw new Error(`generatore duplicato: ${g.name}`);
    ids.add(g.id);
    names.add(g.name.toLowerCase());
    return g as unknown as DataGenerator;
  });
}

/**
 * Every field must be complete and drawable: checked before the current job is replaced,
 * so a damaged project fails on opening instead of breaking preview or generation later.
 */
function checkFields(fields: unknown[], slotIds: Set<string>, fontNames: Set<string>): asserts fields is Field[] {
  const ids = new Set<string>();
  const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
  fields.forEach((f, i) => {
    if (!isObj(f) || !isStr(f.id) || !isStr(f.name) || !isStr(f.slot) || !isStr(f.content)) throw new Error(`zona ${i + 1} non valida`);
    const bad = (what: string) => new Error(`zona "${f.name}": ${what} non valido`);
    if (!slotIds.has(f.slot)) throw new Error(`zona "${f.name}": pagina mancante`);
    if (ids.has(f.id)) throw new Error(`zona duplicata: ${f.id}`);
    ids.add(f.id);
    if (![f.x, f.y, f.w, f.h, f.margin].every(isNum) || (f.w as number) <= 0 || (f.h as number) <= 0) throw bad('posizione o margine');
    if (!oneOf(f.rotation, [0, 90, 180, 270])) throw bad('rotazione');
    const c = f.color;
    const colorOk =
      isObj(c) &&
      ((c.mode === 'cmyk' && [c.c, c.m, c.y, c.k].every(isNum)) || (c.mode === 'rgb' && isStr(c.hex) && /^#[0-9a-f]{6}$/i.test(c.hex)));
    if (!colorOk) throw bad('colore');
    const n = f.counter;
    if (!isObj(n) || ![n.start, n.step, n.digits].every(isNum)) throw bad('contatore');
    if (typeof f.whiteBackground !== 'boolean') throw bad('fondo bianco');
    if (f.type === 'text') {
      if (!isStr(f.font) || !(f.font in STANDARD_FONTS || fontNames.has(f.font))) throw new Error(`zona "${f.name}": font "${String(f.font)}" non disponibile`);
      if (!isNum(f.size) || f.size <= 0 || !isNum(f.lineHeight)) throw bad('corpo o interlinea');
      if (!oneOf(f.align, ['left', 'center', 'right']) || !oneOf(f.valign, ['top', 'middle', 'bottom'])) throw bad('allineamento');
      if (typeof f.wrap !== 'boolean' || typeof f.shrink !== 'boolean') throw bad('a capo/riduzione');
    } else if (f.type === 'barcode') {
      if (!isStr(f.symbology) || !(f.symbology in SYMBOLOGIES)) throw bad('tipo di codice');
      if (typeof f.showText !== 'boolean' || !oneOf(f.ecLevel, ['L', 'M', 'Q', 'H'])) throw bad('opzioni del codice');
    } else throw bad('tipo');
  });
}
