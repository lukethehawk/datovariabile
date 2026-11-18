/**
 * Blank pages created in the app (labels with variable data only). A blank page is a tiny one-page
 * PDF built here and then handled as any loaded PDF source: same composition, preview, embedding
 * (one Form XObject for all records) and project archive (it is saved under veline/ like the others),
 * so the project format does not change.
 */
import { PDFDocument } from 'pdf-lib';

const MM = 72 / 25.4;

/**
 * Allowed size in mm. PDF readers (ISO 32000-1 Annex C, Acrobat) accept pages from 3 pt (1,06 mm)
 * to 14 400 pt (200 in = 5080 mm); 2 mm keeps a margin above the minimum and is smaller than any label.
 */
export const BLANK_LIMITS = { min: 2, max: 5080 } as const;

/** "50", "50,5", "50.25" (Italian decimal comma accepted, at most 2 decimals) → mm, or null. */
export function parseMm(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

/** Italian number for labels and inputs: 50, 50,5, 30,25 (the precision accepted by parseMm). */
export function formatMm(mm: number): string {
  return String(Math.round(mm * 100) / 100).replace('.', ',');
}

/** Why a size cannot be used (Italian), or null. */
export function blankSizeProblem(widthMm: number | null, heightMm: number | null): string | null {
  for (const [label, v] of [['La larghezza', widthMm], ["L'altezza", heightMm]] as const) {
    if (v === null || !Number.isFinite(v)) return `${label} deve essere un numero in millimetri, al massimo 2 decimali (es. 50 o 50,5)`;
    if (v < BLANK_LIMITS.min || v > BLANK_LIMITS.max) return `${label} deve stare tra ${BLANK_LIMITS.min} e ${BLANK_LIMITS.max} mm`;
  }
  return null;
}

/** File name of the blank page source: the user's name, else "Pagina vuota 50 × 30 mm". */
export function blankPageName(widthMm: number, heightMm: number, name = ''): string {
  const base = name.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').slice(0, 80).trim();
  return `${base || `Pagina vuota ${formatMm(widthMm)} × ${formatMm(heightMm)} mm`}.pdf`;
}

/**
 * One white page of exactly widthMm × heightMm (MediaBox [0 0 w h] in points, no content).
 * Deterministic bytes (no dates): the same size and name give the same file, which addSource
 * then shares instead of storing it twice.
 */
export async function blankPagePdf(widthMm: number, heightMm: number, title: string): Promise<Uint8Array> {
  const problem = blankSizeProblem(widthMm, heightMm);
  if (problem) throw new Error(problem);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.setProducer('DatoVariabile');
  doc.addPage([widthMm * MM, heightMm * MM]);
  return doc.save({ useObjectStreams: false });
}
