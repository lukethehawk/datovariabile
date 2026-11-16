import { isSpreadsheet } from '../core/data';
import { clearData, loadData } from './actions';
import { $, errorMessage, h, toast } from './dom';
import { notify, on, setSourceHeader, state } from './state';

const panel = $('#data-panel');
const PREVIEW_ROWS = 200;

function render(): void {
  const src = state.source;
  const data = state.data;
  if (!src || !data) {
    panel.replaceChildren(
      h('p', { class: 'muted hint' }, 'Carica un file Excel (.xlsx, .xls, .ods), CSV o TXT. La prima riga può contenere i nomi delle colonne. Senza dati puoi comunque numerare con il contatore {#}.'),
      h('label', { class: 'row' }, h('span', {}, 'Record da generare (senza dati)'), manualCountInput()),
    );
    return;
  }
  const sheetSelect =
    isSpreadsheet(src.name) && src.table.sheets.length > 1
      ? h(
          'select',
          {
            onchange: (e: Event) => {
              try {
                loadData(src.name, src.bytes, (e.target as HTMLSelectElement).value);
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          },
          ...src.table.sheets.map((s) => h('option', { value: s, selected: s === src.table.sheet }, s)),
        )
      : null;

  const header = h('input', { type: 'checkbox', checked: src.header });
  header.addEventListener('change', () => {
    setSourceHeader(header.checked);
    notify('data', 'fields');
  });

  const rows = data.rows.slice(0, PREVIEW_ROWS);
  const table = h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th', {}, '#'), ...data.columns.map((c) => h('th', { title: `{${c}}` }, c)))),
    h(
      'tbody',
      {},
      ...rows.map((r, i) =>
        h(
          'tr',
          {
            class: i === state.record ? 'current' : '',
            title: 'Mostra questo record in anteprima',
            onclick: () => {
              state.record = i;
              notify('view', 'data');
            },
          },
          h('td', { class: 'muted' }, String(i + 1)),
          ...data.columns.map((_, c) => h('td', {}, r[c] ?? '')),
        ),
      ),
    ),
  );

  panel.replaceChildren(
    h('div', { class: 'data-head' },
      h('strong', { class: 'file', title: src.name }, src.name),
      h('button', { type: 'button', class: 'link', onclick: clearData, title: 'Rimuovi i dati' }, '✕'),
    ),
    h('div', { class: 'data-opts' },
      sheetSelect ? h('label', {}, 'Foglio ', sheetSelect) : null,
      h('label', { class: 'check' }, header, 'Prima riga = intestazioni'),
      h('span', { class: 'muted' }, `${data.rows.length} record · ${data.columns.length} colonne`),
    ),
    h('div', { class: 'table-wrap' }, table),
    data.rows.length > PREVIEW_ROWS ? h('p', { class: 'muted small' }, `Anteprima delle prime ${PREVIEW_ROWS} righe.`) : '',
  );
  panel.querySelector('tr.current')?.scrollIntoView({ block: 'nearest' });
}

function manualCountInput(): HTMLInputElement {
  const el = h('input', { type: 'number', min: 1, step: 1, value: state.manualCount });
  el.addEventListener('change', () => {
    state.manualCount = Math.max(1, Math.floor(el.valueAsNumber || 1));
    el.value = String(state.manualCount);
    notify('output', 'view');
  });
  return el;
}

export function initDataPanel(): void {
  on(['data'], render);
  render();
}
