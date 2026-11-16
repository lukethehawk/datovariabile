import type { PDFDocumentProxy } from 'pdfjs-dist';
import { jobPage, newId, type SourceInfo } from '../core/composition';
import { toDataSet, type RawTable } from '../core/data';
import type { JobPage, JobSource } from '../core/generate';
import type { BarcodeField, DataSet, Field, FontAsset, Slot, SourceFile, TextField } from '../core/types';

export const MM = 72 / 25.4;

/** A loaded background file. PDFs keep a pdf.js document for the editor background and thumbnails. */
export interface Source extends SourceFile {
  info: SourceInfo;
  /** Load counter: a reopened project may reuse source ids with different bytes, caches key on this. */
  rev: number;
  pdf: PDFDocumentProxy | null;
  close: () => Promise<void>;
}

export interface DataSource {
  name: string;
  bytes: Uint8Array;
  table: RawTable;
  header: boolean;
}

export const state = {
  sources: [] as Source[],
  /** Composition: pages repeated for every record, in order. */
  slots: [] as Slot[],
  source: null as DataSource | null,
  data: null as DataSet | null,
  fields: [] as Field[],
  fonts: [] as FontAsset[],
  selectedId: null as string | null,
  /** Slot shown in the editor. */
  slotId: null as string | null,
  /** Record shown in the preview (0-based). */
  record: 0,
  /** CSS pixels per PDF point; 0 = fit to the viewport. */
  zoom: 0,
  /** Records to generate when no data file is loaded (counters only, or a PDF from images). */
  manualCount: 1,
  /** 1-based inclusive range, empty = all. */
  rangeFrom: '',
  rangeTo: '',
  /** Name of the project file opened last (proposed again when saving). */
  projectName: null as string | null,
};

/** composition = sources or slots changed (files, order, page setup). */
export type Topic = 'composition' | 'data' | 'fields' | 'geometry' | 'selection' | 'view' | 'fonts' | 'output';
const listeners = new Map<Topic, Set<() => void>>();

export function on(topics: Topic[], fn: () => void): void {
  for (const t of topics) {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  }
}

/** Calls each subscriber once even if it listens to several of the topics. */
export function notify(...topics: Topic[]): void {
  const fns = new Set<() => void>();
  for (const t of topics) for (const fn of listeners.get(t) ?? []) fns.add(fn);
  for (const fn of fns) fn();
}

export function recordCount(): number {
  return state.data ? state.data.rows.length : Math.max(0, Math.floor(state.manualCount));
}

export function selectedField(): Field | null {
  return state.fields.find((f) => f.id === state.selectedId) ?? null;
}

export function currentSlot(): Slot | null {
  return state.slots.find((s) => s.id === state.slotId) ?? null;
}

export function sourceOf(slot: Slot): Source {
  return state.sources.find((s) => s.id === slot.sourceId)!;
}

/** Geometry (and image placement) of a slot: the same resolution feeds editor, preview and output. */
export function slotPage(slot: Slot): JobPage {
  return jobPage(slot, sourceOf(slot).info);
}

export const enabledSlots = () => state.slots.filter((s) => s.enabled);

/** Sources for the worker: only the files used by enabled slots. */
export function jobSources(): JobSource[] {
  const used = new Set(enabledSlots().map((s) => s.sourceId));
  return state.sources.filter((s) => used.has(s.id)).map(({ id, name, kind, bytes }) => ({ id, name, kind, bytes }));
}

/** "fronte.pdf · pag. 2" or "logo.png". */
export function slotLabel(slot: Slot): string {
  const src = sourceOf(slot);
  return src.kind === 'pdf' && src.info.kind === 'pdf' && src.info.pages.length > 1 ? `${src.name} · pag. ${slot.page + 1}` : src.name;
}

export function setSourceHeader(header: boolean): void {
  if (!state.source) return;
  state.source.header = header;
  state.data = toDataSet(state.source.table, header);
  state.record = Math.min(state.record, Math.max(0, state.data.rows.length - 1));
}

/** Resolves the record range to 0-based inclusive indices. */
export function recordRange(): { from: number; to: number } {
  const n = recordCount();
  const from = state.rangeFrom.trim() === '' ? 1 : Number(state.rangeFrom);
  const to = state.rangeTo.trim() === '' ? n : Number(state.rangeTo);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > n || from > to) {
    throw new Error(`Intervallo record non valido: scegli valori tra 1 e ${n}`);
  }
  return { from: from - 1, to: to - 1 };
}

function baseField(name: string, slot: string, x: number, y: number, w: number, h: number) {
  return {
    id: newId('f'),
    name,
    slot,
    x,
    y,
    w,
    h,
    rotation: 0 as const,
    color: { mode: 'cmyk' as const, c: 0, m: 0, y: 0, k: 100 },
    content: '',
    counter: { start: 1, step: 1, digits: 0 },
    whiteBackground: false,
    margin: 0,
  };
}

/** A new field centred on the current page. */
export function createField(type: Field['type'], slot: Slot): Field {
  const { viewWidth: pw, viewHeight: ph } = slotPage(slot).geometry;
  const n = state.fields.length + 1;
  if (type === 'text') {
    const w = Math.min(60 * MM, pw * 0.8);
    const h = 10 * MM;
    const firstColumn = state.data?.columns[0];
    const field: TextField = {
      ...baseField(`Testo ${n}`, slot.id, (pw - w) / 2, (ph - h) / 2, w, h),
      type: 'text',
      content: firstColumn ? `{${firstColumn}}` : '{#}',
      font: 'Helvetica',
      size: 12,
      align: 'left',
      valign: 'middle',
      lineHeight: 1.2,
      wrap: false,
      shrink: false,
    };
    return field;
  }
  const s = Math.min(25 * MM, pw * 0.5, ph * 0.5);
  const field: BarcodeField = {
    ...baseField(`Codice ${n}`, slot.id, (pw - s) / 2, (ph - s) / 2, s, s),
    type: 'barcode',
    content: '{#}',
    counter: { start: 1, step: 1, digits: 6 },
    whiteBackground: true,
    margin: 1 * MM,
    symbology: 'qrcode',
    showText: true,
    ecLevel: 'M',
  };
  return field;
}

export function cloneField(f: Field, slot = f.slot): Field {
  const copy = structuredClone(f);
  copy.id = newId('f');
  copy.slot = slot;
  if (slot === f.slot) {
    copy.name = `${f.name} copia`;
    copy.x += 5 * MM;
    copy.y += 5 * MM;
  }
  return copy;
}
