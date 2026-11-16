import { describe, expect, it } from 'vitest';
import { parseProject } from '../src/core/project';
import { makePdf, textField } from './helpers';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe('project files', () => {
  it('migrates version 1: pagesSpec becomes slots, fields follow every occurrence of their page', async () => {
    const pdf = await makePdf([{ kb: 1 }, { kb: 1 }, { kb: 1 }]);
    const { slot: _slot, ...field } = textField();
    const v1 = {
      app: 'DatoVariabile',
      version: 1,
      fields: [
        { ...field, id: 'a', name: 'Fronte', page: 0 },
        { ...field, id: 'b', name: 'Escluso', page: 2 },
      ],
      fonts: [{ name: 'Mio', data: b64(Uint8Array.from([1, 2, 3])) }],
      template: { name: 'velina.pdf', data: b64(pdf) },
      manualCount: 42,
      pagesSpec: '1,2,1',
    };
    const { project, warnings } = await parseProject(JSON.stringify(v1));
    expect(warnings).toEqual([]);
    expect(project.sources).toHaveLength(1);
    expect(project.sources[0]).toMatchObject({ name: 'velina.pdf', kind: 'pdf' });
    expect(project.sources[0].bytes).toEqual(pdf);
    expect(project.slots.map((s) => [s.page, s.enabled])).toEqual([[0, true], [1, true], [0, true], [2, false]]);
    // Field on page 1 drawn on both occurrences, as v1 did; the excluded page keeps its field on a disabled slot.
    const fronte = project.fields.filter((f) => f.name === 'Fronte');
    expect(fronte.map((f) => f.slot)).toEqual([project.slots[0].id, project.slots[2].id]);
    expect(new Set(fronte.map((f) => f.id)).size).toBe(2);
    fronte[1].counter.start = 99;
    expect(fronte[0].counter.start).toBe(1);
    expect(project.fields.find((f) => f.name === 'Escluso')?.slot).toBe(project.slots[3].id);
    expect(project.fonts[0].bytes).toEqual(Uint8Array.from([1, 2, 3]));
    expect(project.manualCount).toBe(42);
  });

  it('falls back to all pages when the v1 page list is invalid', async () => {
    const pdf = await makePdf([{ kb: 1 }, { kb: 1 }]);
    const v1 = { app: 'DatoVariabile', version: 1, fields: [], fonts: [], template: { name: 'v.pdf', data: b64(pdf) }, manualCount: 1, pagesSpec: '5' };
    const { project, warnings } = await parseProject(JSON.stringify(v1));
    expect(project.slots.map((s) => s.page)).toEqual([0, 1]);
    expect(warnings[0]).toContain('uso tutte le pagine');
  });

  it('reads version 2 files (no data) and refuses unknown files', async () => {
    const pdf = await makePdf([{ kb: 1 }]);
    const slots = [{ id: 's1', sourceId: 'x', page: 0, enabled: true }];
    const v2 = { app: 'DatoVariabile', version: 2, sources: [{ id: 'x', name: 'a.pdf', kind: 'pdf', data: b64(pdf) }], slots, fields: [textField()], fonts: [], manualCount: 3 };
    const { project, legacy } = await parseProject(JSON.stringify(v2));
    expect(legacy).toBe(true);
    expect(project).toEqual({
      sources: [{ id: 'x', name: 'a.pdf', kind: 'pdf', bytes: pdf }],
      slots,
      fields: [textField()],
      fonts: [],
      manualCount: 3,
      data: null,
      range: { from: '', to: '' },
    });
    await expect(parseProject('{"app":"DatoVariabile","version":9}')).rejects.toThrow('formato più recente');
    await expect(parseProject('{"app":"Altro"}')).rejects.toThrow('non è un progetto');
  });
});
