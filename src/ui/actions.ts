import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { inspectSource, jobPage, newId, slotsFor, sourceKind } from '../core/composition';
import { readTable, toDataSet } from '../core/data';
import { STANDARD_FONTS } from '../core/fonts';
import { readProjectFile, writeProjectArchive } from '../core/archive';
import { referencedColumns } from '../core/placeholders';
import { ZIP_LIMITS } from '../core/zip';
import type { SourceFile } from '../core/types';
import { download, formatBytes } from './dom';
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
  try {
    return { pdf: await task.promise, close: () => task.destroy() };
  } catch (e) {
    await task.destroy();
    throw e;
  }
}

let loads = 0;

/** Parses a file into a source (PDF via pdf-lib + pdf.js, images via their headers only). */
async function makeSource(file: SourceFile): Promise<Source> {
  const info = await inspectSource(file.bytes, file.kind);
  const rev = ++loads;
  if (file.kind !== 'pdf') return { ...file, info, rev, pdf: null, close: async () => {} };
  const { pdf, close } = await openPdf(file.bytes);
  return { ...file, info, rev, pdf, close };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Adds a PDF/JPG/PNG and appends all its pages to the composition. A file already
 * loaded (same bytes) is reused, so it is stored once in memory and in the project.
 */
export async function addSource(name: string, bytes: Uint8Array): Promise<string> {
  const kind = sourceKind(name);
  if (!kind) throw new Error(`Formato non supportato come file grafico: ${name}`);
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
  const name = file.name;
  const isProject = /\.(zip|json)$/i.test(name);
  if (isProject && file.size > ZIP_LIMITS.archive) throw new Error(`Progetto troppo grande da aprire nel browser (${formatBytes(file.size)})`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sourceKind(name)) return addSource(name, bytes);
  if (/\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|txt)$/i.test(name)) {
    loadData(name, bytes);
    return `Dati caricati: ${state.data!.rows.length} record`;
  }
  if (/\.(ttf|otf)$/i.test(name)) return `Font caricato: ${addFont(name, bytes)}`;
  if (isProject) return openProject(name, bytes);
  throw new Error(`Formato non supportato: ${name}`);
}

// ---------------------------------------------------------------- project

/** Name proposed for the archive: the project opened last, else the first background file. */
function projectBaseName(): string {
  return state.projectName ?? state.sources[0]?.name.replace(/\.[^.]+$/, '') ?? 'progetto';
}

/**
 * Saves everything needed to reopen the job on another PC: backgrounds, original
 * data file, imported table (CSV), fonts, composition, fields and settings.
 */
export async function saveProject(): Promise<string> {
  // Snapshot before the first await: the user may keep editing while large files are compressed.
  // Binary buffers are never mutated in place, so they are shared; editable metadata is cloned.
  const src = state.source;
  const snapshot = {
    sources: state.sources.map(({ id, name, kind, bytes }) => ({ id, name, kind, bytes })),
    slots: structuredClone(state.slots),
    fields: structuredClone(state.fields),
    fonts: [...state.fonts],
    manualCount: state.manualCount,
    data: src && state.data ? { name: src.name, original: src.bytes, table: src.table, header: src.header, columns: [...state.data.columns] } : null,
    range: { from: state.rangeFrom, to: state.rangeTo },
    generators: structuredClone(state.generators),
  };
  const { blob, warnings } = await writeProjectArchive(snapshot);
  const fileName = `${projectBaseName()}.dvp.zip`;
  download(blob, fileName, 'application/zip');
  const privacy = src ? ` · include i dati di ${src.name}: condividilo solo con chi è autorizzato` : '';
  const keys = snapshot.generators.some((g) => g.type === 'unique') ? ' · contiene la chiave dei codici univoci: trattalo come riservato' : '';
  return [`Progetto salvato: ${fileName} (${formatBytes(blob.size)})${privacy}${keys}`, ...warnings].join(' · ');
}

/** Opens a .dvp.zip (or a legacy .dvp.json). All or nothing: on error the current job stays as it was. */
export async function openProject(fileName: string, bytes: Uint8Array): Promise<string> {
  const { project, warnings, legacy } = await readProjectFile(bytes);
  // One file at a time (bounded memory); every page must resolve before the current job is replaced.
  const sources: Source[] = [];
  try {
    for (const file of project.sources) sources.push(await makeSource(file));
    for (const slot of project.slots) {
      const source = sources.find((s) => s.id === slot.sourceId)!;
      try {
        jobPage(slot, source.info);
      } catch (e) {
        throw new Error(`Progetto danneggiato: ${source.name}, ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    await Promise.allSettled(sources.map((s) => s.close()));
    throw e;
  }
  const old = state.sources;
  state.sources = sources;
  state.slots = project.slots;
  state.fields = project.fields;
  state.fonts = project.fonts;
  state.manualCount = project.manualCount;
  state.generators = project.generators;
  // Data and range always come from the project: never keep the data of the previous job.
  const d = project.data;
  state.source = d ? { name: d.name, bytes: d.original, table: d.table, header: d.header } : null;
  state.data = d ? { columns: d.columns, rows: d.header ? d.table.cells.slice(1) : d.table.cells } : null;
  state.rangeFrom = project.range.from;
  state.rangeTo = project.range.to;
  state.record = 0;
  state.slotId = project.slots.find((s) => s.enabled)?.id ?? project.slots[0]?.id ?? null;
  state.selectedId = null;
  state.projectName = fileName.replace(/\.dvp\.(zip|json)$/i, '').replace(/\.(zip|json)$/i, '');
  notify('composition', 'fonts', 'fields', 'selection', 'output', 'view', 'data', 'generators');
  // The new job is in place: failures while releasing the old files must not look like a failed opening.
  await Promise.allSettled(old.map((s) => s.close()));
  const usesColumns = project.fields.some((f) => referencedColumns(f.content, (n) => project.generators.some((g) => g.name.toLowerCase() === n.toLowerCase())).length > 0);
  if (legacy && usesColumns) warnings.unshift('Progetto in formato precedente: i dati non erano inclusi, carica il file dati e poi salva di nuovo');
  return [`Progetto aperto: ${fileName}`, ...warnings].join(' · ');
}
