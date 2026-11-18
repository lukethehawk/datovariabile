import type { PDFPageProxy } from 'pdfjs-dist';
import GenerateWorker from '../worker?worker&inline';
import type { WorkerMessage, WorkerRequest } from '../worker';
import type { Slot } from '../core/types';
import { openPdf, type OpenedPdf } from './actions';
import { slotPage, sourceOf } from './state';

/**
 * Background of a slot as a pdf.js page. PDF sources render their own page; an
 * image renders the one-page PDF that the real generator builds for that slot
 * (same embedding and placement as the output). That PDF is built in a worker
 * (PNG decoding can take a while) and cached per image and page setup; evicted
 * documents are closed only when no render is using them.
 */
interface RasterDoc {
  doc: Promise<OpenedPdf>;
  users: number;
  evicted: boolean;
}
const rasterDocs = new Map<string, RasterDoc>();
const MAX_RASTER_DOCS = 6;

/** Changes whenever the background of the slot looks different. */
export function backgroundKey(slot: Slot): string {
  return `${sourceOf(slot).rev}|${slot.page}|${slot.raster ? JSON.stringify(slot.raster) : ''}`;
}

function generateInWorker(request: WorkerRequest): Promise<Uint8Array> {
  const worker = new GenerateWorker();
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type === 'progress') return;
    worker.terminate();
    if (msg.type === 'done') resolve(msg.bytes);
    else reject(new Error(msg.message));
  };
  worker.onerror = (e) => {
    worker.terminate();
    reject(new Error(e.message || 'Errore durante la preparazione dell’anteprima'));
  };
  worker.postMessage(request);
  return promise;
}

function release(key: string, entry: RasterDoc): void {
  if (entry.users > 0 || !entry.evicted) return;
  void entry.doc.then((d) => d.close(), () => {});
  if (rasterDocs.get(key) === entry) rasterDocs.delete(key);
}

/** Runs `use` with the background page of the slot; the page stays valid until `use` settles. */
export async function withSlotPage<T>(slot: Slot, use: (page: PDFPageProxy) => Promise<T>): Promise<T> {
  const source = sourceOf(slot);
  if (source.pdf) return use(await source.pdf.getPage(slot.page + 1));
  const key = backgroundKey(slot);
  let entry = rasterDocs.get(key);
  if (!entry) {
    const page = slotPage(slot);
    const doc = generateInWorker({
      sources: [{ id: source.id, name: source.name, kind: source.kind, bytes: source.bytes }],
      pages: [page],
      fields: [],
      fonts: [],
      data: null,
      generators: [],
      now: 0,
      from: 0,
      to: 0,
    }).then(openPdf);
    const created: RasterDoc = { doc, users: 0, evicted: false };
    entry = created;
    rasterDocs.set(key, created);
    doc.catch(() => rasterDocs.get(key) === created && rasterDocs.delete(key));
    for (const [k, old] of rasterDocs) {
      if (rasterDocs.size <= MAX_RASTER_DOCS) break;
      rasterDocs.delete(k);
      old.evicted = true;
      release(k, old);
    }
  }
  entry.users++;
  try {
    return await use(await (await entry.doc).pdf.getPage(1));
  } finally {
    entry.users--;
    release(key, entry);
  }
}
