import { newId } from '../core/composition';
import {
  DATE_FORMATS,
  DEFAULT_LETTERS,
  DEFAULT_TIME_ZONE,
  generatorExamples,
  generatorProblem,
  nameProblem,
  newUniqueKey,
  referencedGenerators,
  renameInContent,
  UNIQUE_ALPHABETS,
  uniqueCapacity,
  uniqueMaxRecords,
} from '../core/generators';
import type { DataGenerator, DateTimeGenerator, NumberingGenerator, UniqueGenerator } from '../core/types';
import { $, h, toast } from './dom';
import { setSectionAlert } from './sections';
import { notify, on, recordCount, state } from './state';

/**
 * "Dati variabili › Generatori": numbering, unique codes and date/time, with or without a data file.
 * Fields use them as {@Nome} (chips in the field panel); one value per record, shared by all fields.
 */
const panel = $('#generators-panel');
let openId: string | null = null;

const TYPE_LABEL: Record<DataGenerator['type'], string> = { numbering: 'Numerazione', unique: 'Codice univoco', datetime: 'Data/Ora' };
/** Short labels: the select must stay readable in a narrow column; the exact characters are in its tooltip. */
const ALPHABET_LABEL: Array<[keyof typeof UNIQUE_ALPHABETS, string]> = [
  ['safe', 'Lettere e cifre, senza ambigui'],
  ['alnum', 'Lettere e cifre'],
  ['digits', 'Solo cifre'],
  ['letters', 'Solo lettere'],
  ['safeLetters', 'Solo lettere, senza ambigui'],
];

function changed(): void {
  notify('generators', 'fields');
}

function usedBy(g: DataGenerator): string[] {
  return state.fields.filter((f) => referencedGenerators(f.content).some((n) => n.toLowerCase() === g.name.toLowerCase())).map((f) => f.name);
}

function uniqueName(base: string): string {
  const taken = new Set(state.generators.map((g) => g.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function todayCivil(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

function create(type: DataGenerator['type']): void {
  const base = { id: newId('g'), prefix: '', suffix: '' };
  let g: DataGenerator;
  if (type === 'numbering') {
    g = { ...base, type, name: uniqueName('Numero'), style: 'number', start: 1, step: 1, digits: 6, alphabet: DEFAULT_LETTERS, groupStart: 'A', numberMin: 1, numberMax: 999, overflow: 'grow' };
  } else if (type === 'unique') {
    g = { ...base, type, name: uniqueName('Codice'), algorithm: 'hmac-sha256-ctr-v1', key: newUniqueKey(), alphabet: UNIQUE_ALPHABETS.safe, length: 8 };
  } else {
    g = { ...base, type, name: uniqueName('Data'), mode: 'job', timeZone: DEFAULT_TIME_ZONE, fixed: todayCivil(), format: 'dd/MM/yyyy' };
  }
  state.generators = [...state.generators, g];
  openId = g.id;
  changed();
  toast(`Generatore "${g.name}" creato: inseriscilo in una zona con il pulsante @${g.name}`);
}

function remove(g: DataGenerator): void {
  const users = usedBy(g);
  if (users.length) return toast(`"${g.name}" è usato dalle zone: ${users.join(', ')}. Toglilo dalle zone prima di eliminarlo.`, 'error');
  if (g.type === 'unique' && !confirm(`Eliminare "${g.name}"? I suoi codici non saranno più riproducibili.`)) return;
  state.generators = state.generators.filter((x) => x !== g);
  changed();
}

function rename(g: DataGenerator, input: HTMLInputElement): void {
  const name = input.value;
  const problem = nameProblem(name) ?? (state.generators.some((x) => x !== g && x.name.toLowerCase() === name.toLowerCase()) ? 'esiste già un generatore con questo nome' : null);
  if (problem) {
    toast(`Nome non valido: ${problem}`, 'error');
    input.value = g.name;
    return;
  }
  for (const f of state.fields) f.content = renameInContent(f.content, g.name, name);
  g.name = name;
  changed();
}

// ---------------------------------------------------------------- controls

const row = (label: string, ...controls: Node[]) => h('label', { class: 'row' }, h('span', {}, label), ...controls);

function text(value: string, onChange: (v: string) => void, attrs: Record<string, string | number> = {}): HTMLInputElement {
  const el = h('input', { type: 'text', value, ...attrs });
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function int(value: number, onChange: (v: number) => void, min?: number): HTMLInputElement {
  const el = h('input', { type: 'number', step: 1, min, value });
  el.addEventListener('change', () => {
    if (Number.isInteger(el.valueAsNumber)) onChange(el.valueAsNumber);
    else el.value = String(value);
  });
  return el;
}

function choice<T extends string>(value: T, options: Array<[T, string]>, onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', {}, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

function set<G extends DataGenerator>(g: G, patch: Partial<G>): void {
  Object.assign(g, patch);
  changed();
}

function numberingControls(g: NumberingGenerator): Node[] {
  const style = choice(g.style, [['number', 'Numerica (000001)'], ['letters', 'Alfabetica (A … Z, AA)'], ['lettersNumber', 'Lettere + numero (A001)']], (v) => {
    const defaults: Record<NumberingGenerator['style'], Partial<NumberingGenerator>> = {
      number: { digits: 6, start: 1 },
      letters: { groupStart: 'A', overflow: 'grow' },
      lettersNumber: { groupStart: 'A', start: 1, numberMin: 1, numberMax: 999, digits: 3, overflow: 'error' },
    };
    set(g, { style: v, ...defaults[v] });
  });
  const out: Node[] = [row('Tipo', style)];
  if (g.style === 'number') {
    out.push(h('div', { class: 'grid3' }, row('Inizio', int(g.start, (start) => set(g, { start }), 0)), row('Passo', int(g.step, (step) => set(g, { step }))), row('Cifre', int(g.digits, (digits) => set(g, { digits }), 0))));
  } else {
    const group = text(g.groupStart, (groupStart) => set(g, { groupStart: groupStart.trim().toUpperCase() }), { size: 4 });
    const overflow = choice(g.overflow, [['grow', 'aggiungi una lettera (Z → AA)'], ['error', 'fermati con un errore']], (o) => set(g, { overflow: o }));
    if (g.style === 'letters') {
      out.push(h('div', { class: 'grid2' }, row('Prima lettera', group), row('Passo', int(g.step, (step) => set(g, { step })))));
    } else {
      out.push(
        h('div', { class: 'grid3' }, row('Lettera iniziale', group), row('Numero iniziale', int(g.start, (start) => set(g, { start }), 0)), row('Passo', int(g.step, (step) => set(g, { step })))),
        h('div', { class: 'grid3' }, row('Numero da', int(g.numberMin, (numberMin) => set(g, { numberMin }), 0)), row('a', int(g.numberMax, (numberMax) => set(g, { numberMax }), 0)), row('Cifre', int(g.digits, (digits) => set(g, { digits }), 0))),
      );
    }
    out.push(row('Dopo l’ultima lettera', overflow), row('Alfabeto', text(g.alphabet, (alphabet) => set(g, { alphabet: alphabet.replace(/\s/g, '') }))));
  }
  return out;
}

function uniqueControls(g: UniqueGenerator): Node[] {
  const preset = (Object.entries(UNIQUE_ALPHABETS).find(([, a]) => a === g.alphabet)?.[0] ?? 'custom') as keyof typeof UNIQUE_ALPHABETS | 'custom';
  /** Alphabet and length define the series: changing them changes every code, so ask first. */
  const changeSeries = (patch: Partial<UniqueGenerator>, revert: () => void) => {
    const before = generatorExamples(g, 2, 0).join(', ');
    const after = generatorExamples({ ...g, ...patch }, 2, 0).join(', ');
    if (usedBy(g).length && !confirm(`Cambiando questa impostazione cambiano TUTTI i codici di "${g.name}".\nPrima: ${before}…\nDopo: ${after}…\nContinuare?`)) return revert();
    set(g, patch);
  };
  const alphabet = choice<string>(preset, [...ALPHABET_LABEL, ...(preset === 'custom' ? ([['custom', 'Personalizzati']] as Array<[string, string]>) : [])], (v) =>
    changeSeries({ alphabet: UNIQUE_ALPHABETS[v as keyof typeof UNIQUE_ALPHABETS] }, () => (alphabet.value = preset)),
  );
  alphabet.title = `Caratteri usati: ${g.alphabet}`;
  const length = int(g.length, (n) => changeSeries({ length: n }, () => (length.value = String(g.length))), 1);
  const capacity = uniqueCapacity(g);
  const records = Math.max(1, recordCount());
  const odds = capacity / records;
  const fmt = (n: number) => (n >= 1e15 ? n.toExponential(1).replace('e+', ' × 10^') : Math.floor(n).toLocaleString('it-IT'));
  const tooMany = records > uniqueMaxRecords(g);
  const easy = !tooMany && odds < 1e6;
  return [
    row('Caratteri', alphabet),
    h('div', { class: 'grid2 align-end' },
      row('Lunghezza', length),
      h('button', {
        type: 'button',
        class: 'btn small',
        title: 'Crea una nuova serie di codici (nuova chiave): i codici attuali non saranno più riproducibili',
        onclick: () => {
          if (confirm(`Creare una nuova serie per "${g.name}"? Tutti i codici cambieranno e quelli attuali non saranno più riproducibili.`)) set(g, { key: newUniqueKey() });
        },
      }, 'Nuova serie'),
    ),
    h('p', { class: `small ${tooMany ? 'error' : 'muted'}` },
      tooMany
        ? `Troppi record (${records}): con ${g.length} caratteri al massimo ${fmt(uniqueMaxRecords(g))}. Aumenta la lunghezza.`
        : `Combinazioni ${fmt(capacity)} · indovinare un codice a caso: 1 su ${fmt(odds)}`,
    ),
    ...(easy ? [h('p', { class: 'small warn' }, 'Codici facili da indovinare: aumenta la lunghezza se hanno un valore.')] : []),
  ];
}

function dateControls(g: DateTimeGenerator): Node[] {
  const out: Node[] = [
    row('Data e ora', choice(g.mode, [['job', 'alla creazione del PDF'], ['fixed', 'fissata nel progetto']], (mode) => set(g, { mode }))),
    row('Formato', choice(g.format, DATE_FORMATS, (format) => set(g, { format }))),
  ];
  if (g.mode === 'fixed') {
    const el = h('input', { type: 'datetime-local', value: g.fixed, step: 60 });
    el.addEventListener('change', () => el.value && set(g, { fixed: el.value.slice(0, 16) }));
    out.push(row('Data fissata', el));
  } else {
    out.push(
      row('Fuso orario', text(g.timeZone, (timeZone) => set(g, { timeZone: timeZone.trim() || DEFAULT_TIME_ZONE }))),
      h('p', { class: 'muted small' }, 'L’anteprima usa un’ora di esempio; il PDF userà quella di creazione.'),
      h('button', { type: 'button', class: 'btn small', onclick: () => ((state.previewNow = Date.now()), changed()) }, 'Aggiorna ora di esempio'),
    );
  }
  return out;
}

/** Why the generator cannot produce values for the current records, or null. */
function problemOf(g: DataGenerator): string | null {
  const problem = generatorProblem(g);
  if (problem) return problem;
  if (g.type === 'unique' && recordCount() > uniqueMaxRecords(g)) return `troppi record per ${g.length} ${g.length === 1 ? 'carattere' : 'caratteri'}: aumenta la lunghezza`;
  return null;
}

function card(g: DataGenerator): HTMLElement {
  const users = usedBy(g);
  const problem = problemOf(g);
  const examples = problem ? [] : generatorExamples(g, 3, state.previewNow);
  const name = text(g.name, () => rename(g, name), { title: 'Nome usato nelle zone come {@Nome}' });
  const controls = g.type === 'numbering' ? numberingControls(g) : g.type === 'unique' ? uniqueControls(g) : dateControls(g);
  const details = h(
    'details',
    { class: `gen${problem ? ' has-problem' : ''}`, open: g.id === openId },
    h('summary', {},
      h('span', { class: 'gen-line' },
        h('strong', { class: 'gen-name' }, `@${g.name}`),
        h('span', { class: 'gen-type' }, TYPE_LABEL[g.type]),
        h('span', { class: 'gen-uses muted small' }, users.length ? `in ${users.length} ${users.length === 1 ? 'zona' : 'zone'}` : 'non usato'),
      ),
      problem
        ? h('span', { class: 'gen-sample error small' }, `⚠ ${problem}`)
        : h('code', { class: 'gen-sample', title: 'Primi valori' }, examples.join(' · ')),
    ),
    h('div', { class: 'gen-body' },
      row('Nome', name),
      ...controls,
      h('div', { class: 'grid2' }, row('Prefisso', text(g.prefix, (prefix) => set(g, { prefix }))), row('Suffisso', text(g.suffix, (suffix) => set(g, { suffix })))),
      h('button', {
        type: 'button',
        class: 'link danger',
        disabled: users.length > 0,
        title: users.length ? `Usato da: ${users.join(', ')}. Toglilo dalle zone per eliminarlo.` : 'Elimina il generatore',
        onclick: () => remove(g),
      }, users.length ? 'Elimina (in uso)' : 'Elimina'),
    ),
  );
  details.addEventListener('toggle', () => {
    if (details.open) openId = g.id;
    else if (openId === g.id) openId = null;
  });
  return details;
}

const NEW_TYPES: Array<[DataGenerator['type'], string, string]> = [
  ['numbering', 'Numerazione', 'FT-000001, A001, AA'],
  ['unique', 'Codice univoco', 'gift card, ticket, QR'],
  ['datetime', 'Data/Ora', 'di creazione o fissata'],
];

function addMenu(): HTMLElement {
  const menu: HTMLDetailsElement = h('details', { class: 'gen-add' },
    h('summary', { class: 'btn small' }, '＋ Nuovo generatore'),
    h('div', { class: 'gen-add-list' },
      ...NEW_TYPES.map(([type, label, hint]) =>
        h('button', { type: 'button', onclick: () => create(type) }, h('strong', {}, label), h('span', { class: 'muted small' }, hint)),
      ),
    ),
  );
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')!.focus();
  });
  return menu;
}

function render(): void {
  panel.replaceChildren(
    ...(state.generators.length ? state.generators.map(card) : [h('p', { class: 'muted small' }, 'Nessun generatore.')]),
    addMenu(),
  );
  const broken = state.generators.map((g) => [g, problemOf(g)] as const).find(([, p]) => p);
  setSectionAlert('data', broken ? `generatore "${broken[0].name}": ${broken[1]}` : null);
}

export function initGeneratorsPanel(): void {
  on(['generators', 'data', 'output'], render);
  // Field contents decide "used in N zones" and whether deletion is allowed.
  on(['fields'], render);
  render();
}
