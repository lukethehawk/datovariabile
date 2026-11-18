/**
 * Collapsible sections of the right column (Dati variabili, Generazione PDF, Risorse).
 * Open/closed state is a per-browser preference (localStorage), never part of the project.
 * A closed section still shows a short summary and a warning sign if it needs attention.
 */
export type SectionId = 'data' | 'output' | 'resources';

const STORAGE_KEY = 'datovariabile.sezioni';
const DEFAULT_OPEN: Record<SectionId, boolean> = { data: true, output: true, resources: false };

interface Section {
  toggle: HTMLButtonElement;
  body: HTMLElement;
  meta: HTMLElement;
  alert: HTMLElement;
}

const sections = new Map<SectionId, Section>();

function stored(): Partial<Record<SectionId, boolean>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' ? (value as Partial<Record<SectionId, boolean>>) : {};
  } catch {
    return {}; // storage disabled or corrupt: defaults
  }
}

function persist(): void {
  const value = Object.fromEntries([...sections].map(([id, s]) => [id, s.toggle.getAttribute('aria-expanded') === 'true']));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Not saved (private mode, quota): the sections still work for this session.
  }
}

function apply(s: Section, open: boolean): void {
  s.toggle.setAttribute('aria-expanded', String(open));
  s.body.hidden = !open;
}

export function initSections(): void {
  const saved = stored();
  for (const el of document.querySelectorAll<HTMLElement>('[data-section]')) {
    const id = el.dataset.section as SectionId;
    const s: Section = {
      toggle: el.querySelector<HTMLButtonElement>('.section-toggle')!,
      body: el.querySelector<HTMLElement>('.section-body')!,
      meta: el.querySelector<HTMLElement>('.section-meta')!,
      alert: el.querySelector<HTMLElement>('.section-alert')!,
    };
    sections.set(id, s);
    apply(s, typeof saved[id] === 'boolean' ? saved[id] : DEFAULT_OPEN[id]);
    s.toggle.addEventListener('click', () => {
      apply(s, s.toggle.getAttribute('aria-expanded') !== 'true');
      persist();
    });
  }
  // Info buttons: the tip is shown on hover/focus by CSS; screen readers read it from the label.
  // Escape hides it until the pointer leaves or focus moves (WCAG 1.4.13, dismissible).
  for (const info of document.querySelectorAll<HTMLElement>('.info[data-tip]')) {
    info.setAttribute('aria-label', `Informazioni: ${info.dataset.tip}`);
    const reset = () => info.removeAttribute('data-dismissed');
    info.addEventListener('pointerleave', reset);
    info.addEventListener('blur', reset);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const info of document.querySelectorAll<HTMLElement>('.info[data-tip]:hover, .info[data-tip]:focus')) info.setAttribute('data-dismissed', '');
  });
}

/** Opens a section without changing the stored preference (e.g. to show generation progress). */
export function revealSection(id: SectionId): void {
  const s = sections.get(id);
  if (s) apply(s, true);
}

/** Short summary shown next to the title while the section is closed. */
export function setSectionMeta(id: SectionId, text: string): void {
  const s = sections.get(id);
  if (s) s.meta.textContent = text;
}

/** Warning shown on the header while the section is closed; null removes it. */
export function setSectionAlert(id: SectionId, message: string | null): void {
  const s = sections.get(id);
  if (!s) return;
  s.alert.hidden = !message;
  s.alert.title = message ?? '';
  s.alert.querySelector('.sr-only')!.textContent = message ? `Attenzione: ${message}` : '';
}
