import { compileFilters, FILTERS, type FilterDef } from '../core/filters';
import { columnRef, contentProblem, parseContent, type PlaceholderNode, type Source } from '../core/placeholders';
import type { Field } from '../core/types';
import { h } from './dom';
import { state } from './state';
import { previewValue } from './value-preview';

/**
 * "ƒx Trasforma": builds a placeholder with an ordered chain of filters, described in Italian, with a
 * preview on the current record. If the cursor is inside a valid placeholder the dialog opens with it
 * and replaces it; otherwise it inserts at the cursor. Everything goes through the core parser,
 * serializer and compiler (docs/SPECIFICA_FILTRI.md §11): no second syntax here.
 */

interface Step {
  name: string;
  args: string[];
}

const DEFAULT_ARGS: Record<string, string[]> = {
  left: ['4'],
  right: ['4'],
  mid: ['1', '4'],
  replace: ['-', ''],
  prefix: [''],
  suffix: [''],
  padleft: ['8', '0'],
  padright: ['8', ' '],
};

const sourceKey = (s: Source) => (s.kind === 'counter' ? '#' : s.kind === 'generator' ? `@${s.name.toLowerCase()}` : `col:${s.name}`);

function sourceText(s: Source): string {
  if (s.kind === 'counter') return '#';
  if (s.kind === 'generator') return `@${s.name}`;
  return columnRef(s.name);
}

function argText(def: FilterDef, index: number, value: string): string {
  const type = def.params[index].type;
  return type === 'int' || type === 'pos' ? value.trim() : JSON.stringify(value);
}

/** The placeholder text for a source and a chain of steps. */
function buildToken(source: Source, steps: Step[]): string {
  const filters = steps.map((s) => {
    const def = FILTERS[s.name];
    return `|${s.name}${s.args.map((a, i) => `:${argText(def, i, a)}`).join('')}`;
  });
  return `{${sourceText(source)}${filters.join('')}}`;
}

/** Placeholder of `content` around the caret (strictly inside, or exactly selected). */
function placeholderAt(content: string, start: number, end: number): PlaceholderNode | null {
  for (const n of parseContent(content).nodes) {
    if (n.type !== 'placeholder') continue;
    if ((start === n.start && end === n.end) || (start === end && start > n.start && start < n.end)) return n;
  }
  return null;
}

export function openTransformDialog(field: Field, target: HTMLTextAreaElement, onApply: () => void): void {
  const selStart = target.selectionStart ?? target.value.length;
  const selEnd = target.selectionEnd ?? selStart;
  const found = placeholderAt(target.value, selStart, selEnd);
  // Edit only a placeholder whose source and filters are valid (unknown filter or wrong arity → insert a new one).
  let problem = found?.error ?? null;
  if (found && !problem) {
    try {
      compileFilters(found.filters);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }
  const editing = found && !problem && found.source ? found : null;
  let replaceRange: [number, number] = editing ? [editing.start, editing.end] : found ? [found.end, found.end] : [selStart, selEnd];
  let applied = false;

  // Sources offered: columns, counter, generators (the edited one first if it no longer exists).
  const sources: Array<{ source: Source; label: string; group: string }> = [
    ...(state.data?.columns ?? []).map((name) => ({ source: { kind: 'column', name } as Source, label: name, group: 'Colonne' })),
    { source: { kind: 'counter' }, label: '# contatore della zona', group: 'Contatore' },
    ...state.generators.map((g) => ({ source: { kind: 'generator', name: g.name } as Source, label: `@${g.name}`, group: 'Generatori' })),
  ];
  if (editing?.source && !sources.some((s) => sourceKey(s.source) === sourceKey(editing.source!))) {
    sources.unshift({ source: editing.source, label: `${sourceText(editing.source)} (non trovata)`, group: 'Attuale' });
  }
  let source: Source = editing?.source ?? sources[0].source;
  const steps: Step[] = editing ? editing.filters.map((f) => ({ name: f.name, args: f.args.map((a) => a.text) })) : [];

  const sourceSelect = h('select', { 'aria-label': 'Valore di partenza' });
  for (const group of [...new Set(sources.map((s) => s.group))]) {
    sourceSelect.append(
      h('optgroup', { label: group }, ...sources.filter((s) => s.group === group).map((s) => h('option', { value: sourceKey(s.source), selected: sourceKey(s.source) === sourceKey(source) }, s.label))),
    );
  }
  sourceSelect.addEventListener('change', () => {
    source = sources.find((s) => sourceKey(s.source) === sourceSelect.value)!.source;
    refresh();
  });

  const list = h('ol', { class: 'fx-steps' });
  const formula = h('code', { class: 'fx-formula' });
  const original = h('span', { class: 'fx-value' });
  const result = h('span', { class: 'fx-value' });
  const message = h('p', { class: 'fx-message small', role: 'status' });
  const apply = h('button', { type: 'submit', class: 'btn primary' }, editing ? 'Sostituisci' : 'Inserisci');

  const filterOptions = Object.entries(FILTERS).map(([name, def]) => [name, `${def.label} (${name})`] as const);

  function stepRow(step: Step, index: number): HTMLElement {
    const def = FILTERS[step.name];
    const select = h('select', { 'aria-label': `Trasformazione ${index + 1}` }, ...filterOptions.map(([name, label]) => h('option', { value: name, selected: name === step.name }, label)));
    select.addEventListener('change', () => {
      step.name = select.value;
      step.args = [...(DEFAULT_ARGS[step.name] ?? [])];
      renderSteps();
    });
    const inputs = def.params.map((p, i) => {
      const numeric = p.type === 'int' || p.type === 'pos';
      const input = h('input', {
        type: numeric ? 'number' : 'text',
        min: numeric ? (p.type === 'pos' ? 1 : 0) : undefined,
        step: numeric ? 1 : undefined,
        maxlength: p.type === 'char' ? 2 : undefined,
        value: step.args[i] ?? '',
        'aria-label': `${def.label}: ${p.label}`,
      });
      input.addEventListener('input', () => {
        step.args[i] = input.value;
        refresh();
      });
      return h('label', { class: 'fx-arg' }, h('span', {}, p.label), input);
    });
    const move = (to: number) => {
      steps.splice(index, 1);
      steps.splice(to, 0, step);
      renderSteps();
    };
    const button = (label: string, title: string, fn: () => void, disabled = false) =>
      h('button', { type: 'button', class: 'link', title, 'aria-label': `${title} (${def.label})`, disabled, onclick: fn }, label);
    return h('li', {},
      h('div', { class: 'fx-step-head' },
        select,
        button('↑', 'Sposta prima', () => move(index - 1), index === 0),
        button('↓', 'Sposta dopo', () => move(index + 1), index === steps.length - 1),
        button('✕', 'Rimuovi', () => {
          steps.splice(index, 1);
          renderSteps();
        }),
      ),
      inputs.length ? h('div', { class: 'fx-args' }, ...inputs) : '',
    );
  }

  function renderSteps(): void {
    list.replaceChildren(...steps.map(stepRow));
    if (!steps.length) list.append(h('li', { class: 'muted small fx-empty' }, 'Nessuna trasformazione: aggiungine una.'));
    refresh();
  }

  function refresh(): void {
    const token = buildToken(source, steps);
    formula.textContent = token;
    const generatorNames = new Set(state.generators.map((g) => g.name.toLowerCase()));
    const problem = contentProblem(token, state.data?.columns ?? null, (n) => generatorNames.has(n.toLowerCase()));
    const before = previewValue(`{${sourceText(source)}}`, field.counter);
    original.textContent = before.error ?? JSON.stringify(before.value);
    const after = previewValue(token, field.counter);
    result.textContent = problem ?? after.error ?? JSON.stringify(after.value);
    result.classList.toggle('error', Boolean(problem ?? after.error));
    message.textContent = after.warning ?? (after.value === '' ? 'Il risultato è vuoto per questo record.' : '');
    message.classList.toggle('warn', Boolean(after.warning || after.value === ''));
    apply.disabled = Boolean(problem);
  }

  const form = h('form', { method: 'dialog' },
    h('h2', {}, 'ƒx Trasforma'),
    h('label', { class: 'row' }, h('span', {}, 'Valore di partenza'), sourceSelect),
    h('div', { class: 'fx-chain' },
      h('span', { class: 'small muted' }, 'Trasformazioni, applicate in ordine'),
      list,
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          steps.push({ name: 'right', args: [...DEFAULT_ARGS.right] });
          renderSteps();
          (list.lastElementChild?.querySelector('select') as HTMLSelectElement | null)?.focus();
        },
      }, '＋ Aggiungi trasformazione'),
    ),
    h('div', { class: 'fx-preview' },
      h('p', {}, h('span', { class: 'muted small' }, `Record ${state.record + 1} · originale: `), original),
      h('p', {}, h('span', { class: 'muted small' }, 'risultato: '), result),
      h('p', {}, h('span', { class: 'muted small' }, 'formula: '), formula),
      message,
    ),
    problem ? h('p', { class: 'small warn' }, `Il segnaposto sotto il cursore ha un errore (${problem}): ne verrà inserito uno nuovo dopo di esso.`) : '',
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Annulla'),
      apply,
    ),
  );
  const dialog = h('dialog', { class: 'fx-dialog', 'aria-label': 'Trasforma un segnaposto' }, form);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (apply.disabled) return;
    const token = buildToken(source, steps);
    const [from, to] = replaceRange;
    target.value = target.value.slice(0, from) + token + target.value.slice(to);
    field.content = target.value;
    replaceRange = [from, from + token.length];
    applied = true;
    dialog.close();
    onApply();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    // Back to the content field: after the new placeholder, or where the cursor was if nothing changed.
    target.focus();
    if (applied) target.setSelectionRange(replaceRange[1], replaceRange[1]);
    else target.setSelectionRange(selStart, selEnd);
  });
  document.body.append(dialog);
  renderSteps();
  dialog.showModal();
  sourceSelect.focus();
}
