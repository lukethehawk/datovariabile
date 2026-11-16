/**
 * Composition: the ordered pages (slots) repeated for every record. A slot points
 * to a page of a source; fields belong to a slot through `Field.slot`, so the same
 * source page can appear twice with different fields and reordering keeps them.
 */
import { inspectTemplate, type JobPage } from './generate';
import { defaultLayout, inspectRaster, rasterPage, type RasterInfo } from './raster';
import type { Slot, SourceKind, TemplatePage } from './types';

/** What the editor needs to know about a source without keeping it parsed. */
export type SourceInfo = { kind: 'pdf'; pages: TemplatePage[] } | { kind: 'jpeg' | 'png'; raster: RasterInfo };

export async function inspectSource(bytes: Uint8Array, kind: SourceKind): Promise<SourceInfo> {
  return kind === 'pdf' ? { kind, pages: await inspectTemplate(bytes) } : { kind, raster: inspectRaster(bytes, kind) };
}

export function sourceKind(name: string): SourceKind | null {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.jpe?g$/i.test(name)) return 'jpeg';
  if (/\.png$/i.test(name)) return 'png';
  return null;
}

let nextId = 1;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Slots for all pages of a newly added source, appended to the composition. */
export function slotsFor(sourceId: string, info: SourceInfo): Slot[] {
  if (info.kind === 'pdf') return info.pages.map((_, page) => ({ id: newId('s'), sourceId, page, enabled: true }));
  return [{ id: newId('s'), sourceId, page: 0, enabled: true, raster: defaultLayout(info.raster) }];
}

/** Resolves a slot to the page geometry (and image placement) used by editor, preview and output. */
export function jobPage(slot: Slot, info: SourceInfo): JobPage {
  if (info.kind === 'pdf') {
    const geometry = info.pages[slot.page];
    if (!geometry) throw new Error(`la pagina ${slot.page + 1} non esiste nel PDF`);
    return { slot: slot.id, sourceId: slot.sourceId, page: slot.page, geometry };
  }
  const placed = rasterPage(info.raster, slot.raster ?? defaultLayout(info.raster));
  return { slot: slot.id, sourceId: slot.sourceId, page: 0, geometry: placed.geometry, image: { matrix: placed.matrix, clip: placed.clip } };
}
