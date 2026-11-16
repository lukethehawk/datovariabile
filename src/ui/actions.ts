import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readTable, toDataSet } from '../core/data';
import { inspectTemplate } from '../core/generate';
import { STANDARD_FONTS } from '../core/fonts';
import type { Field } from '../core/types';
import { download } from './dom';
import { notify, state } from './state';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Opens a PDF with pdf.js; `close()` releases it (the worker-side document included). */
export async function openPdf(bytes: Uint8Array) {
  // pdf.js transfers the buffer to its worker: hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  return { pdf: await task.promise, close: () => task.destroy() };
}

export async function loadTemplate(name: string, bytes: Uint8Array): Promise<void> {
  const pages = await inspectTemplate(bytes);
  const { pdf, close } = await openPdf(bytes);
  await state.template?.close();
  state.template = { name, bytes, pages, pdf, close };
  notify('template', 'fields', 'view');
}

export function loadData(name: string, bytes: Uint8Array, sheet?: string): void {
  const table = readTable(name, bytes, sheet);
  const header = state.source?.name === name ? state.source.header : table.headerGuess;
  state.source = { name, bytes, table, header };
  state.data = toDataSet(table, header);
  state.record = 0;
  notify('data', 'fields');
}

export function clearData(): void {
  state.source = null;
  state.data = null;
  state.record = 0;
  notify('data', 'fields');
}

export function addFont(fileName: string, bytes: Uint8Array): string {
  let name = fileName.replace(/\.(ttf|otf)$/i, '');
  if (STANDARD_FONTS[name]) name += ' (file)';
  state.fonts = [...state.fonts.filter((f) => f.name !== name), { name, bytes }];
  notify('fonts', 'fields');
  return name;
}

export function removeFont(name: string): void {
  state.fonts = state.fonts.filter((f) => f.name !== name);
  for (const f of state.fields) if (f.type === 'text' && f.font === name) f.font = 'Helvetica';
  notify('fonts', 'fields');
}

/** Routes a dropped/selected file by extension. */
export async function openFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  if (/\.pdf$/i.test(name)) {
    await loadTemplate(name, bytes);
    return `Velina caricata: ${name}`;
  }
  if (/\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|txt)$/i.test(name)) {
    loadData(name, bytes);
    return `Dati caricati: ${state.data!.rows.length} record`;
  }
  if (/\.(ttf|otf)$/i.test(name)) return `Font caricato: ${addFont(name, bytes)}`;
  if (/\.json$/i.test(name)) {
    await openProject(new TextDecoder().decode(bytes));
    return `Progetto aperto: ${name}`;
  }
  throw new Error(`Formato non supportato: ${name}`);
}

// ---------------------------------------------------------------- project

interface ProjectFile {
  app: 'DatoVariabile';
  version: 1;
  fields: Field[];
  fonts: Array<{ name: string; data: string }>;
  template: { name: string; data: string } | null;
  manualCount: number;
  pagesSpec: string;
}

/** The project embeds template and fonts so it reopens in one click; data files are per job. */
export function saveProject(): void {
  const project: ProjectFile = {
    app: 'DatoVariabile',
    version: 1,
    fields: state.fields,
    fonts: state.fonts.map((f) => ({ name: f.name, data: toBase64(f.bytes) })),
    template: state.template ? { name: state.template.name, data: toBase64(state.template.bytes) } : null,
    manualCount: state.manualCount,
    pagesSpec: state.pagesSpec,
  };
  const base = state.template?.name.replace(/\.pdf$/i, '') ?? 'progetto';
  download(JSON.stringify(project), `${base}.dvp.json`, 'application/json');
}

export async function openProject(json: string): Promise<void> {
  const p = JSON.parse(json) as ProjectFile;
  if (p.app !== 'DatoVariabile') throw new Error('Il file non è un progetto DatoVariabile');
  state.fonts = p.fonts.map((f) => ({ name: f.name, bytes: fromBase64(f.data) }));
  state.fields = p.fields;
  state.manualCount = p.manualCount;
  state.pagesSpec = p.pagesSpec;
  state.selectedId = null;
  if (p.template) await loadTemplate(p.template.name, fromBase64(p.template.data));
  notify('fonts', 'fields', 'selection', 'output');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
