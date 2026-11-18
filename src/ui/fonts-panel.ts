import { addFont, removeFont } from './actions';
import { $, errorMessage, h, toast } from './dom';
import { setSectionMeta } from './sections';
import { on, state } from './state';

/** "Risorse › Font aggiuntivi": TTF/OTF fonts embedded (subset) when a text field uses them. */
const panel = $('#fonts-panel');

function render(): void {
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
  panel.replaceChildren(
    state.fonts.length
      ? h('ul', { class: 'fonts' },
          ...state.fonts.map((f) =>
            h('li', {},
              h('span', { class: 'font-name', title: f.name }, f.name),
              h('button', { type: 'button', class: 'link danger', 'aria-label': `Rimuovi il font ${f.name}`, title: 'Rimuovi', onclick: () => removeFont(f.name) }, '✕'),
            ),
          ),
        )
      : h('p', { class: 'muted small' }, 'Nessun font caricato: si usano Helvetica, Times e Courier.'),
    h('button', { type: 'button', class: 'btn small', onclick: () => input.click() }, '＋ Carica font'),
    input,
  );
  setSectionMeta('resources', state.fonts.length ? `${state.fonts.length} font` : '');
}

export function initFontsPanel(): void {
  on(['fonts'], render);
  render();
}
