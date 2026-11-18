/**
 * Project model shared by all formats, and readers of the legacy JSON files.
 * Version 1 (single template PDF + "pagesSpec") and version 2 (sources in base64,
 * no data) are read here; version 3 is the ZIP archive of `archive.ts`, the only
 * format written. Legacy files never contained the data file: `data` is null.
 */
import type { RawTable } from './data';
import { inspectTemplate } from './generate';
import { newId } from './composition';
import type { DataGenerator, Field, FontAsset, Slot, SourceFile, SourceKind } from './types';

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

export interface ProjectData {
  sources: SourceFile[];
  slots: Slot[];
  fields: Field[];
  fonts: FontAsset[];
  manualCount: number;
  data: SavedData | null;
  /** Record range as typed in the output panel (1-based, empty = all). */
  range: { from: string; to: string };
  /** Data generators ({@Nome}); legacy files have none. */
  generators: DataGenerator[];
}

export interface OpenedProject {
  project: ProjectData;
  warnings: string[];
  /** Legacy JSON (v1/v2): data was never saved in these files. */
  legacy: boolean;
}

interface ProjectFileV2 {
  app: 'DatoVariabile';
  version: 2;
  sources: Array<{ id: string; name: string; kind: SourceKind; data: string }>;
  slots: Slot[];
  fields: Field[];
  fonts: Array<{ name: string; data: string }>;
  manualCount: number;
}

interface ProjectFileV1 {
  app: 'DatoVariabile';
  version: 1;
  fields: Array<Omit<Field, 'slot'> & { page: number }>;
  fonts: Array<{ name: string; data: string }>;
  template: { name: string; data: string } | null;
  manualCount: number;
  pagesSpec: string;
}

const NO_RANGE = { from: '', to: '' };

/** Reads a legacy .dvp.json (version 1 or 2). */
export async function parseProject(json: string): Promise<OpenedProject> {
  let raw: { app?: unknown; version?: unknown };
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Il file non è un progetto DatoVariabile (JSON non valido)');
  }
  if (raw?.app !== 'DatoVariabile') throw new Error('Il file non è un progetto DatoVariabile');
  if (raw.version === 1) return { ...(await migrateV1(raw as ProjectFileV1)), legacy: true };
  if (raw.version === 3 || raw.version === 4) throw new Error('Questo è il manifest di un archivio .dvp.zip: apri l’archivio ZIP, non il file estratto');
  if (raw.version !== 2) throw new Error(`Progetto in un formato più recente (versione ${raw.version}): aggiorna DatoVariabile`);
  const p = raw as ProjectFileV2;
  const sources = p.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, bytes: fromBase64(s.data) }));
  const ids = new Set(sources.map((s) => s.id));
  const slots = p.slots.filter((s) => ids.has(s.sourceId));
  const slotIds = new Set(slots.map((s) => s.id));
  const warnings = slots.length < p.slots.length ? ['Alcune pagine facevano riferimento a file mancanti e sono state rimosse'] : [];
  return {
    project: {
      sources,
      slots,
      fields: p.fields.filter((f) => slotIds.has(f.slot)),
      fonts: p.fonts.map((f) => ({ name: f.name, bytes: fromBase64(f.data) })),
      manualCount: p.manualCount,
      data: null,
      range: NO_RANGE,
      generators: [],
    },
    warnings,
    legacy: true,
  };
}

/**
 * Version 1 → 2: the template becomes the only source and "pagesSpec" the slots.
 * v1 drew a field on every occurrence of its page, so a field gets a copy per
 * occurrence; pages left out of pagesSpec become disabled slots that keep their fields.
 */
async function migrateV1(p: ProjectFileV1): Promise<{ project: ProjectData; warnings: string[] }> {
  const warnings: string[] = [];
  const fonts = p.fonts.map((f) => ({ name: f.name, bytes: fromBase64(f.data) }));
  if (!p.template) {
    return { project: { sources: [], slots: [], fields: [], fonts, manualCount: p.manualCount, data: null, range: NO_RANGE, generators: [] }, warnings: p.fields.length ? ['Il progetto non contiene la velina: zone non recuperabili'] : [] };
  }
  const bytes = fromBase64(p.template.data);
  const pageCount = (await inspectTemplate(bytes)).length;
  const source: SourceFile = { id: newId('src'), name: p.template.name, kind: 'pdf', bytes };
  let order: number[];
  try {
    order = parsePages(p.pagesSpec ?? '', pageCount);
  } catch (e) {
    order = parsePages('', pageCount);
    warnings.push(`${e instanceof Error ? e.message : e}: uso tutte le pagine`);
  }
  const slots: Slot[] = order.map((page) => ({ id: newId('s'), sourceId: source.id, page, enabled: true }));
  const fields: Field[] = [];
  for (const old of p.fields) {
    const { page, ...rest } = old;
    if (page < 0 || page >= pageCount) {
      warnings.push(`Zona "${old.name}": la pagina ${page + 1} non esiste più nella velina, zona rimossa`);
      continue;
    }
    let targets = slots.filter((s) => s.page === page);
    if (!targets.length) {
      const disabled: Slot = { id: newId('s'), sourceId: source.id, page, enabled: false };
      slots.push(disabled);
      targets = [disabled];
    }
    // Deep copies: counter and colour objects must not be shared between the copies.
    targets.forEach((slot, i) => fields.push({ ...structuredClone(rest), id: i === 0 ? old.id : newId('f'), slot: slot.id } as Field));
  }
  return { project: { sources: [source], slots, fields, fonts, manualCount: p.manualCount, data: null, range: NO_RANGE, generators: [] }, warnings };
}

/** Parses "1,3-4" into 0-based page indices; empty means all pages (version 1 "pagesSpec"). */
export function parsePages(spec: string, pageCount: number): number[] {
  const all = Array.from({ length: pageCount }, (_, i) => i);
  if (spec.trim() === '') return all;
  const out: number[] = [];
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`Pagine velina: "${part}" non valido`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let q = Math.min(a, b); q <= Math.max(a, b); q++) {
      if (q < 1 || q > pageCount) throw new Error(`Pagine velina: la pagina ${q} non esiste`);
      out.push(q - 1);
    }
  }
  return out;
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
