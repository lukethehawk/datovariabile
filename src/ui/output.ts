import GenerateWorker from '../worker?worker&inline';
import type { WorkerMessage, WorkerRequest } from '../worker';
import { revealSection, setSectionAlert, setSectionMeta } from './sections';
import { activeComposition } from '../core/composition';
import { generationIssue } from '../core/generators';
import type { Field, Slot } from '../core/types';
import { $, download, errorMessage, formatBytes, h, toast } from './dom';
import { enabledSlots, jobSources, notify, on, recordCount, recordRange, slotPage, state } from './state';

/**
 * What "Crea PDF" would generate now, or the reason it cannot (thrown, Italian). The summary and
 * runGeneration both call this: same pages, same fields, same checks.
 */
function plannedJob(): { from: number; to: number; slots: Slot[]; fields: Field[] } {
  const { from, to } = recordRange();
  const { slots, fields } = activeComposition(state.slots, state.fields);
  if (!slots.length) throw new Error('Tutte le pagine sono escluse: attivane almeno una');
  const issue = generationIssue(state.generators, fields, to + 1);
  if (issue) throw new Error(issue);
  return { from, to, slots, fields };
}

const panel = $('#output-panel');
const generateBtn = $('#btn-generate') as HTMLButtonElement;
let worker: Worker | null = null;

function render(): void {
  const rangeInput = (key: 'rangeFrom' | 'rangeTo', placeholder: string) => {
    const el = h('input', { type: 'number', min: 1, step: 1, placeholder, value: state[key], 'data-range': key });
    el.addEventListener('input', () => {
      state[key] = el.value;
      renderSummary();
    });
    return el;
  };

  panel.replaceChildren(
    h('div', { id: 'records-slot' }),
    h('div', { class: 'grid2' },
      h('label', { class: 'row' }, h('span', {}, 'Dal record'), rangeInput('rangeFrom', '1')),
      h('label', { class: 'row' }, h('span', {}, 'Al record'), rangeInput('rangeTo', '')),
    ),
    h('p', { id: 'summary', class: 'summary', role: 'status' }),
    h('div', { id: 'progress', hidden: true }, h('progress', { max: 1, value: 0 }), h('span', { class: 'small' })),
    h('div', { id: 'result' }),
  );
  syncControls();
}

/** Record count row and range limits; safe while a job runs (progress/result stay attached). */
function syncControls(): void {
  const n = recordCount();
  panel.querySelector('#records-slot')?.replaceChildren(recordsRow(n));
  for (const el of panel.querySelectorAll<HTMLInputElement>('input[data-range]')) {
    el.max = String(n);
    if (el.dataset.range === 'rangeTo') el.placeholder = String(n);
  }
  renderSummary();
}

/** With a data file the count comes from its rows (read-only); otherwise it is typed (state.manualCount, kept while data is loaded). */
function recordsRow(n: number): HTMLElement {
  if (state.data) {
    return h('div', { class: 'row records' },
      h('span', { id: 'records-label' }, 'Record disponibili'),
      h('output', { class: 'records-value', 'aria-labelledby': 'records-label' }, String(n), h('span', { class: 'muted small' }, ' righe del database')),
    );
  }
  const el = h('input', { type: 'number', min: 1, step: 1, value: state.manualCount });
  el.addEventListener('change', () => {
    state.manualCount = Math.max(1, Math.floor(el.valueAsNumber || 1));
    el.value = String(state.manualCount);
    notify('output', 'view');
  });
  return h('label', { class: 'row records' }, h('span', {}, 'Record da generare'), el);
}

function renderSummary(): void {
  const el = panel.querySelector('#summary');
  if (!el) return;
  let problem: string | null = null;
  let pages = '';
  if (!state.slots.length) {
    el.textContent = 'Carica un file grafico (PDF, JPG o PNG) o crea una pagina vuota per iniziare.';
    el.classList.remove('error');
  } else {
    try {
      const { from, to, slots } = plannedJob();
      const perRecord = slots.length;
      const records = to - from + 1;
      pages = `${records * perRecord} ${records * perRecord === 1 ? 'pagina' : 'pagine'}`;
      const partial = records < recordCount() ? ` (record ${from + 1}–${to + 1} di ${recordCount()})` : '';
      el.textContent = `${records} record × ${perRecord} ${perRecord === 1 ? 'pagina' : 'pagine'} = ${pages} PDF${partial}`;
      el.classList.remove('error');
    } catch (e) {
      problem = errorMessage(e);
      el.textContent = problem;
      el.classList.add('error');
    }
  }
  setSectionAlert('output', problem);
  setSectionMeta('output', pages);
}

function outputName(): string {
  const first = enabledSlots()[0];
  const base = first ? state.sources.find((s) => s.id === first.sourceId)!.name.replace(/\.[^.]+$/, '') : 'output';
  return `${base}_dati.pdf`;
}

async function runGeneration(): Promise<void> {
  if (worker) {
    worker.terminate();
    worker = null;
    finish();
    toast('Generazione annullata');
    return;
  }
  if (!state.slots.length) return toast('Carica prima un file grafico (PDF, JPG o PNG) o crea una pagina vuota', 'error');
  // Progress, result and warnings live in this section: make sure they are visible.
  revealSection('output');
  let request: WorkerRequest;
  try {
    const { from, to, slots, fields } = plannedJob();
    // The instant of "date of generation" generators: taken once, here, for the whole PDF.
    request = { sources: jobSources(), pages: slots.map(slotPage), fields, fonts: state.fonts, data: state.data, generators: state.generators, now: Date.now(), from, to };
  } catch (e) {
    return toast(errorMessage(e), 'error');
  }
  const sourceBytes = request.sources!.reduce((n, s) => n + s.bytes.length, 0);

  const progress = panel.querySelector<HTMLElement>('#progress')!;
  const bar = progress.querySelector('progress')!;
  const label = progress.querySelector('span')!;
  const result = panel.querySelector<HTMLElement>('#result')!;
  progress.hidden = false;
  bar.value = 0;
  label.textContent = 'Preparazione…';
  result.replaceChildren();
  generateBtn.textContent = 'Annulla';
  generateBtn.classList.add('busy');
  const started = performance.now();

  worker = new GenerateWorker();
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      bar.value = msg.done / msg.total;
      label.textContent = msg.done === msg.total ? 'Salvataggio PDF…' : `${msg.done} / ${msg.total} record`;
      return;
    }
    worker?.terminate();
    worker = null;
    finish();
    // The section may have been closed while the job ran: the result or error must be seen.
    revealSection('output');
    if (msg.type === 'error') {
      result.replaceChildren(h('p', { class: 'error' }, msg.message));
      return;
    }
    const name = outputName();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    download(msg.bytes, name, 'application/pdf');
    result.replaceChildren(
      h('p', { class: 'ok' }, `✔ ${name}: ${msg.pageCount} pagine, ${formatBytes(msg.bytes.length)} (file grafici ${formatBytes(sourceBytes)}) in ${seconds} s`),
      h('button', { type: 'button', class: 'btn small', onclick: () => download(msg.bytes, name, 'application/pdf') }, 'Scarica di nuovo'),
      msg.warnings.length
        ? h('details', { class: 'warnings', open: true }, h('summary', {}, `${msg.warnings.length} avvisi`), h('ul', {}, ...msg.warnings.map((w) => h('li', {}, w))))
        : '',
    );
  };
  worker.onerror = (e) => {
    worker?.terminate();
    worker = null;
    finish();
    revealSection('output');
    result.replaceChildren(h('p', { class: 'error' }, e.message || 'Errore durante la generazione'));
  };
  worker.postMessage(request);
}

function finish(): void {
  panel.querySelector<HTMLElement>('#progress')!.hidden = true;
  generateBtn.textContent = 'Crea PDF';
  generateBtn.classList.remove('busy');
}

export function initOutput(): void {
  // While a job runs its progress/result elements must stay attached: refresh only the controls.
  on(['composition', 'data', 'output'], () => (worker ? syncControls() : render()));
  on(['generators', 'fields'], renderSummary);
  generateBtn.addEventListener('click', () => void runGeneration());
  render();
}
