import { newId } from '../core/composition';
import { defaultLayout, rasterPage } from '../core/raster';
import type { RasterLayout, Slot } from '../core/types';
import { removeSource } from './actions';
import { backgroundKey, withSlotPage } from './backgrounds';
import { $, errorMessage, formatBytes, h, toast } from './dom';
import { cloneField, currentSlot, enabledSlots, MM, notify, on, slotLabel, slotPage, sourceOf, state } from './state';

/**
 * "Pagine per record": the composition. Each row is a slot (a page of a loaded
 * file); rows can be reordered (drag or arrows), duplicated, excluded or removed.
 */
const panel = $('#composition');
const THUMB = 44;
const thumbs = new Map<string, Promise<HTMLCanvasElement>>();

function select(slot: Slot): void {
  state.slotId = slot.id;
  notify('view');
}

function move(from: number, to: number): void {
  if (to < 0 || to >= state.slots.length || from === to) return;
  const [slot] = state.slots.splice(from, 1);
  state.slots.splice(to, 0, slot);
  notify('composition', 'fields');
}

function duplicate(slot: Slot): void {
  const copy: Slot = { ...structuredClone(slot), id: newId('s') };
  state.slots.splice(state.slots.indexOf(slot) + 1, 0, copy);
  state.fields.push(...state.fields.filter((f) => f.slot === slot.id).map((f) => cloneField(f, copy.id)));
  state.slotId = copy.id;
  notify('composition', 'fields', 'view');
}

function remove(slot: Slot): void {
  const fields = state.fields.filter((f) => f.slot === slot.id).length;
  if (fields && !confirm(`Eliminare la pagina e le sue ${fields} zone?`)) return;
  state.slots = state.slots.filter((s) => s !== slot);
  state.fields = state.fields.filter((f) => f.slot !== slot.id);
  if (state.slotId === slot.id) state.slotId = state.slots[0]?.id ?? null;
  if (state.selectedId && !state.fields.some((f) => f.id === state.selectedId)) state.selectedId = null;
  notify('composition', 'fields', 'selection', 'view');
}

/** Small preview of the page background, rendered once per background and reused. */
function thumbnail(slot: Slot): HTMLCanvasElement {
  const canvas = h('canvas', { class: 'thumb', width: THUMB, height: THUMB });
  const key = backgroundKey(slot);
  let rendered = thumbs.get(key);
  if (!rendered) {
    rendered = withSlotPage(slot, async (page) => {
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (THUMB * 2) / Math.max(base.width, base.height) });
      const off = document.createElement('canvas');
      off.width = Math.round(vp.width);
      off.height = Math.round(vp.height);
      await page.render({ canvas: off, viewport: vp }).promise;
      return off;
    });
    thumbs.set(key, rendered);
    rendered.catch(() => thumbs.delete(key));
  }
  rendered.then((src) => {
    canvas.width = src.width;
    canvas.height = src.height;
    canvas.getContext('2d')!.drawImage(src, 0, 0);
  }, () => {});
  return canvas;
}

function slotRow(slot: Slot, i: number): HTMLElement {
  let size = '';
  try {
    const g = slotPage(slot).geometry;
    size = `${(g.viewWidth / MM).toFixed(0)}×${(g.viewHeight / MM).toFixed(0)} mm`;
  } catch (e) {
    size = errorMessage(e);
  }
  const enabled = h('input', { type: 'checkbox', checked: slot.enabled, title: 'Includi questa pagina nel PDF' });
  enabled.addEventListener('change', () => {
    slot.enabled = enabled.checked;
    notify('composition', 'output');
  });
  const btn = (label: string, title: string, fn: () => void, disabled = false) =>
    h('button', { type: 'button', class: 'link', title, disabled, onclick: (e: Event) => (e.stopPropagation(), fn()) }, label);
  const li = h(
    'li',
    { class: `${slot.id === state.slotId ? 'selected' : ''}${slot.enabled ? '' : ' off'}`, draggable: true, onclick: () => select(slot), title: 'Clic per modificare le zone di questa pagina; trascina per riordinare' },
    thumbnail(slot),
    h('div', { class: 'slot-info' },
      h('strong', {}, `${i + 1}. `, h('span', {}, slotLabel(slot))),
      h('span', { class: 'muted small' }, `${size}${slot.enabled ? '' : ' · esclusa'}`),
    ),
    h('div', { class: 'slot-actions' },
      btn('↑', 'Sposta prima', () => move(i, i - 1), i === 0),
      btn('↓', 'Sposta dopo', () => move(i, i + 1), i === state.slots.length - 1),
      btn('⧉', 'Duplica la pagina con le sue zone', () => duplicate(slot)),
      btn('✕', 'Elimina la pagina dalla composizione', () => remove(slot)),
    ),
    enabled,
  );
  enabled.addEventListener('click', (e) => e.stopPropagation());
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData('application/x-dv-slot', String(i));
    e.dataTransfer!.effectAllowed = 'move';
  });
  li.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('application/x-dv-slot')) return;
    e.preventDefault();
    li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    const from = e.dataTransfer?.getData('application/x-dv-slot');
    if (from === undefined || from === '') return;
    e.preventDefault();
    e.stopPropagation();
    move(Number(from), i);
  });
  return li;
}

function addPageRow(): HTMLElement {
  const options = state.sources.flatMap((src) =>
    src.info.kind === 'pdf'
      ? src.info.pages.map((_, p) => h('option', { value: `${src.id}:${p}` }, src.info.kind === 'pdf' && src.info.pages.length > 1 ? `${src.name} · pag. ${p + 1}` : src.name))
      : [h('option', { value: `${src.id}:0` }, src.name)],
  );
  const sel = h('select', { title: 'Pagina da aggiungere in fondo alla composizione' }, ...options);
  const add = () => {
    const [sourceId, page] = sel.value.split(':');
    const last = [...state.slots].reverse().find((s) => s.sourceId === sourceId);
    const src = state.sources.find((s) => s.id === sourceId)!;
    const slot: Slot = { id: newId('s'), sourceId, page: Number(page), enabled: true };
    if (src.info.kind !== 'pdf') slot.raster = last?.raster ? structuredClone(last.raster) : defaultLayout(src.info.raster);
    state.slots.push(slot);
    state.slotId = slot.id;
    notify('composition', 'fields', 'view');
  };
  return h('div', { class: 'add-page' }, sel, h('button', { type: 'button', class: 'btn small', onclick: add }, '＋ Aggiungi'));
}

function filesList(): HTMLElement {
  return h(
    'ul',
    { class: 'files' },
    ...state.sources.map((src) => {
      const detail = src.info.kind === 'pdf' ? `${src.info.pages.length} pag.` : `${src.info.raster.width}×${src.info.raster.height} px`;
      return h('li', { title: src.info.kind === 'pdf' ? 'PDF' : src.info.raster.description },
        h('span', { class: 'name' }, src.name),
        h('span', { class: 'muted small' }, `${detail} · ${formatBytes(src.bytes.length)}`),
        h('button', {
          type: 'button',
          class: 'link',
          title: 'Rimuovi il file, le sue pagine e le loro zone',
          onclick: () => {
            const n = state.slots.filter((s) => s.sourceId === src.id).length;
            if (confirm(`Rimuovere ${src.name} e le sue ${n} pagine dalla composizione?`)) removeSource(src.id).catch((e) => toast(errorMessage(e), 'error'));
          },
        }, '✕'),
      );
    }),
  );
}

/** Page setup of an image slot: size, orientation, fit. Never crops or distorts unless chosen. */
function rasterSettings(slot: Slot): HTMLElement | null {
  const src = sourceOf(slot);
  if (src.info.kind === 'pdf' || !slot.raster) return null;
  const info = src.info.raster;
  const layout = slot.raster;
  const update = (patch: Partial<RasterLayout>) => {
    Object.assign(layout, patch);
    if (layout.size === 'image' && !layout.dpi && !info.dpi) layout.dpi = 300;
    notify('composition', 'view');
  };
  const choice = <T extends string>(value: T, options: Array<[T, string]>, onChange: (v: T) => void) =>
    h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const mm = (value: number, onChange: (v: number) => void) => {
    const el = h('input', { type: 'number', min: 10, step: 1, value: Math.round((value / MM) * 10) / 10 });
    el.addEventListener('change', () => el.valueAsNumber > 0 && onChange(el.valueAsNumber * MM));
    return el;
  };
  const fileDpi = info.dpi ? `${Math.round(info.dpi[0])} dpi nel file` : 'risoluzione non indicata nel file';
  let summary: string;
  let low = false;
  try {
    const placed = rasterPage(info, layout);
    summary = `${info.width}×${info.height} px · ${info.description} · stampa a ${Math.round(placed.effectiveDpi)} dpi`;
    low = placed.effectiveDpi < 150;
  } catch (e) {
    summary = errorMessage(e);
  }
  const custom = layout.size === 'custom';
  const real = layout.size === 'image';
  return h('fieldset', { class: 'raster' }, h('legend', {}, 'Pagina da immagine'),
    h('label', { class: 'row' }, h('span', {}, 'Formato'),
      choice(layout.size, [['image', 'Dimensione reale (DPI)'], ['A3', 'A3'], ['A4', 'A4'], ['A5', 'A5'], ['custom', 'Personalizzato']], (size) => {
        if (size === 'custom' && layout.size !== 'custom') {
          const g = slotPage(slot).geometry;
          update({ size, width: g.viewWidth, height: g.viewHeight });
        } else update({ size });
      }),
    ),
    custom
      ? h('div', { class: 'grid2' },
          h('label', { class: 'row' }, h('span', {}, 'Larghezza mm'), mm(layout.width, (width) => update({ width }))),
          h('label', { class: 'row' }, h('span', {}, 'Altezza mm'), mm(layout.height, (height) => update({ height }))),
        )
      : null,
    real
      ? h('label', { class: 'row' }, h('span', {}, `DPI (${fileDpi})`),
          (() => {
            const el = h('input', { type: 'number', min: 1, step: 1, placeholder: info.dpi ? String(Math.round(info.dpi[0])) : '300', value: layout.dpi ?? '' });
            el.addEventListener('change', () => update({ dpi: el.value === '' ? null : Math.max(1, el.valueAsNumber) }));
            return el;
          })(),
        )
      : h('div', { class: 'grid2' },
          h('label', { class: 'row' }, h('span', {}, 'Orientamento'),
            choice(layout.orientation, [['auto', 'Come l’immagine'], ['portrait', 'Verticale'], ['landscape', 'Orizzontale']], (orientation) => update({ orientation })),
          ),
          h('label', { class: 'row' }, h('span', {}, 'Adattamento'),
            choice(layout.fit, [['contain', 'Intera, senza tagli'], ['cover', 'Riempi (taglia i bordi)'], ['stretch', 'Deforma per riempire']], (fit) => update({ fit })),
          ),
        ),
    h('p', { class: `small ${low ? 'error' : 'muted'}` }, summary, low ? ' · risoluzione bassa per la stampa' : ''),
  );
}

function render(): void {
  if (!state.sources.length) {
    panel.replaceChildren(h('p', { class: 'muted hint' }, 'Carica uno o più file grafici (PDF, JPG o PNG): ogni pagina diventa una pagina del record (es. fronte e retro). Puoi riordinarle, ripeterle ed escluderle.'));
    return;
  }
  const slot = currentSlot();
  renderedSlot = state.slotId;
  const live = new Set(state.slots.map(backgroundKey));
  for (const key of thumbs.keys()) if (!live.has(key)) thumbs.delete(key);
  const perRecord = enabledSlots().length;
  panel.replaceChildren(
    h('ol', { class: 'slots' }, ...state.slots.map(slotRow)),
    h('p', { class: 'muted small' }, `${perRecord} ${perRecord === 1 ? 'pagina' : 'pagine'} per record, in quest’ordine.`),
    addPageRow(),
    (slot && rasterSettings(slot)) ?? '',
    h('details', { class: 'files-box' }, h('summary', { class: 'small' }, `File grafici caricati (${state.sources.length})`), filesList()),
  );
}

let renderedSlot: string | null = null;

export function initPagesPanel(): void {
  on(['composition'], render);
  // A "view" change (record, zoom, current page) needs a rebuild only when the current page changed.
  on(['view'], () => state.slotId !== renderedSlot && render());
  render();
}
