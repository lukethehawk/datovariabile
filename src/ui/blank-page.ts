import { BLANK_LIMITS, blankPageName, blankPagePdf, blankSizeProblem, formatMm, parseMm } from '../core/blank';
import { addSource } from './actions';
import { errorMessage, h, toast } from './dom';

/** Last size used in this session: several labels of the same size are created in a row. */
let last = { width: 50, height: 30 };

/** "＋ Nuova pagina vuota": native modal dialog (Esc cancels, focus stays inside), sizes in mm. */
export function openBlankPageDialog(): void {
  const width = h('input', { type: 'text', inputmode: 'decimal', required: true, value: formatMm(last.width), 'aria-describedby': 'blank-limits' });
  const height = h('input', { type: 'text', inputmode: 'decimal', required: true, value: formatMm(last.height), 'aria-describedby': 'blank-limits' });
  const name = h('input', { type: 'text', maxlength: 80, placeholder: 'facoltativo' });
  const error = h('p', { class: 'error small', role: 'alert' });
  const create = h('button', { type: 'submit', class: 'btn primary' }, 'Crea pagina');
  const form = h('form', { method: 'dialog' },
    h('h2', {}, 'Nuova pagina vuota'),
    h('div', { class: 'grid2' },
      h('label', { class: 'row' }, h('span', {}, 'Larghezza (mm)'), width),
      h('label', { class: 'row' }, h('span', {}, 'Altezza (mm)'), height),
    ),
    h('label', { class: 'row' }, h('span', {}, 'Nome'), name),
    h('p', { id: 'blank-limits', class: 'muted small' }, `Pagina bianca senza margini, da ${BLANK_LIMITS.min} a ${BLANK_LIMITS.max} mm; decimali con la virgola (es. 50,5).`),
    error,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Annulla'),
      create,
    ),
  );
  form.addEventListener('input', () => (error.textContent = ''));
  const dialog = h('dialog', { class: 'blank-dialog', 'aria-label': 'Nuova pagina vuota' }, form);
  // Adding the page cannot be undone half-way: while it runs, a second submit, Annulla and Esc are blocked.
  let busy = false;
  dialog.addEventListener('cancel', (ev) => busy && ev.preventDefault());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const w = parseMm(width.value);
    const hh = parseMm(height.value);
    const problem = blankSizeProblem(w, hh);
    if (problem) {
      error.textContent = problem;
      (blankSizeProblem(w, BLANK_LIMITS.min) ? width : height).focus();
      return;
    }
    busy = true;
    const buttons = [...form.querySelectorAll('button')];
    for (const b of buttons) b.disabled = true;
    try {
      const fileName = blankPageName(w!, hh!, name.value);
      await addSource(fileName, await blankPagePdf(w!, hh!, fileName.replace(/\.pdf$/, '')));
      last = { width: w!, height: hh! };
      busy = false;
      dialog.close();
      toast(`${fileName.replace(/\.pdf$/, '')}: pagina aggiunta`);
    } catch (err) {
      busy = false;
      error.textContent = errorMessage(err);
      for (const b of buttons) b.disabled = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  width.select();
}
