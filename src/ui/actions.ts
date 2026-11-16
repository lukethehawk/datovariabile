import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { inspectSource, newId, slotsFor, sourceKind } from '../core/composition';
import { readTable, toDataSet } from '../core/data';
import { STANDARD_FONTS } from '../core/fonts';
import { parseProject, serializeProject } from '../core/project';
import type { SourceFile } from '../core/types';
import { download } from './dom';
import { notify, state, type Source } from './state';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface OpenedPdf {
  pdf: PDFDocumentProxy;
  close: () => Promise<void>;
}

/** Opens a PDF with pdf.js; `close()` releases it (the worker-side document included). */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  // pdf.js transfers the buffer to its worker: hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  return { pdf: await task.promise, close: () => task.destroy() };
}

/** Parses a file into a source (PDF via pdf-lib + pdf.js, images via their headers only). */
async function makeSource(file: SourceFile): Promise<Source> {
  const info = await inspectSource(file.bytes, file.kind);
  if (file.kind !== 'pdf') return { ...file, info, pdf: null, close: async () => {} };
  const { pdf, close } = await openPdf(file.bytes);
  return { ...file, info, pdf, close };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Adds a PDF/JPG/PNG and appends all its pages to the composition. A file already
 * loaded (same bytes) is reused, so it is stored once in memory and in the project.
 */
export async function addSource(name: string, bytes: Uint8Array): Promise<string> {
  const kind = sourceKind(name);
  if (!kind) throw new Error(`Formato non supportato come velina: ${name}`);
  let source = state.sources.find((s) => sameBytes(s.bytes, bytes));
  if (!source) {
    try {
      source = await makeSource({ id: newId('src'), name, kind, bytes });
    } catch (e) {
      throw new Error(`${name}: ${e instanceof Error ? e.message : e}`);
    }
    state.sources.push(source);
  }
  const slots = slotsFor(source.id, source.info);
  state.slots.push(...slots);
  state.slotId ??= slots[0].id;
  notify('composition', 'fields', 'view');
  return slots.length > 1 ? `${name}: ${slots.length} pagine aggiunte` : `${name}: pagina aggiunta`;
}

/** Removes a file with its pages and the fields placed on them. */
export async function removeSource(id: string): Promise<void> {
  const source = state.sources.find((s) => s.id === id);
  if (!source) return;
  const gone = new Set(state.slots.filter((s) => s.sourceId === id).map((s) => s.id));
  state.slots = state.slots.filter((s) => !gone.has(s.id));
  state.fields = state.fields.filter((f) => !gone.has(f.slot));
  state.sources = state.sources.filter((s) => s !== source);
  if (state.slotId && gone.has(state.slotId)) state.slotId = state.slots[0]?.id ?? null;
  if (state.selectedId && !state.fields.some((f) => f.id === state.selectedId)) state.selectedId = null;
  await source.close();
  notify('composition', 'fields', 'selection', 'view');
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
  if (sourceKind(name)) return addSource(name, bytes);
  if (/\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|txt)$/i.test(name)) {
    loadData(name, bytes);
    return `Dati caricati: ${state.data!.rows.length} record`;
  }
  if (/\.(ttf|otf)$/i.test(name)) return `Font caricato: ${addFont(name, bytes)}`;
  if (/\.json$/i.test(name)) return openProject(name, new TextDecoder().decode(bytes));
  throw new Error(`Formato non supportato: ${name}`);
}

// ---------------------------------------------------------------- project

/** The project embeds the source files and fonts so it reopens in one click; data files are per job. */
export function saveProject(): void {
  const json = serializeProject({
    sources: state.sources.map(({ id, name, kind, bytes }) => ({ id, name, kind, bytes })),
    slots: state.slots,
    fields: state.fields,
    fonts: state.fonts,
    manualCount: state.manualCount,
  });
  const base = state.sources[0]?.name.replace(/\.[^.]+$/, '') ?? 'progetto';
  download(json, `${base}.dvp.json`, 'application/json');
}

export async function openProject(fileName: string, json: string): Promise<string> {
  const { project, warnings } = await parseProject(json);
  // All or nothing: if one file cannot be opened, release the ones already opened.
  const opened = await Promise.allSettled(project.sources.map(makeSource));
  const failed = opened.find((r) => r.status === 'rejected');
  const sources = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (failed) {
    await Promise.all(sources.map((s) => s.close()));
    throw failed.reason;
  }
  await Promise.all(state.sources.map((s) => s.close()));
  state.sources = sources;
  state.slots = project.slots;
  state.fields = project.fields;
  state.fonts = project.fonts;
  state.manualCount = project.manualCount;
  state.slotId = project.slots.find((s) => s.enabled)?.id ?? project.slots[0]?.id ?? null;
  state.selectedId = null;
  notify('composition', 'fonts', 'fields', 'selection', 'output', 'view', 'data');
  return [`Progetto aperto: ${fileName}`, ...warnings].join(' · ');
}
