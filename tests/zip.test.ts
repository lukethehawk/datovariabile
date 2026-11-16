import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32';
import { ZIP_LIMITS, ZipError, isSafePath, isZip, openZip, writeZip } from '../src/core/zip';

const enc = (s: string) => new TextEncoder().encode(s);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes of `length` without any structure: DEFLATE cannot shrink them. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Flags from the local header of `name` (the writer keeps the input order). */
function localFlags(bytes: Uint8Array, name: string): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 0; p + 30 <= bytes.length; ) {
    if (dv.getUint32(p, true) !== 0x04034b50) break;
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const compressedSize = dv.getUint32(p + 18, true);
    if (new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen)) === name) return dv.getUint16(p + 6, true);
    p += 30 + nameLen + extraLen + compressedSize;
  }
  throw new Error(`voce ${name} non trovata nell'archivio`);
}

// ---------------------------------------------------------------- raw ZIP builder

interface RawEntry {
  name: string;
  data?: Uint8Array;
  method?: number;
  size?: number;
  compressedSize?: number;
  crc?: number;
  flags?: number;
  /** Local header overrides, to forge archives whose two headers disagree. */
  localMethod?: number;
  localFlags?: number;
  localCrc?: number;
  localSize?: number;
  localCompressedSize?: number;
  /** Central directory overrides. */
  centralFlags?: number;
  diskStart?: number;
  /** Different name written in the local header (to forge an incoherent archive). */
  localName?: string;
  /** Different name written in the central directory. */
  centralName?: string;
  /** Central directory offset override (to point two entries at overlapping ranges). */
  localOffset?: number;
}

interface RawOptions {
  count?: number;
  entriesThisDisk?: number;
  cdSize?: number;
  cdOffset?: number;
  disk?: number;
  cdDisk?: number;
  /** Filler bytes between the central directory and the EOCD (declared as part of cdSize). */
  pad?: number;
}

/** Hand-made ZIP32 (no compression) whose fields can be forged one by one. */
function buildZip(entries: RawEntry[], opts: RawOptions = {}): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0);
    const method = e.method ?? 0;
    const size = e.size ?? data.length;
    const compressedSize = e.compressedSize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const flags = e.flags ?? (/[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0);
    const name = encoder.encode(e.name);
    const localName = e.localName !== undefined ? encoder.encode(e.localName) : name;
    const centralName = e.centralName !== undefined ? encoder.encode(e.centralName) : name;
    const at = offset;

    const local = new DataView(new ArrayBuffer(30 + localName.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, e.localFlags ?? flags, true);
    local.setUint16(8, e.localMethod ?? method, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x0021, true);
    local.setUint32(14, e.localCrc ?? crc, true);
    local.setUint32(18, e.localCompressedSize ?? compressedSize, true);
    local.setUint32(22, e.localSize ?? size, true);
    local.setUint16(26, localName.length, true);
    new Uint8Array(local.buffer).set(localName, 30);
    parts.push(new Uint8Array(local.buffer), data);

    const cd = new DataView(new ArrayBuffer(46 + centralName.length));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, e.centralFlags ?? flags, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x0021, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, compressedSize, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, centralName.length, true);
    cd.setUint16(34, e.diskStart ?? 0, true);
    cd.setUint32(42, e.localOffset ?? at, true);
    new Uint8Array(cd.buffer).set(centralName, 46);
    central.push(new Uint8Array(cd.buffer));
    offset += 30 + localName.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const pad = opts.pad ?? 0;
  const count = opts.count ?? entries.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, opts.disk ?? 0, true);
  end.setUint16(6, opts.cdDisk ?? 0, true);
  end.setUint16(8, opts.entriesThisDisk ?? count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, opts.cdSize ?? cdSize + pad, true);
  end.setUint32(16, opts.cdOffset ?? offset, true);
  const tail = new Uint8Array(end.buffer);
  return new Uint8Array([...parts, ...central, new Uint8Array(pad), tail].flatMap((p) => [...p]));
}

// ---------------------------------------------------------------- round-trip

describe('archivio ZIP dei progetti', () => {
  it('scrive e rilegge voci STORE e DEFLATE, nomi ASCII e UTF-8, byte identici', async () => {
    const empty = new Uint8Array(0);
    const text = enc('Intestazione;Codice\n"Rossi, Mario";001234\nRiga con Ünïcødé 😀\n'.repeat(20));
    const big = enc('riga di testo comprimibile '.repeat(8000)); // ~200 KB
    const random = noise(4096);
    const jpegish = enc('già compresso '.repeat(200));

    const blob = await writeZip([
      { path: 'vuoto.txt', data: empty, deflate: true },
      { path: 'testo.txt', data: text, deflate: true },
      { path: 'grande.txt', data: big, deflate: true },
      { path: 'rumore.bin', data: random, deflate: true },
      { path: 'foto.jpg', data: jpegish, deflate: false },
      { path: 'veline/01-vèlina.pdf', data: text, deflate: true },
    ]);
    expect(blob.type).toBe('application/zip');
    const bytes = await bytesOf(blob);
    expect(isZip(bytes)).toBe(true);

    const zip = openZip(bytes);
    expect([...zip.entries.keys()]).toEqual(['vuoto.txt', 'testo.txt', 'grande.txt', 'rumore.bin', 'foto.jpg', 'veline/01-vèlina.pdf']);
    // Empty and incompressible data stay STORE even with deflate:true; text is deflated.
    expect(zip.entries.get('vuoto.txt')!.method).toBe(0);
    expect(zip.entries.get('testo.txt')!.method).toBe(8);
    expect(zip.entries.get('grande.txt')!.method).toBe(8);
    expect(zip.entries.get('rumore.bin')!.method).toBe(0);
    expect(zip.entries.get('foto.jpg')!.method).toBe(0);
    expect(zip.entries.get('veline/01-vèlina.pdf')!.method).toBe(8);

    expect(await zip.read('vuoto.txt')).toEqual(empty);
    expect(await zip.read('testo.txt')).toEqual(text);
    expect(await zip.read('grande.txt')).toEqual(big);
    expect(await zip.read('rumore.bin')).toEqual(random);
    expect(await zip.read('foto.jpg')).toEqual(jpegish);
    expect(await zip.read('veline/01-vèlina.pdf')).toEqual(text);

    // Bit 11 of the general purpose flags marks UTF-8 names.
    expect(localFlags(bytes, 'testo.txt')).toBe(0);
    expect(localFlags(bytes, 'veline/01-vèlina.pdf') & 0x0800).toBe(0x0800);
  });

  it('non restituisce nulla per un nome assente', async () => {
    const zip = openZip(await bytesOf(await writeZip([{ path: 'a.txt', data: enc('x'), deflate: false }])));
    await expect(zip.read('b.txt')).rejects.toThrow(ZipError);
    await expect(zip.read('b.txt')).rejects.toThrow(/manca il file b\.txt/);
  });
});

// ---------------------------------------------------------------- writer limits

describe('limiti in scrittura', () => {
  it('rifiuta più file di quanti ne accetti il lettore', async () => {
    const inputs = Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ path: `f${i}.bin`, data: new Uint8Array(0), deflate: false }));
    await expect(writeZip(inputs)).rejects.toThrow(ZipError);
    await expect(writeZip(inputs)).rejects.toThrow(new RegExp(`troppi file per un progetto \\(${ZIP_LIMITS.entries + 1}, massimo ${ZIP_LIMITS.entries}\\)`));
  });

  it('rifiuta un file oltre il limite per voce', async () => {
    const huge = { path: 'enorme.pdf', data: new Uint8Array(ZIP_LIMITS.entry + 1), deflate: false, crc: 0 };
    await expect(writeZip([huge])).rejects.toThrow(ZipError);
    await expect(writeZip([huge])).rejects.toThrow(/file troppo grande per il progetto: enorme\.pdf/);
  });

  it('resta su STORE quando il DEFLATE supererebbe il rapporto ammesso dal lettore', async () => {
    // 3 MiB of zeros: raw deflate reaches ~1026x, beyond the reader's 1000x, so DEFLATE must be dropped.
    const zeros = new Uint8Array(3 * 1024 * 1024);
    const zip = openZip(await bytesOf(await writeZip([{ path: 'zeri.bin', data: zeros, deflate: true }])));
    expect(zip.entries.get('zeri.bin')!.method).toBe(0);
    expect(await zip.read('zeri.bin')).toEqual(zeros);
  });
});

// ---------------------------------------------------------------- hostile archives

describe('archivi ZIP ostili', () => {
  it('rifiuta un CRC errato al momento dell\'estrazione', async () => {
    const data = enc('contenuto del file');
    const zip = openZip(buildZip([{ name: 'a.txt', data, crc: crc32(data) ^ 0xff }]));
    await expect(zip.read('a.txt')).rejects.toThrow(ZipError);
    await expect(zip.read('a.txt')).rejects.toThrow(/controllo CRC fallito/);
  });

  it('rifiuta un DEFLATE che espande oltre la dimensione dichiarata', async () => {
    const plain = new Uint8Array(10_000).fill(65);
    const packed = await deflateRaw(plain);
    const zip = openZip(buildZip([{ name: 'bomba.txt', data: packed, method: 8, size: 500, compressedSize: packed.length }]));
    await expect(zip.read('bomba.txt')).rejects.toThrow(ZipError);
    await expect(zip.read('bomba.txt')).rejects.toThrow(/supera la dimensione dichiarata/);
  });

  it('rifiuta una dimensione dichiarata maggiore del contenuto', async () => {
    const plain = enc('testo che non arriva alla dimensione dichiarata');
    const packed = await deflateRaw(plain);
    const zip = openZip(buildZip([{ name: 'a.txt', data: packed, method: 8, size: plain.length + 10, compressedSize: packed.length }]));
    await expect(zip.read('a.txt')).rejects.toThrow(ZipError);
    await expect(zip.read('a.txt')).rejects.toThrow(/dimensione diversa da quella dichiarata/);
  });

  it('rifiuta un rapporto di espansione sospetto prima di allocare', () => {
    // The whole archive is a few dozen bytes but the entry claims 10 MiB.
    const bytes = buildZip([{ name: 'bomba.bin', data: new Uint8Array(16), method: 8, size: 10 * 1024 * 1024, compressedSize: 16 }]);
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/archivio sospetto: bomba\.bin si espanderebbe a 10485760 byte/);
  });

  it('rifiuta nomi duplicati, anche solo per maiuscole', () => {
    const duplicate = buildZip([
      { name: 'a.txt', data: enc('uno') },
      { name: 'a.txt', data: enc('due') },
    ]);
    expect(() => openZip(duplicate)).toThrow(ZipError);
    expect(() => openZip(duplicate)).toThrow(/file duplicati: a\.txt/);

    const caseOnly = buildZip([
      { name: 'a.txt', data: enc('uno') },
      { name: 'A.txt', data: enc('due') },
    ]);
    expect(() => openZip(caseOnly)).toThrow(ZipError);
    expect(() => openZip(caseOnly)).toThrow(/file duplicati: A\.txt/);
  });

  it('rifiuta voci sovrapposte', () => {
    // 'a.txt' declares 6 bytes but its data is 5: its range covers the local header of 'b.txt'.
    const bytes = buildZip([
      { name: 'a.txt', data: enc('12345'), size: 6, compressedSize: 6 },
      { name: 'b.txt', data: enc('xyz') },
    ]);
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/voci sovrapposte/);
  });

  it('rifiuta un\'intestazione locale con un nome diverso dalla directory centrale', () => {
    const bytes = buildZip([{ name: 'a.txt', data: enc('x'), localName: 'b.txt' }]);
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/archivio ZIP incoerente \(a\.txt\)/);
  });

  it('rifiuta intestazioni locale e centrale incoerenti', () => {
    const data = enc('contenuto');

    const method = buildZip([{ name: 'a.txt', data, localMethod: 8 }]);
    expect(() => openZip(method)).toThrow(ZipError);
    expect(() => openZip(method)).toThrow(/archivio ZIP incoerente \(a\.txt\)/);

    const crc = buildZip([{ name: 'a.txt', data, localCrc: crc32(data) ^ 0xff }]);
    expect(() => openZip(crc)).toThrow(ZipError);
    expect(() => openZip(crc)).toThrow(/archivio ZIP incoerente \(a\.txt\)/);

    const size = buildZip([{ name: 'a.txt', data, localSize: data.length + 1 }]);
    expect(() => openZip(size)).toThrow(ZipError);
    expect(() => openZip(size)).toThrow(/archivio ZIP incoerente \(a\.txt\)/);

    // Encryption claimed only by the local header.
    const encrypted = buildZip([{ name: 'a.txt', data, localFlags: 0x0001 }]);
    expect(() => openZip(encrypted)).toThrow(ZipError);
    expect(() => openZip(encrypted)).toThrow(/archivio ZIP incoerente \(a\.txt\)/);

    const disk = buildZip([{ name: 'a.txt', data, diskStart: 1 }]);
    expect(() => openZip(disk)).toThrow(ZipError);
    expect(() => openZip(disk)).toThrow(/archivio ZIP incoerente \(a\.txt\)/);
  });

  it('accetta un data descriptor con dimensioni locali a zero se i dati sono coerenti', async () => {
    const data = enc('contenuto con data descriptor');
    const bytes = buildZip([
      { name: 'a.txt', data, localFlags: 0x0008, centralFlags: 0x0008, localCrc: 0, localCompressedSize: 0, localSize: 0 },
    ]);
    const zip = openZip(bytes);
    expect(await zip.read('a.txt')).toEqual(data);
  });

  it('rifiuta una directory centrale non consumata esattamente', () => {
    // Four filler bytes are declared as part of the central directory but are not an entry.
    const bytes = buildZip([{ name: 'a.txt', data: enc('x') }], { pad: 4 });
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/directory centrale incoerente/);
  });

  it('rifiuta voci cifrate', () => {
    const bytes = buildZip([{ name: 'a.txt', data: enc('x'), flags: 0x0001 }]);
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/archivio ZIP cifrato non supportato/);
  });

  it('rifiuta metodi di compressione diversi da STORE e DEFLATE', () => {
    const bytes = buildZip([{ name: 'a.bin', data: enc('x'), method: 12 }]);
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/metodo di compressione ZIP non supportato \(12\)/);
  });

  it('rifiuta i marcatori ZIP64', () => {
    const entry = buildZip([{ name: 'a.bin', data: enc('x'), method: 8, size: 0xffffffff, compressedSize: 1 }]);
    expect(() => openZip(entry)).toThrow(ZipError);
    expect(() => openZip(entry)).toThrow(/archivio ZIP64 non supportato/);

    const eocd = buildZip([{ name: 'a.txt', data: enc('x') }], { cdSize: 0xffffffff });
    expect(() => openZip(eocd)).toThrow(ZipError);
    expect(() => openZip(eocd)).toThrow(/archivio ZIP64 non supportato/);
  });

  it('rifiuta gli archivi su più dischi', () => {
    const bytes = buildZip([{ name: 'a.txt', data: enc('x') }], { disk: 1 });
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/su più dischi non supportato/);
  });

  it('rifiuta un archivio troncato o senza EOCD', () => {
    const complete = buildZip([{ name: 'a.txt', data: enc('contenuto') }]);
    const truncated = complete.subarray(0, complete.length - 10);
    expect(() => openZip(truncated)).toThrow(ZipError);
    expect(() => openZip(truncated)).toThrow(/non è un archivio ZIP valido o è troncato/);

    const noEocd = complete.slice();
    noEocd.set([0, 0, 0, 0], noEocd.length - 22);
    expect(() => openZip(noEocd)).toThrow(ZipError);
    expect(() => openZip(noEocd)).toThrow(/non è un archivio ZIP valido o è troncato/);
  });

  it('rifiuta una voce i cui dati escono dall\'archivio', () => {
    const bytes = buildZip([{ name: 'a.txt', data: enc('12345'), size: 500, compressedSize: 500 }]);
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(/archivio ZIP danneggiato \(a\.txt troncato\)/);
  });

  it('rifiuta più voci di quelle consentite, anche solo dichiarate nell\'EOCD', () => {
    const bytes = buildZip([{ name: 'a.txt', data: enc('x') }], { count: ZIP_LIMITS.entries + 1 });
    expect(() => openZip(bytes)).toThrow(ZipError);
    expect(() => openZip(bytes)).toThrow(new RegExp(`archivio con troppi file \\(${ZIP_LIMITS.entries + 1}\\)`));
  });
});

// ---------------------------------------------------------------- paths and signature

describe('percorsi e firma', () => {
  it('accetta solo percorsi relativi sicuri', () => {
    expect(isSafePath('veline/01-a.pdf')).toBe(true);
    expect(isSafePath('dati/originale-clienti.csv')).toBe(true);
    for (const bad of ['../x', 'a/../b', '/x', 'C:/x', 'a\\b', 'a//b', 'a/', '', 'a\x01b', 'a\x7fb', '.', 'a/./b']) {
      expect(isSafePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('riconosce la firma ZIP e distingue un JSON', () => {
    expect(isZip(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0]))).toBe(true);
    expect(isZip(Uint8Array.from([0x50, 0x4b, 5, 6]))).toBe(true);
    expect(isZip(enc('{"app":"DatoVariabile","version":2}'))).toBe(false);
    expect(isZip(Uint8Array.from([0x50, 0x4b, 7, 8]))).toBe(false);
    expect(isZip(new Uint8Array(2))).toBe(false);
  });
});
