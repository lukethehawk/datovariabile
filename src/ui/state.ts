import type { PDFDocumentProxy } from 'pdfjs-dist';
import { toDataSet, type RawTable } from '../core/data';
import type { BarcodeField, DataSet, Field, FontAsset, TemplatePage, TextField } from '../core/types';

export const MM = 72 / 25.4;

export interface Template {
  name: string;
  bytes: Uint8Array;
  pages: TemplatePage[];
  pdf: PDFDocumentProxy;
  close: () => Promise<void>;
}

export interface DataSource {
  name: string;
  bytes: Uint8Array;
  table: RawTable;
  header: boolean;
}

export const state = {
  template: null as Template | null,
  source: null as DataSource | null,
  data: null as DataSet | null,
  fields: [] as Field[],
  fonts: [] as FontAsset[],
  selectedId: null as string | null,
  /** Template page shown in the editor. */
  page: 0,
  /** Record shown in the preview (0-based). */
  record: 0,
  /** CSS pixels per PDF point; 0 = fit to the viewport. */
  zoom: 0,
  /** Records to generate when no data file is loaded (counters only). */
  manualCount: 100,
  /** 1-based inclusive range, empty = all. */
  rangeFrom: '',
  rangeTo: '',
  /** Template pages emitted per record, e.g. "1,2" or "1-3"; empty = all. */
  pagesSpec: '',
};

export type Topic = 'template' | 'data' | 'fields' | 'geometry' | 'selection' | 'view' | 'fonts' | 'output';
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

export function setSourceHeader(header: boolean): void {
  if (!state.source) return;
  state.source.header = header;
  state.data = toDataSet(state.source.table, header);
  state.record = Math.min(state.record, Math.max(0, state.data.rows.length - 1));
}

/** Parses "1,3-4" into 0-based page indices; empty means all pages. */
export function parsePages(spec: string, pageCount: number): number[] {
  const all = Array.from({ length: pageCount }, (_, i) => i);
  if (spec.trim() === '') return all;
  const out: number[] = [];
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`Pagine velina: "${part}" non valido (esempio: 1,2 oppure 1-3)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
      if (p < 1 || p > pageCount) throw new Error(`Pagine velina: la pagina ${p} non esiste (la velina ha ${pageCount} pagine)`);
      out.push(p - 1);
    }
  }
  return out;
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

let nextId = 1;
const newId = () => `f${Date.now().toString(36)}${nextId++}`;

function baseField(name: string, x: number, y: number, w: number, h: number) {
  return {
    id: newId(),
    name,
    page: state.page,
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
export function createField(type: Field['type']): Field {
  const page = state.template?.pages[state.page];
  const pw = page?.viewWidth ?? 595;
  const ph = page?.viewHeight ?? 842;
  const n = state.fields.length + 1;
  if (type === 'text') {
    const w = Math.min(60 * MM, pw * 0.8);
    const h = 10 * MM;
    const firstColumn = state.data?.columns[0];
    const field: TextField = {
      ...baseField(`Testo ${n}`, (pw - w) / 2, (ph - h) / 2, w, h),
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
    ...baseField(`Codice ${n}`, (pw - s) / 2, (ph - s) / 2, s, s),
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

export function cloneField(f: Field): Field {
  const copy = structuredClone(f);
  copy.id = newId();
  copy.name = `${f.name} copia`;
  copy.x += 5 * MM;
  copy.y += 5 * MM;
  return copy;
}
