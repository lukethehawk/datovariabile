import GenerateWorker from '../worker?worker&inline';
import type { WorkerMessage, WorkerRequest } from '../worker';
import { addFont, removeFont } from './actions';
import { $, download, errorMessage, formatBytes, h, toast } from './dom';
import { on, parsePages, recordCount, recordRange, state } from './state';

const panel = $('#output-panel');
const generateBtn = $('#btn-generate') as HTMLButtonElement;
let worker: Worker | null = null;

function render(): void {
  const n = recordCount();
  const rangeInput = (key: 'rangeFrom' | 'rangeTo', placeholder: string) => {
    const el = h('input', { type: 'number', min: 1, max: n, step: 1, placeholder, value: state[key] });
    el.addEventListener('input', () => {
      state[key] = el.value;
      renderSummary();
    });
    return el;
  };
  const pages = h('input', { type: 'text', placeholder: 'tutte', value: state.pagesSpec });
  pages.addEventListener('input', () => {
    state.pagesSpec = pages.value;
    renderSummary();
  });
  const multiPage = (state.template?.pages.length ?? 0) > 1;

  panel.replaceChildren(
    h('div', { class: 'grid2' },
      h('label', { class: 'row' }, h('span', {}, 'Dal record'), rangeInput('rangeFrom', '1')),
      h('label', { class: 'row' }, h('span', {}, 'Al record'), rangeInput('rangeTo', String(n))),
    ),
    multiPage
      ? h('label', { class: 'row' }, h('span', {}, 'Pagine della velina per record (es. 1,2)'), pages)
      : '',
    h('div', { id: 'summary', class: 'muted small' }),
    fontsSection(),
    h('div', { id: 'progress', hidden: true }, h('progress', { max: 1, value: 0 }), h('span', { class: 'small' })),
    h('div', { id: 'result' }),
  );
  renderSummary();
}

function renderSummary(): void {
  const el = panel.querySelector('#summary');
  if (!el || !state.template) {
    if (el) el.textContent = 'Carica una velina PDF per iniziare.';
    return;
  }
  try {
    const { from, to } = recordRange();
    const perRecord = parsePages(state.pagesSpec, state.template.pages.length).length;
    const records = to - from + 1;
    el.textContent = `${records} record × ${perRecord} pag. = ${records * perRecord} pagine`;
    el.classList.remove('error');
  } catch (e) {
    el.textContent = errorMessage(e);
    el.classList.add('error');
  }
}

function fontsSection(): HTMLElement {
  const input = h('input', { type: 'file', accept: '.ttf,.otf', multiple: true, hidden: true });
  input.addEventListener('change', async () => {
    for (const file of input.files ?? []) {
      try {
        addFont(file.name, new Uint8Array(await file.arrayBuffer()));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    }
    input.value = '';
  });
  return h('fieldset', {}, h('legend', {}, 'Font aggiuntivi'),
    h('p', { class: 'muted small' }, 'I font standard (Helvetica, Times, Courier) non occupano spazio nel PDF. Carica un TTF/OTF per altri caratteri o simboli non latini: viene incluso solo il sottoinsieme usato.'),
    h('ul', { class: 'fonts' },
      ...state.fonts.map((f) =>
        h('li', {}, f.name, h('button', { type: 'button', class: 'link', title: 'Rimuovi', onclick: () => removeFont(f.name) }, '✕')),
      ),
    ),
    h('label', { class: 'btn small' }, 'Carica font…', input),
  );
}

function outputName(): string {
  const base = state.template?.name.replace(/\.pdf$/i, '') ?? 'output';
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
  const t = state.template;
  if (!t) return toast('Carica prima una velina PDF', 'error');
  let request: WorkerRequest;
  try {
    const { from, to } = recordRange();
    request = {
      template: t.bytes,
      pages: t.pages,
      pageIndices: parsePages(state.pagesSpec, t.pages.length),
      fields: state.fields,
      fonts: state.fonts,
      data: state.data,
      from,
      to,
    };
  } catch (e) {
    return toast(errorMessage(e), 'error');
  }

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
    if (msg.type === 'error') {
      result.replaceChildren(h('p', { class: 'error' }, msg.message));
      return;
    }
    const name = outputName();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    download(msg.bytes, name, 'application/pdf');
    result.replaceChildren(
      h('p', { class: 'ok' }, `✔ ${name}: ${msg.pageCount} pagine, ${formatBytes(msg.bytes.length)} (velina ${formatBytes(t.bytes.length)}) in ${seconds} s`),
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
  on(['template', 'data', 'fonts', 'output'], render);
  generateBtn.addEventListener('click', () => void runGeneration());
  render();
}
