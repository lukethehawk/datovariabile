import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { activeComposition } from '../src/core/composition';
import { generate, type Job } from '../src/core/generate';
import { compileGenerators, generationIssue, UNIQUE_ALPHABETS } from '../src/core/generators';
import { formatCounter } from '../src/core/placeholders';
import type { Field, NumberingGenerator, Slot, UniqueGenerator } from '../src/core/types';
import { makeTemplate, pdfJob, textField } from './helpers';

/** Text of one page, in reading order. */
async function texts(bytes: Uint8Array, pageNumber: number): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' });
  const page = await (await task.promise).getPage(pageNumber);
  const content = await page.getTextContent();
  const result = content.items.flatMap((it) => ('str' in it && it.str ? [it.str] : []));
  await task.destroy();
  return result;
}

/** Fixed 256-bit key: the codes are reproducible, so the tests can compute them without the PDF. */
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function uniqueGen(overrides: Partial<UniqueGenerator> = {}): UniqueGenerator {
  return {
    id: 'u1',
    name: 'Codice',
    type: 'unique',
    prefix: '',
    suffix: '',
    algorithm: 'hmac-sha256-ctr-v1',
    key: KEY,
    alphabet: UNIQUE_ALPHABETS.safe,
    length: 4,
    ...overrides,
  };
}

function numberingGen(overrides: Partial<NumberingGenerator> = {}): NumberingGenerator {
  return {
    id: 'n1',
    name: 'Matricola',
    type: 'numbering',
    prefix: '',
    suffix: '',
    style: 'number',
    start: 1,
    step: 1,
    digits: 4,
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    groupStart: 'A',
    numberMin: 1,
    numberMax: 999,
    overflow: 'grow',
    ...overrides,
  };
}

function slot(id: string, enabled = true): Slot {
  return { id, sourceId: `src${id}`, page: 0, enabled };
}

/** The job the UI builds: pages = enabled slots, fields = activeComposition fields. */
async function composedJob(
  sources: Uint8Array[],
  sourceOf: Record<string, number>,
  slots: Slot[],
  fields: Field[],
  overrides: Partial<Job> = {},
): Promise<Job> {
  const active = activeComposition(slots, fields);
  const defs = active.slots.map((s) => [sourceOf[s.id], s.page, s.id] as [number, number, string]);
  return pdfJob(sources, defs, { fields: active.fields, ...overrides });
}

describe('activeComposition and generationIssue', () => {
  it('accepts a valid generator referenced on an enabled page', () => {
    const slots = [slot('F')];
    const fields = [textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Codice {@Codice}' })];
    const { slots: activeSlots, fields: activeFields } = activeComposition(slots, fields);
    expect(activeSlots.map((s) => s.id)).toEqual(['F']);
    expect(generationIssue([uniqueGen()], activeFields, 10)).toBeNull();
  });

  it('reports a broken generator referenced on an enabled page', () => {
    const slots = [slot('F')];
    const fields = [textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Codice {@Codice}' })];
    const activeFields = activeComposition(slots, fields).fields;

    // Length 1 over the digits alphabet: capacity 10, so at most 5 distinct codes.
    const tooShort = uniqueGen({ length: 1, alphabet: '0123456789' });
    const issue = generationIssue([tooShort], activeFields, 20);
    expect(issue).toContain('Generatore "Codice":');
    expect(issue).toContain('servono 20 codici');

    const zeroLength = uniqueGen({ length: 0 });
    expect(generationIssue([zeroLength], activeFields, 1)).toBe('Generatore "Codice": lunghezza non valida (1–32)');
  });

  it('ignores a broken generator referenced only on a disabled page', () => {
    const slots = [slot('F'), slot('R', false)];
    const fields = [textField({ id: 'b1', name: 'Retro', slot: 'R', content: 'Codice {@Codice}' })];
    const broken = [uniqueGen({ length: 0 })];

    const { slots: activeSlots, fields: activeFields } = activeComposition(slots, fields);
    expect(activeSlots.map((s) => s.id)).toEqual(['F']);
    expect(activeFields).toEqual([]);
    // The false error that the old summary showed: all the fields would block the generation.
    expect(generationIssue(broken, fields, 1)).toBe('Generatore "Codice": lunghezza non valida (1–32)');
    expect(generationIssue(broken, activeFields, 1)).toBeNull();
  });

  it('still reports a broken generator also used on an enabled page', () => {
    const slots = [slot('F'), slot('R', false)];
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: '{@Codice}' }),
      textField({ id: 'b1', name: 'Retro', slot: 'R', content: 'Retro {@Codice}' }),
    ];
    const activeFields = activeComposition(slots, fields).fields;
    expect(activeFields.map((f) => f.id)).toEqual(['f1']);
    expect(generationIssue([uniqueGen({ length: 0 })], activeFields, 1)).toContain('Generatore "Codice":');
  });

  it('reads the same slot array after toggling enabled, without rebuilding it', () => {
    const slots = [slot('F'), slot('R', false)];
    const fields = [textField({ id: 'b1', name: 'Retro', slot: 'R', content: '{@Codice}' })];
    const broken = [uniqueGen({ length: 0 })];

    expect(generationIssue(broken, activeComposition(slots, fields).fields, 1)).toBeNull();
    slots[1].enabled = true;
    expect(activeComposition(slots, fields).fields.map((f) => f.id)).toEqual(['b1']);
    expect(generationIssue(broken, activeComposition(slots, fields).fields, 1)).toContain('Generatore "Codice":');
    slots[1].enabled = false;
    expect(generationIssue(broken, activeComposition(slots, fields).fields, 1)).toBeNull();
  });

  it('keeps the slot order and filters fields by slot id', () => {
    const slots = [slot('F'), slot('R', false), slot('T')];
    const fields = [
      textField({ id: 'r1', name: 'Retro', slot: 'R', content: 'retro' }),
      textField({ id: 't1', name: 'Terza', slot: 'T', content: 'terza' }),
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'fronte' }),
    ];
    const { slots: activeSlots, fields: activeFields } = activeComposition(slots, fields);
    expect(activeSlots.map((s) => s.id)).toEqual(['F', 'T']);
    expect(activeSlots.map((s) => s.page)).toEqual([0, 0]);
    expect(activeFields.map((f) => f.id)).toEqual(['t1', 'f1']);
  });
});

describe('generation with the active composition', () => {
  it('generates only the enabled page and skips a broken generator used on the disabled one', async () => {
    const front = await makeTemplate({ kb: 1, seed: 1 });
    const back = await makeTemplate({ kb: 1, seed: 2 });
    const good = numberingGen();
    // Invalid prefix (contains braces) but still compilable: the disabled page must not need it.
    const broken = uniqueGen({ id: 'u1', name: 'Rotto', prefix: '{' });
    const slots = [slot('F'), slot('R', false)];
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Fronte {@Matricola}' }),
      textField({ id: 'b1', name: 'Retro', slot: 'R', content: '{@Rotto}' }),
    ];

    expect(generationIssue([good, broken], fields, 4)).toContain('Generatore "Rotto":');
    const job = await composedJob([front, back], { F: 0, R: 1 }, slots, fields, { generators: [good, broken], to: 3 });
    expect(generationIssue([good, broken], job.fields, job.to + 1)).toBeNull();

    const res = await generate(job);
    expect(res.pageCount).toBe(4);
    const value = compileGenerators([good], { now: 0, count: 4 }).get('Matricola')!;
    for (let rec = 0; rec < 4; rec++) {
      expect(await texts(res.bytes, rec + 1)).toEqual([`Fronte ${value(rec)}`]);
    }
  });

  it('doubles the pages when the back is re-enabled and only then reports the missing column', async () => {
    const front = await makeTemplate({ kb: 1, seed: 1 });
    const back = await makeTemplate({ kb: 1, seed: 2 });
    const data = { columns: ['Nome'], rows: [['Anna'], ['Bruno']] };
    const gen = numberingGen();
    const slots = [slot('F'), slot('R', false)];
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Fronte {Nome} {#} {@Matricola}', counter: { start: 1, step: 1, digits: 4 } }),
      textField({ id: 'b1', name: 'Retro', slot: 'R', content: '{Manca}' }),
    ];
    const overrides = { data, generators: [gen], to: data.rows.length - 1 };

    const first = await generate(await composedJob([front, back], { F: 0, R: 1 }, slots, fields, overrides));
    expect(first.pageCount).toBe(2);
    expect(await texts(first.bytes, 1)).toEqual(['Fronte Anna 0001 0001']);
    expect(await texts(first.bytes, 2)).toEqual(['Fronte Bruno 0002 0002']);

    // Re-enabling the back makes the missing column an error, with the zone and the token.
    slots[1].enabled = true;
    const error = await generate(await composedJob([front, back], { F: 0, R: 1 }, slots, fields, overrides)).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain('Zona "Retro"');
    expect(error).toContain('Colonna "Manca" non presente nei dati');

    // With a valid back field the page count doubles.
    const fixedFields = [fields[0], textField({ id: 'b1', name: 'Retro', slot: 'R', content: '{Nome}' })];
    const both = await generate(await composedJob([front, back], { F: 0, R: 1 }, slots, fixedFields, overrides));
    expect(both.pageCount).toBe(4);
    expect(await texts(both.bytes, 2)).toEqual(['Anna']);
  });

  it('reports an unknown generator placeholder with the zone name', async () => {
    const front = await makeTemplate({ kb: 1, seed: 1 });
    const slots = [slot('F')];
    const fields = [textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Valore {@Inesistente}' })];
    const job = await composedJob([front], { F: 0 }, slots, fields, { generators: [numberingGen()], to: 0 });

    const error = await generate(job).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain('Zona "Fronte"');
    expect(error).toContain('generatore "Inesistente" inesistente');
  });

  it('gives the front page the same counter and generator values with or without the back', async () => {
    const front = await makeTemplate({ kb: 1, seed: 1 });
    const back = await makeTemplate({ kb: 1, seed: 2 });
    const gen = numberingGen();
    const slots = [slot('F'), slot('R')];
    const fields = [
      textField({ id: 'f1', name: 'Fronte', slot: 'F', content: 'Fronte {#} {@Matricola}', counter: { start: 1, step: 1, digits: 4 } }),
      textField({ id: 'b1', name: 'Retro', slot: 'R', content: 'Retro {@Matricola}' }),
    ];
    const overrides = { generators: [gen], to: 2 };

    const withBack = await generate(await composedJob([front, back], { F: 0, R: 1 }, slots, fields, overrides));
    expect(withBack.pageCount).toBe(6);

    slots[1].enabled = false;
    const frontOnly = await generate(await composedJob([front, back], { F: 0, R: 1 }, slots, fields, overrides));
    expect(frontOnly.pageCount).toBe(3);

    const value = compileGenerators([gen], { now: 0, count: 3 }).get('Matricola')!;
    for (let rec = 0; rec < 3; rec++) {
      const expected = [`Fronte ${formatCounter({ start: 1, step: 1, digits: 4 }, rec)} ${value(rec)}`];
      // The front keeps the values of its absolute record index, wherever the back was.
      expect(await texts(withBack.bytes, rec * 2 + 1)).toEqual(expected);
      expect(await texts(frontOnly.bytes, rec + 1)).toEqual(expected);
    }
  });
});
