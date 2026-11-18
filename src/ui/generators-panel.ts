import { newId } from '../core/composition';
import {
  DATE_FORMATS,
  DEFAULT_LETTERS,
  DEFAULT_TIME_ZONE,
  generatorExamples,
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
import { notify, on, recordCount, state } from './state';

/**
 * "Generatori di dati": numbering, unique codes and date/time without a data file.
 * Fields use them as {@Nome} (chips in the field panel); one value per record, shared by all fields.
 */
const panel = $('#generators-panel');
let openId: string | null = null;

const TYPE_LABEL: Record<DataGenerator['type'], string> = { numbering: 'Numerazione', unique: 'Codice univoco', datetime: 'Data/Ora' };
const ALPHABET_LABEL: Array<[keyof typeof UNIQUE_ALPHABETS, string]> = [
  ['safe', 'Lettere e numeri, senza ambigui (0/O, 1/I/L)'],
  ['alnum', 'Lettere e numeri'],
  ['digits', 'Solo numeri'],
  ['letters', 'Solo lettere'],
  ['safeLetters', 'Solo lettere, senza ambigui (I/L/O)'],
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
  const style = choice(g.style, [['number', 'Numerica (FT-000001)'], ['letters', 'Alfabetica (A, B … Z, AA)'], ['lettersNumber', 'Lettere + numero (A001 … A999, B001)']], (v) => {
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
  const length = int(g.length, (n) => changeSeries({ length: n }, () => (length.value = String(g.length))), 1);
  const capacity = uniqueCapacity(g);
  const records = Math.max(1, recordCount());
  const odds = capacity / records;
  const fmt = (n: number) => (n >= 1e15 ? n.toExponential(1).replace('e+', ' × 10^') : Math.floor(n).toLocaleString('it-IT'));
  const tooMany = records > uniqueMaxRecords(g);
  return [
    row('Caratteri', alphabet),
    h('div', { class: 'grid2' }, row('Lunghezza', length), h('span')),
    h('p', { class: `small ${tooMany ? 'error' : 'muted'}` },
      tooMany
        ? `Troppi record (${records}): con ${g.length} caratteri se ne possono usare al massimo ${fmt(uniqueMaxRecords(g))}. Aumenta la lunghezza.`
        : `Combinazioni: ${fmt(capacity)} · con ${records} record, indovinare un codice valido a caso riesce 1 volta su ${fmt(odds)}${odds < 1e6 ? ' (codici facili da indovinare: aumenta la lunghezza se hanno un valore)' : ''}.`,
    ),
    h('button', {
      type: 'button',
      class: 'btn small',
      title: 'Crea una nuova serie di codici (nuova chiave): i codici attuali non saranno più riproducibili',
      onclick: () => {
        if (confirm(`Creare una nuova serie per "${g.name}"? Tutti i codici cambieranno e quelli attuali non saranno più riproducibili.`)) set(g, { key: newUniqueKey() });
      },
    }, 'Nuova serie'),
  ];
}

function dateControls(g: DateTimeGenerator): Node[] {
  const out: Node[] = [
    row('Data e ora', choice(g.mode, [['job', 'del momento in cui si crea il PDF'], ['fixed', 'fissata nel progetto']], (mode) => set(g, { mode }))),
    row('Formato', choice(g.format, DATE_FORMATS, (format) => set(g, { format }))),
  ];
  if (g.mode === 'fixed') {
    const el = h('input', { type: 'datetime-local', value: g.fixed, step: 60 });
    el.addEventListener('change', () => el.value && set(g, { fixed: el.value.slice(0, 16) }));
    out.push(row('Data fissata', el));
  } else {
    out.push(
      row('Fuso orario', text(g.timeZone, (timeZone) => set(g, { timeZone: timeZone.trim() || DEFAULT_TIME_ZONE }))),
      h('button', { type: 'button', class: 'btn small', title: 'L’anteprima mostra un’ora di esempio: il PDF userà quella della generazione', onclick: () => ((state.previewNow = Date.now()), changed()) }, 'Aggiorna ora di esempio'),
    );
  }
  return out;
}

function card(g: DataGenerator): HTMLElement {
  const users = usedBy(g);
  const examples = generatorExamples(g, 3, state.previewNow);
  const pending = g.type === 'datetime' && g.mode === 'job';
  const name = text(g.name, () => rename(g, name), { title: 'Nome usato nelle zone come {@Nome}' });
  const controls = g.type === 'numbering' ? numberingControls(g) : g.type === 'unique' ? uniqueControls(g) : dateControls(g);
  const details = h(
    'details',
    { class: 'gen', open: g.id === openId },
    h('summary', {},
      h('strong', {}, `@${g.name}`),
      h('span', { class: 'muted small' }, ` ${TYPE_LABEL[g.type]} · ${users.length ? `in ${users.length} ${users.length === 1 ? 'zona' : 'zone'}` : 'non usato'}`),
    ),
    row('Nome', name),
    ...controls,
    h('div', { class: 'grid2' }, row('Prefisso', text(g.prefix, (prefix) => set(g, { prefix }))), row('Suffisso', text(g.suffix, (suffix) => set(g, { suffix })))),
    h('p', { class: 'small gen-example' }, pending ? 'Esempio (ora attuale, il PDF userà quella di creazione): ' : 'Esempi: ', h('code', {}, examples.join(' · '))),
    h('button', {
      type: 'button',
      class: 'link danger',
      disabled: users.length > 0,
      title: users.length ? `Usato da: ${users.join(', ')}` : 'Elimina il generatore',
      onclick: () => remove(g),
    }, 'Elimina'),
  );
  details.addEventListener('toggle', () => {
    if (details.open) openId = g.id;
    else if (openId === g.id) openId = null;
  });
  return details;
}

function render(): void {
  const add = h(
    'select',
    { title: 'Crea un generatore di dati' },
    h('option', { value: '' }, '＋ Nuovo generatore…'),
    h('option', { value: 'numbering' }, 'Numerazione (FT-000001, A001, AA)'),
    h('option', { value: 'unique' }, 'Codice univoco (gift card, ticket)'),
    h('option', { value: 'datetime' }, 'Data/Ora'),
  );
  add.addEventListener('change', () => add.value && create(add.value as DataGenerator['type']));
  panel.replaceChildren(
    ...(state.generators.length
      ? state.generators.map(card)
      : [h('p', { class: 'muted hint' }, 'Numeri, codici univoci e date senza file dati: un valore per record, uguale in tutte le zone che lo usano (anche fronte e retro).')]),
    add,
  );
}

export function initGeneratorsPanel(): void {
  on(['generators', 'data', 'output'], render);
  // Field contents decide "used in N zones" and whether deletion is allowed.
  on(['fields'], render);
  render();
}
