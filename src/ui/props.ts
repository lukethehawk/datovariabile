import { SYMBOLOGIES } from '../core/barcode';
import { STANDARD_FONTS } from '../core/fonts';
import { FILTERS } from '../core/filters';
import { columnRef } from '../core/placeholders';
import type { BarcodeField, ColorSpec, Field, Rotation, TextField } from '../core/types';
import { $, h } from './dom';
import { cloneField, createField, currentSlot, MM, notify, on, selectedField, state } from './state';
import { openTransformDialog } from './transform-dialog';
import { previewValue } from './value-preview';

const listEl = $('#field-list');
const propsEl = $('#props');

/** Inputs to refresh when the field changes elsewhere (drag, arrow keys). */
let syncers: Array<() => void> = [];

/** Refreshes the "Valore (record N)" line of the selected zone (content edits, record change). */
let refreshValue: (() => void) | null = null;

/** "Valore (record N): …": the exact text that will be printed or encoded, or the error. */
function valueLine(f: Field): HTMLElement {
  const label = h('span', { class: 'muted' });
  const value = h('code', {});
  const warning = h('span', { class: 'value-warn' });
  const line = h('p', { class: 'value-line small', 'aria-live': 'polite' }, label, value, warning);
  refreshValue = () => {
    const r = previewValue(f.content, f.counter);
    label.textContent = `Valore (record ${state.record + 1}): `;
    value.textContent = r.error ?? (r.value === '' ? '(vuoto)' : r.value);
    line.classList.toggle('error', r.error !== null);
    warning.textContent = r.warning ? ` ⚠ ${r.warning}` : '';
  };
  refreshValue();
  return line;
}

/** Short reference of the syntax and of the filters, with copyable examples. */
function syntaxGuide(): HTMLElement {
  const examples: Record<string, string> = {
    left: '{Codice|left:3}',
    right: '{@Codice|right:4}',
    mid: '{Codice|mid:4:3}',
    digits: '{Codice|digits}',
    upper: '{Nome|upper}',
    lower: '{Nome|lower}',
    trim: '{Nome|trim}',
    nospace: '{Codice|nospace}',
    replace: '{Codice|replace:"-":""}',
    prefix: '{Lotto|prefix:"L-"}',
    suffix: '{Lotto|suffix:"-MI"}',
    padleft: '{Matricola|padleft:8:0}',
    padright: '{Codice|padright:8:"*"}',
  };
  return h('details', { class: 'syntax-guide small' },
    h('summary', {}, 'Guida: segnaposto, filtri e graffe'),
    h('p', {}, 'Segnaposto: {Colonna} per i dati, {#} per il contatore della zona, {@Nome} per un generatore. Un nome con caratteri speciali va tra virgolette: {"Peso {kg}"}, {"@Nome"}.'),
    h('p', {}, 'Filtri dopo |, applicati in ordine: {@Codice|digits|right:4} = ultime 4 cifre. Testi tra virgolette ("FT-"). Un valore vuoto resta vuoto anche con prefix, suffix, padleft e padright.'),
    h('p', {}, 'Graffe nel testo: scrivile due volte, {{ e }}. {{{Nome}}} stampa il valore tra graffe; un JSON in un QR: {{"id":"{Codice}"}}.'),
    h('ul', {}, ...Object.entries(FILTERS).map(([name, def]) => h('li', {}, h('code', {}, examples[name]), ` ${def.label}`))),
  );
}

function renderList(): void {
  const pageNo = (f: Field) => state.slots.findIndex((s) => s.id === f.slot) + 1;
  listEl.replaceChildren(
    ...state.fields.map((f) =>
      h(
        'li',
        {
          class: f.id === state.selectedId ? 'selected' : '',
          onclick: () => {
            state.selectedId = f.id;
            if (f.slot !== state.slotId) {
              state.slotId = f.slot;
              notify('view');
            }
            notify('selection');
          },
        },
        h('span', { class: `kind ${f.type}` }, f.type === 'text' ? 'T' : '▥'),
        h('span', { class: 'name' }, f.name),
        state.slots.length > 1 ? h('span', { class: 'muted' }, `p.${pageNo(f)}`) : null,
      ),
    ),
  );
  if (state.fields.length === 0) listEl.append(h('li', { class: 'muted empty' }, 'Nessuna zona: aggiungine una'));
}

// ------------------------------------------------------------- controls

type Getter<T> = (f: Field) => T;
type Setter<T> = (f: Field, v: T) => void;

function changed(): void {
  notify('fields');
  renderList();
}

function row(label: string, ...controls: Node[]): HTMLElement {
  return h('label', { class: 'row' }, h('span', {}, label), ...controls);
}

function numberInput(f: Field, get: Getter<number>, set: Setter<number>, opts: { step?: number; min?: number; max?: number } = {}) {
  const el = h('input', { type: 'number', step: opts.step ?? 0.1, min: opts.min, max: opts.max, value: round(get(f)) });
  el.addEventListener('input', () => {
    if (el.value === '' || !Number.isFinite(el.valueAsNumber)) return;
    set(f, el.valueAsNumber);
    changed();
  });
  syncers.push(() => {
    if (document.activeElement !== el) el.value = String(round(get(f)));
  });
  return el;
}

/** Geometry in millimetres, stored in points. */
const mmInput = (f: Field, key: 'x' | 'y' | 'w' | 'h', min?: number) =>
  numberInput(
    f,
    (x) => x[key] / MM,
    (x, v) => (x[key] = v * MM),
    { min },
  );

function textInput(f: Field, get: Getter<string>, set: Setter<string>, multiline = false) {
  const el = multiline ? h('textarea', { rows: 3, spellcheck: false }) : h('input', { type: 'text' });
  el.value = get(f);
  el.addEventListener('input', () => {
    set(f, el.value);
    changed();
  });
  return el;
}

function select<T extends string | number>(f: Field, options: Array<[T, string]>, get: Getter<T>, set: Setter<T>) {
  const el = h('select', {}, ...options.map(([v, label]) => h('option', { value: String(v), selected: get(f) === v }, label)));
  el.addEventListener('change', () => {
    set(f, options[el.selectedIndex][0]);
    changed();
  });
  return el;
}

function checkbox(f: Field, label: string, get: Getter<boolean>, set: Setter<boolean>) {
  const el = h('input', { type: 'checkbox', checked: get(f) });
  el.addEventListener('change', () => {
    set(f, el.checked);
    changed();
  });
  return h('label', { class: 'check' }, el, label);
}

function segmented<T extends string>(f: Field, options: Array<[T, string, string]>, get: Getter<T>, set: Setter<T>) {
  const group = h('div', { class: 'segmented' });
  const paint = () => {
    for (const [i, b] of [...group.children].entries()) b.classList.toggle('on', options[i][0] === get(f));
  };
  for (const [v, label, title] of options) {
    group.append(
      h('button', {
        type: 'button',
        title,
        onclick: () => {
          set(f, v);
          paint();
          changed();
        },
      }, label),
    );
  }
  paint();
  return group;
}

function colorControls(f: Field): HTMLElement {
  const wrap = h('div', { class: 'color' });
  const paint = () => {
    const c = f.color;
    const controls: Node[] = [
      select(
        f,
        [
          ['cmyk', 'CMYK'],
          ['rgb', 'RGB'],
        ],
        (x) => x.color.mode,
        (x, v) => {
          x.color = v === 'cmyk' ? { mode: 'cmyk', c: 0, m: 0, y: 0, k: 100 } : { mode: 'rgb', hex: '#000000' };
          paint();
        },
      ),
    ];
    if (c.mode === 'cmyk') {
      for (const k of ['c', 'm', 'y', 'k'] as const) {
        controls.push(
          h(
            'label',
            { class: 'cmyk', title: `${k.toUpperCase()} %` },
            k.toUpperCase(),
            numberInput(f, (x) => (x.color as Extract<ColorSpec, { mode: 'cmyk' }>)[k], (x, v) => ((x.color as Extract<ColorSpec, { mode: 'cmyk' }>)[k] = clampPct(v)), {
              step: 1,
              min: 0,
              max: 100,
            }),
          ),
        );
      }
    } else {
      const el = h('input', { type: 'color', value: c.hex });
      el.addEventListener('input', () => {
        f.color = { mode: 'rgb', hex: el.value };
        changed();
      });
      controls.push(el);
    }
    wrap.replaceChildren(...controls);
  };
  paint();
  return wrap;
}

function columnPicker(f: Field, target: HTMLTextAreaElement | HTMLInputElement): HTMLElement | null {
  const cols = state.data?.columns ?? [];
  const insert = (token: string) => {
    const s = target.selectionStart ?? target.value.length;
    const e = target.selectionEnd ?? s;
    target.value = target.value.slice(0, s) + token + target.value.slice(e);
    target.setSelectionRange(s + token.length, s + token.length);
    f.content = target.value;
    target.focus();
    changed();
  };
  return h(
    'div',
    { class: 'chips' },
    ...cols.map((c) => h('button', { type: 'button', class: 'chip', title: `Inserisci {${columnRef(c)}}`, onclick: () => insert(`{${columnRef(c)}}`) }, c)),
    h('button', { type: 'button', class: 'chip counter', title: 'Inserisci il contatore {#}', onclick: () => insert('{#}') }, '# contatore'),
    ...state.generators.map((g) => h('button', { type: 'button', class: 'chip generator', title: `Inserisci il generatore {@${g.name}}`, onclick: () => insert(`{@${g.name}}`) }, `@${g.name}`)),
  );
}

// ------------------------------------------------------------- panel

function renderProps(): void {
  syncers = [];
  refreshValue = null;
  const f = selectedField();
  if (!f) {
    propsEl.replaceChildren(
      h('p', { class: 'muted hint' }, 'Seleziona una zona sulla pagina o nell’elenco per modificarla. Trascina per spostarla, usa le maniglie per ridimensionarla, frecce per spostamenti fini (Maiusc = 5 mm), Canc per eliminarla.'),
    );
    return;
  }
  const content = textInput(f, (x) => x.content, (x, v) => (x.content = v), true) as HTMLTextAreaElement;
  const pageOptions = state.slots.map((s, i) => [s.id, `Pagina ${i + 1}`] as [string, string]);
  const copyTo = h(
    'select',
    {
      title: 'Crea una copia della zona, nella stessa posizione, su un’altra pagina',
      onchange: (e: Event) => {
        const target = (e.target as HTMLSelectElement).value;
        if (!target) return;
        const copy = cloneField(f, target);
        state.fields.push(copy);
        state.selectedId = copy.id;
        state.slotId = target;
        notify('fields', 'selection', 'view');
      },
    },
    h('option', { value: '' }, 'Copia su…'),
    ...pageOptions.filter(([id]) => id !== f.slot).map(([id, label]) => h('option', { value: id }, label)),
  );

  const sections: Node[] = [
    h('div', { class: 'props-head' },
      textInput(f, (x) => x.name, (x, v) => (x.name = v)),
      h('button', { type: 'button', title: 'Duplica (stessa pagina)', onclick: () => {
        const copy = cloneField(f);
        state.fields.push(copy);
        state.selectedId = copy.id;
        notify('fields', 'selection');
      } }, '⧉'),
      h('button', { type: 'button', class: 'danger', title: 'Elimina zona', onclick: () => {
        state.fields = state.fields.filter((x) => x !== f);
        state.selectedId = null;
        notify('fields', 'selection');
      } }, '🗑'),
    ),
    h('fieldset', {}, h('legend', {}, 'Contenuto'),
      content,
      h('div', { class: 'content-tools' },
        h('button', {
          type: 'button',
          class: 'btn small',
          title: 'Trasforma il segnaposto sotto il cursore (o inseriscine uno nuovo) con filtri guidati',
          onclick: () => openTransformDialog(f, content, changed),
        }, 'ƒx Trasforma'),
      ),
      valueLine(f),
      columnPicker(f, content),
      syntaxGuide(),
    ),
    h('fieldset', {}, h('legend', {}, 'Contatore {#}'),
      h('div', { class: 'grid3' },
        row('Inizio', numberInput(f, (x) => x.counter.start, (x, v) => (x.counter.start = Math.round(v)), { step: 1 })),
        row('Passo', numberInput(f, (x) => x.counter.step, (x, v) => (x.counter.step = Math.round(v)), { step: 1 })),
        row('Cifre', numberInput(f, (x) => x.counter.digits, (x, v) => (x.counter.digits = Math.max(0, Math.round(v))), { step: 1, min: 0, max: 20 })),
      ),
    ),
  ];

  if (f.type === 'text') sections.push(textSection(f));
  else sections.push(barcodeSection(f));

  sections.push(
    h('fieldset', {}, h('legend', {}, 'Posizione (mm)'),
      h('div', { class: 'grid2' },
        row('X', mmInput(f, 'x')),
        row('Y', mmInput(f, 'y')),
        row('Larghezza', mmInput(f, 'w', 0.5)),
        row('Altezza', mmInput(f, 'h', 0.5)),
      ),
      h('div', { class: 'grid2' },
        row('Rotazione', select<Rotation>(f, [[0, '0°'], [90, '90° ↺'], [180, '180°'], [270, '270° ↻']], (x) => x.rotation, (x, v) => (x.rotation = v))),
        pageOptions.length > 1
          ? row('Pagina', select(f, pageOptions, (x) => x.slot, (x, v) => {
              x.slot = v;
              state.slotId = v;
              notify('view');
            }), copyTo)
          : h('span'),
      ),
      row('Margine interno (mm)', numberInput(f, (x) => x.margin / MM, (x, v) => (x.margin = Math.max(0, v) * MM), { min: 0 })),
      checkbox(f, 'Fondo bianco (bianco carta sotto la zona)', (x) => x.whiteBackground, (x, v) => (x.whiteBackground = v)),
    ),
  );
  propsEl.replaceChildren(...sections);
}

function textSection(f: TextField): HTMLElement {
  const fontOptions: Array<[string, string]> = [
    ...Object.keys(STANDARD_FONTS).map((n) => [n, n] as [string, string]),
    ...state.fonts.map((ft) => [ft.name, `${ft.name} (caricato)`] as [string, string]),
  ];
  const t = (x: Field) => x as TextField;
  return h('fieldset', {}, h('legend', {}, 'Testo'),
    row('Font', select(f, fontOptions, (x) => t(x).font, (x, v) => (t(x).font = v))),
    h('div', { class: 'grid2' },
      row('Corpo (pt)', numberInput(f, (x) => t(x).size, (x, v) => (t(x).size = Math.max(1, v)), { step: 0.5, min: 1 })),
      row('Interlinea', numberInput(f, (x) => t(x).lineHeight, (x, v) => (t(x).lineHeight = Math.max(0.5, v)), { step: 0.05, min: 0.5 })),
    ),
    row('Colore', colorControls(f)),
    row('Allineamento',
      segmented(f, [['left', '⯇', 'Sinistra'], ['center', '≡', 'Centro'], ['right', '⯈', 'Destra']], (x) => t(x).align, (x, v) => (t(x).align = v)),
      segmented(f, [['top', '⯅', 'In alto'], ['middle', '◆', 'In mezzo'], ['bottom', '⯆', 'In basso']], (x) => t(x).valign, (x, v) => (t(x).valign = v)),
    ),
    checkbox(f, 'A capo automatico', (x) => t(x).wrap, (x, v) => (t(x).wrap = v)),
    checkbox(f, 'Riduci il corpo se il testo non entra', (x) => t(x).shrink, (x, v) => (t(x).shrink = v)),
  );
}

function barcodeSection(f: BarcodeField): HTMLElement {
  const b = (x: Field) => x as BarcodeField;
  const linear = !SYMBOLOGIES[f.symbology]?.twoD;
  return h('fieldset', {}, h('legend', {}, 'Codice'),
    row('Tipo', select(f, Object.entries(SYMBOLOGIES).map(([id, s]) => [id, s.label] as [string, string]), (x) => b(x).symbology, (x, v) => {
      b(x).symbology = v;
      renderProps();
    })),
    row('Colore', colorControls(f)),
    linear ? checkbox(f, 'Testo leggibile sotto il codice', (x) => b(x).showText, (x, v) => (b(x).showText = v)) : null,
    f.symbology === 'qrcode'
      ? row('Correzione errore', select(f, [['L', 'L (7%)'], ['M', 'M (15%)'], ['Q', 'Q (25%)'], ['H', 'H (30%)']], (x) => b(x).ecLevel, (x, v) => (b(x).ecLevel = v)))
      : null,
  ) as HTMLElement;
}

const round = (v: number) => Math.round(v * 100) / 100;
const clampPct = (v: number) => Math.min(100, Math.max(0, v));

export function initProps(): void {
  on(['fields', 'selection', 'composition'], renderList);
  on(['selection', 'fonts', 'data', 'composition', 'generators'], renderProps);
  on(['fields', 'geometry'], () => syncers.forEach((s) => s()));
  // The value depends on the content (fields) and on the preview record (view).
  on(['fields', 'view'], () => refreshValue?.());
  const add = (type: Field['type']) => {
    const slot = currentSlot();
    if (!slot) return;
    const f = createField(type, slot);
    state.fields.push(f);
    state.selectedId = f.id;
    notify('fields', 'selection');
  };
  $('#add-text').addEventListener('click', () => add('text'));
  $('#add-barcode').addEventListener('click', () => add('barcode'));
  renderList();
  renderProps();
}
