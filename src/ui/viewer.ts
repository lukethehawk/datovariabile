import type { RenderTask } from 'pdfjs-dist';
import { generate, type JobPage } from '../core/generate';
import type { Field } from '../core/types';
import { openPdf } from './actions';
import { backgroundKey, withSlotPage } from './backgrounds';
import { $, errorMessage, h } from './dom';
import { currentSlot, MM, notify, on, recordCount, selectedField, slotLabel, slotPage, state } from './state';

/** Page shown in the editor, or null without a composition (or an unresolvable page setup). */
function currentPage(): JobPage | null {
  const slot = currentSlot();
  if (!slot) return null;
  try {
    return slotPage(slot);
  } catch (e) {
    previewError.textContent = errorMessage(e);
    previewError.hidden = false;
    return null;
  }
}

const viewport = $('#viewport');
const pageEl = $('#page');
const bgCanvas = $('#bg') as HTMLCanvasElement;
const overlayCanvas = $('#overlay') as HTMLCanvasElement;
const boxesEl = $('#boxes');
const previewError = $('#preview-error');

/** Current CSS pixels per PDF point. */
let scale = 1;

function computeScale(page: JobPage): number {
  if (state.zoom > 0) return state.zoom;
  const pad = 48;
  const { viewWidth, viewHeight } = page.geometry;
  return Math.max(0.05, Math.min((viewport.clientWidth - pad) / viewWidth, (viewport.clientHeight - pad) / viewHeight));
}

// ------------------------------------------------------------- rendering

let bgTask: RenderTask | null = null;
let bgKey = '';
let bgSeq = 0;

async function renderBackground(): Promise<void> {
  const slot = currentSlot();
  if (!slot) return;
  const dpr = window.devicePixelRatio || 1;
  const key = `${backgroundKey(slot)}|${scale}|${dpr}`;
  if (key === bgKey) return;
  bgKey = key;
  const seq = ++bgSeq;
  bgTask?.cancel();
  try {
    await withSlotPage(slot, async (page) => {
      if (seq !== bgSeq) return;
      const vp = page.getViewport({ scale: scale * dpr });
      bgCanvas.width = Math.round(vp.width);
      bgCanvas.height = Math.round(vp.height);
      bgTask = page.render({ canvas: bgCanvas, viewport: vp });
      await bgTask.promise;
    });
  } catch (e) {
    if (seq === bgSeq) bgKey = ''; // retry on the next layout
    if ((e as Error).name !== 'RenderingCancelledException') throw e;
  }
}

let overlaySeq = 0;
let overlayTask: RenderTask | null = null;

/** Renders the variable data of the current record with the real generator (WYSIWYG). */
async function renderOverlay(): Promise<void> {
  const seq = ++overlaySeq;
  const ctx = overlayCanvas.getContext('2d')!;
  const page = currentPage();
  if (!page) return;
  const dpr = window.devicePixelRatio || 1;
  const fields = state.fields.filter((f) => f.slot === page.slot);
  previewError.hidden = true;
  if (fields.length === 0 || recordCount() === 0) {
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    return;
  }
  try {
    const record = Math.min(state.record, recordCount() - 1);
    const { bytes } = await generate({ sources: null, pages: [page], fields, fonts: state.fonts, data: state.data, generators: state.generators, now: state.previewNow, from: record, to: record });
    if (seq !== overlaySeq) return;
    const doc = await openPdf(bytes);
    try {
      if (seq !== overlaySeq) return;
      overlayTask?.cancel();
      const pdfPage = await doc.pdf.getPage(1);
      const vp = pdfPage.getViewport({ scale: scale * dpr });
      // Render off-screen first so the visible overlay never flickers.
      const tmp = document.createElement('canvas');
      tmp.width = Math.round(vp.width);
      tmp.height = Math.round(vp.height);
      // Own context: pdf.js would create an opaque (alpha: false) one, painting transparency black.
      overlayTask = pdfPage.render({ canvas: null, canvasContext: tmp.getContext('2d')!, viewport: vp, background: 'rgba(0,0,0,0)' });
      await overlayTask.promise;
      if (seq !== overlaySeq) return;
      overlayCanvas.width = tmp.width;
      overlayCanvas.height = tmp.height;
      ctx.drawImage(tmp, 0, 0);
    } finally {
      await doc.close();
    }
  } catch (e) {
    if ((e as Error).name === 'RenderingCancelledException' || seq !== overlaySeq) return;
    previewError.textContent = errorMessage(e);
    previewError.hidden = false;
  }
}

let overlayTimer: number | undefined;
function scheduleOverlay(): void {
  clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(renderOverlay, 120);
}

function layout(): void {
  previewError.hidden = true;
  const page = currentPage();
  $('#empty').hidden = state.slots.length > 0;
  pageEl.hidden = !page;
  if (!page) return;
  scale = computeScale(page);
  const w = page.geometry.viewWidth * scale;
  const hgt = page.geometry.viewHeight * scale;
  for (const el of [pageEl, bgCanvas, overlayCanvas]) {
    el.style.width = `${w}px`;
    el.style.height = `${hgt}px`;
  }
  $('#zoom-label').textContent = `${Math.round(scale * 100 * (96 / 72))}%`;
  renderBackground().catch((e) => {
    previewError.textContent = errorMessage(e);
    previewError.hidden = false;
  });
  drawBoxes();
}

// ------------------------------------------------------------- boxes

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
const MIN_SIZE = 2 * MM;

function placeBox(el: HTMLElement, f: Field): void {
  el.style.left = `${f.x * scale}px`;
  el.style.top = `${f.y * scale}px`;
  el.style.width = `${f.w * scale}px`;
  el.style.height = `${f.h * scale}px`;
}

function drawBoxes(): void {
  boxesEl.replaceChildren();
  for (const f of state.fields) {
    if (f.slot !== state.slotId) continue;
    const selected = f.id === state.selectedId;
    const box = h(
      'div',
      { class: `box${selected ? ' selected' : ''}`, 'data-id': f.id, title: f.name },
      h('span', { class: 'box-label' }, f.name),
      ...(selected ? HANDLES.map((hd) => h('div', { class: `handle ${hd}`, 'data-handle': hd })) : []),
    );
    placeBox(box, f);
    box.addEventListener('pointerdown', (ev) => startDrag(ev, f, box));
    boxesEl.append(box);
  }
}

function startDrag(ev: PointerEvent, f: Field, box: HTMLElement): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (state.selectedId !== f.id) {
    state.selectedId = f.id;
    notify('selection');
    // drawBoxes() replaced the element: continue the drag on the new one.
    box = boxesEl.querySelector<HTMLElement>(`[data-id="${f.id}"]`)!;
  }
  const handle = ((ev.target as HTMLElement).dataset.handle ?? 'move') as Handle;
  const page = currentPage()!.geometry;
  const start = { px: ev.clientX, py: ev.clientY, x: f.x, y: f.y, w: f.w, h: f.h };
  let moved = false;
  box.setPointerCapture(ev.pointerId);

  const onMove = (e: PointerEvent) => {
    const dx = (e.clientX - start.px) / scale;
    const dy = (e.clientY - start.py) / scale;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 1 / scale) return;
    moved = true;
    if (handle === 'move') {
      f.x = clamp(start.x + dx, -start.w / 2, page.viewWidth - start.w / 2);
      f.y = clamp(start.y + dy, -start.h / 2, page.viewHeight - start.h / 2);
    } else {
      if (handle.includes('e')) f.w = Math.max(MIN_SIZE, start.w + dx);
      if (handle.includes('s')) f.h = Math.max(MIN_SIZE, start.h + dy);
      if (handle.includes('w')) {
        f.w = Math.max(MIN_SIZE, start.w - dx);
        f.x = start.x + start.w - f.w;
      }
      if (handle.includes('n')) {
        f.h = Math.max(MIN_SIZE, start.h - dy);
        f.y = start.y + start.h - f.h;
      }
    }
    placeBox(box, f);
    notify('geometry');
  };
  const onUp = () => {
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', onUp);
    box.removeEventListener('pointercancel', onUp);
    if (moved) notify('fields');
  };
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------- toolbar

function renderStageBar(): void {
  const pageSel = $('#page-select') as HTMLSelectElement;
  pageSel.replaceChildren(
    ...state.slots.map((s, i) => {
      let size = '';
      try {
        const g = slotPage(s).geometry;
        size = ` (${(g.viewWidth / MM).toFixed(0)}×${(g.viewHeight / MM).toFixed(0)} mm)`;
      } catch {
        // page setup not resolvable yet: shown in the preview error
      }
      return h('option', { value: s.id, selected: s.id === state.slotId }, `Pagina ${i + 1}: ${slotLabel(s)}${size}${s.enabled ? '' : ' – esclusa'}`);
    }),
  );
  pageSel.disabled = state.slots.length < 2;
  const n = recordCount();
  ($('#record-input') as HTMLInputElement).value = String(n ? state.record + 1 : 0);
  ($('#record-input') as HTMLInputElement).max = String(n);
  $('#record-total').textContent = `di ${n}`;
}

export function initViewer(): void {
  on(['composition', 'view'], () => {
    renderStageBar();
    layout();
    scheduleOverlay();
  });
  on(['fields', 'data', 'fonts', 'generators'], () => {
    renderStageBar();
    drawBoxes();
    scheduleOverlay();
  });
  on(['selection'], drawBoxes);

  new ResizeObserver(() => state.zoom === 0 && layout()).observe(viewport);
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', layout);

  $('#page-select').addEventListener('change', (e) => {
    state.slotId = (e.target as HTMLSelectElement).value;
    notify('view');
  });
  const setRecord = (r: number) => {
    const n = recordCount();
    state.record = clamp(Math.round(r), 0, Math.max(0, n - 1));
    notify('view', 'data');
  };
  $('#record-prev').addEventListener('click', () => setRecord(state.record - 1));
  $('#record-next').addEventListener('click', () => setRecord(state.record + 1));
  $('#record-input').addEventListener('change', (e) => setRecord(Number((e.target as HTMLInputElement).value) - 1));

  const zoomBy = (k: number) => {
    state.zoom = clamp(scale * k, 0.1, 20);
    notify('view');
  };
  $('#zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('#zoom-fit').addEventListener('click', () => {
    state.zoom = 0;
    notify('view');
  });
  viewport.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false },
  );
  // Click on empty page area clears the selection.
  viewport.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.box')) return;
    if (state.selectedId) {
      state.selectedId = null;
      notify('selection');
    }
  });

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    const f = selectedField();
    if (!f) return;
    const step = (e.shiftKey ? 5 : 0.5) * MM;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      f.x += moves[e.key][0];
      f.y += moves[e.key][1];
      notify('fields');
    } else if (e.key === 'Delete') {
      e.preventDefault();
      state.fields = state.fields.filter((x) => x !== f);
      state.selectedId = null;
      notify('fields', 'selection');
    }
  });
}
