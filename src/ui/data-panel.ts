import { isSpreadsheet } from '../core/data';
import { clearData, loadData } from './actions';
import { $, errorMessage, h, toast } from './dom';
import { notify, on, setSourceHeader, state } from './state';

const panel = $('#data-panel');
const PREVIEW_ROWS = 200;

/** Same file input as the toolbar "Dati" button: one import path. */
const chooseFile = () => ($('#in-data') as HTMLInputElement).click();

function render(): void {
  const src = state.source;
  const data = state.data;
  if (!src || !data) {
    panel.replaceChildren(
      h('div', { class: 'data-empty' },
        h('button', { type: 'button', class: 'btn small', onclick: chooseFile }, '＋ Carica database'),
        h('span', { class: 'muted small' }, 'Excel, CSV o TXT · facoltativo'),
      ),
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
      h('button', { type: 'button', class: 'link', onclick: chooseFile, title: 'Carica un altro file al posto di questo' }, 'Sostituisci'),
      h('button', { type: 'button', class: 'link danger', onclick: clearData, 'aria-label': 'Rimuovi il database', title: 'Rimuovi il database (generatori e zone restano)' }, 'Rimuovi'),
    ),
    h('p', { class: 'muted small data-size' }, `${data.rows.length} ${data.rows.length === 1 ? 'riga' : 'righe'} · ${data.columns.length} ${data.columns.length === 1 ? 'colonna' : 'colonne'}`),
    h('div', { class: 'data-opts' },
      sheetSelect ? h('label', { class: 'sheet' }, h('span', { class: 'muted small' }, 'Foglio'), sheetSelect) : null,
      h('label', { class: 'check' }, header, 'Prima riga = intestazioni'),
    ),
    h('div', { class: 'table-wrap' }, table),
    data.rows.length > PREVIEW_ROWS ? h('p', { class: 'muted small' }, `Anteprima delle prime ${PREVIEW_ROWS} righe.`) : '',
  );
  panel.querySelector('tr.current')?.scrollIntoView({ block: 'nearest' });
}

export function initDataPanel(): void {
  on(['data'], render);
  render();
}
