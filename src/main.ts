import './style.css';
import { openFile, saveProject } from './ui/actions';
import { initDataPanel } from './ui/data-panel';
import { $, errorMessage, toast } from './ui/dom';
import { initGeneratorsPanel } from './ui/generators-panel';
import { initOutput } from './ui/output';
import { initPagesPanel } from './ui/pages-panel';
import { initProps } from './ui/props';
import { notify, on, state } from './ui/state';
import { initViewer } from './ui/viewer';

async function openFiles(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    try {
      toast(await openFile(file));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }
}

function bindFileInput(selector: string): void {
  const input = $(selector) as HTMLInputElement;
  input.addEventListener('change', async () => {
    await openFiles([...(input.files ?? [])]);
    input.value = '';
  });
}

initViewer();
initPagesPanel();
initProps();
initDataPanel();
initOutput();
initGeneratorsPanel();

bindFileInput('#in-template');
bindFileInput('#in-data');
bindFileInput('#in-project');
$('#btn-save').addEventListener('click', () => {
  saveProject().then(
    (msg) => toast(msg),
    (e) => toast(errorMessage(e), 'error'),
  );
});

// Drop anywhere: PDF/JPG/PNG → velina, Excel/CSV/TXT → dati, TTF/OTF → font, .dvp.zip/.json → progetto.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (e.dataTransfer?.files.length) void openFiles([...e.dataTransfer.files]);
});

const syncToolbar = () => {
  const ready = state.slots.length > 0;
  for (const id of ['#add-text', '#add-barcode', '#btn-generate', '#btn-save']) ($(id) as HTMLButtonElement).disabled = !ready;
  $('#template-name').textContent = state.sources.map((s) => s.name).join(' + ');
};
on(['composition'], syncToolbar);
syncToolbar();

window.addEventListener('beforeunload', (e) => {
  if (state.fields.length) e.preventDefault();
});

notify('view');
