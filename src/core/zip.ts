/**
 * Minimal ZIP (PKWARE APPNOTE 6.3) writer and validating reader for project archives.
 *
 * Profile: ZIP32 only, methods STORE (0) and DEFLATE (8), no encryption, no ZIP64,
 * single disk. Compression uses the browser's native CompressionStream('deflate-raw'),
 * so no dependency is needed and the code runs in Node, in the page and from file://.
 *
 * The reader treats the archive as untrusted input: it validates the central
 * directory against every local header before extracting anything, refuses
 * duplicate or overlapping entries, bounds the decompressed size by the declared
 * size (stopping the stream as soon as it is exceeded: zip bomb) and checks CRC-32.
 */
import { crc32Async } from './crc32';

const MiB = 1024 * 1024;

export const ZIP_LIMITS = {
  /** Whole archive (it is read in memory). */
  archive: 512 * MiB,
  entries: 1000,
  /** One entry once decompressed. */
  entry: 512 * MiB,
  /** All entries once decompressed. */
  total: 1024 * MiB,
  /** Max expansion: an entry may exceed `ratio ×` its compressed size only up to `ratioFloor`. */
  ratio: 1000,
  ratioFloor: 1 * MiB,
};

export class ZipError extends Error {}

export interface ZipInput {
  /** Path inside the archive, "/" separated. */
  path: string;
  data: Uint8Array;
  /** Try DEFLATE (kept only if smaller); false = STORE, for already compressed files. */
  deflate: boolean;
  /** Precomputed CRC-32 of `data`, to avoid computing it twice. */
  crc?: number;
}

// ---------------------------------------------------------------- writer

/** Writes an archive that openZip() accepts: the same limits are enforced here, so a saved project always reopens. */
export async function writeZip(inputs: ZipInput[], when = new Date()): Promise<Blob> {
  if (inputs.length > ZIP_LIMITS.entries) throw new ZipError(`troppi file per un progetto (${inputs.length}, massimo ${ZIP_LIMITS.entries})`);
  const total = inputs.reduce((n, i) => n + i.data.length, 0);
  if (total > ZIP_LIMITS.total) throw new ZipError('progetto troppo grande (oltre 1 GB di file)');
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const input of inputs) {
    if (!isSafePath(input.path)) throw new ZipError(`nome di file non valido nell'archivio: ${input.path}`);
    if (seen.has(input.path.toLowerCase())) throw new ZipError(`file duplicato nell'archivio: ${input.path}`);
    seen.add(input.path.toLowerCase());
    const name = encoder.encode(input.path);
    const utf8 = /[^\x20-\x7e]/.test(input.path);
    const crc = input.crc ?? (await crc32Async(input.data));
    let method = 0;
    let stored = input.data;
    if (input.data.length > ZIP_LIMITS.entry) throw new ZipError(`file troppo grande per il progetto: ${input.path}`);
    if (input.deflate && input.data.length > 0) {
      const deflated = await deflateRaw(input.data);
      // Keep DEFLATE only if smaller and within the expansion ratio the reader accepts.
      if (deflated.length < input.data.length && input.data.length <= Math.max(ZIP_LIMITS.ratioFloor, deflated.length * ZIP_LIMITS.ratio)) {
        method = 8;
        stored = deflated;
      }
    }
    if (offset + 30 + name.length + stored.length > ZIP_LIMITS.archive) {
      throw new ZipError('progetto troppo grande: l’archivio supererebbe 512 MB');
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, utf8 ? 0x0800 : 0, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, stored.length, true);
    local.setUint32(22, input.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name as BlobPart, stored as BlobPart);

    const cd = new Uint8Array(46 + name.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, utf8 ? 0x0800 : 0, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, stored.length, true);
    c.setUint32(24, input.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += 30 + name.length + stored.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  if (offset + cdSize + 22 > ZIP_LIMITS.archive) throw new ZipError('progetto troppo grande: l’archivio supererebbe 512 MB');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, inputs.length, true);
  end.setUint16(10, inputs.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: 'application/zip' });
}

// ---------------------------------------------------------------- reader

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  dataStart: number;
}

export interface ZipArchive {
  /** Entries by exact name (directories excluded). */
  entries: Map<string, ZipEntry>;
  /** Extracts an entry: a fresh copy (the archive buffer can be released), CRC verified. */
  read(name: string): Promise<Uint8Array>;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

/** Relative "/" path without "..", drive letters, backslashes or control characters. */
export function isSafePath(p: string): boolean {
  if (!p || p.length > 255 || p.startsWith('/') || p.endsWith('/')) return false;
  if (/[\\:\x00-\x1f\x7f]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function openZip(bytes: Uint8Array): ZipArchive {
  if (bytes.length > ZIP_LIMITS.archive) throw new ZipError('archivio troppo grande');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);

  // End of central directory: the last signature whose comment reaches exactly the end of the file.
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xffff); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('il file non è un archivio ZIP valido o è troncato');
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== count) throw new ZipError('archivio ZIP su più dischi non supportato');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('archivio ZIP64 non supportato');
  if (cdOffset + cdSize > eocd) throw new ZipError('archivio ZIP danneggiato (directory centrale)');
  if (count > ZIP_LIMITS.entries) throw new ZipError(`archivio con troppi file (${count})`);

  const entries = new Map<string, ZipEntry>();
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const latin1 = new TextDecoder('latin1');
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || u32(p) !== 0x02014b50) throw new ZipError('archivio ZIP danneggiato (voce della directory centrale)');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compressedSize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const next = p + 46 + nameLen + u16(p + 30) + u16(p + 32);
    const localOffset = u32(p + 42);
    if (next > cdOffset + cdSize) throw new ZipError('archivio ZIP danneggiato (directory centrale)');
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    let name: string;
    try {
      name = flags & 0x0800 ? utf8.decode(nameBytes) : latin1.decode(nameBytes);
    } catch {
      throw new ZipError('archivio ZIP con nomi di file non validi');
    }
    if (flags & 0x0041) throw new ZipError('archivio ZIP cifrato non supportato');
    if (method !== 0 && method !== 8) throw new ZipError(`metodo di compressione ZIP non supportato (${method})`);
    if (method === 0 && compressedSize !== size) throw new ZipError(`archivio ZIP danneggiato (${name})`);
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('archivio ZIP64 non supportato');
    if (size > ZIP_LIMITS.entry || size > Math.max(ZIP_LIMITS.ratioFloor, compressedSize * ZIP_LIMITS.ratio)) {
      throw new ZipError(`archivio sospetto: ${name} si espanderebbe a ${size} byte`);
    }
    total += size;
    if (total > ZIP_LIMITS.total) throw new ZipError('archivio sospetto: contenuto decompresso troppo grande');
    const key = name.toLowerCase();
    if (names.has(key)) throw new ZipError(`archivio con file duplicati: ${name}`);
    names.add(key);

    // The local header must exist, carry the same name and keep its data inside the archive.
    if (localOffset + 30 > cdOffset || u32(localOffset) !== 0x04034b50) throw new ZipError(`archivio ZIP danneggiato (intestazione di ${name})`);
    const localNameLen = u16(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen + u16(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen);
    if (localNameLen !== nameLen || localName.some((b, k) => b !== nameBytes[k])) throw new ZipError(`archivio ZIP incoerente (${name})`);
    // Same method and encryption flag; sizes and CRC too unless a data descriptor (bit 3) follows the data.
    const localFlags = u16(localOffset + 6);
    const sameFields =
      u16(localOffset + 8) === method &&
      (localFlags & 0x0041) === 0 &&
      (flags & 0x0008 || (u32(localOffset + 14) === crc && u32(localOffset + 18) === compressedSize && u32(localOffset + 22) === size));
    if (!sameFields || u16(p + 34) !== 0) throw new ZipError(`archivio ZIP incoerente (${name})`);
    if (dataStart + compressedSize > cdOffset) throw new ZipError(`archivio ZIP danneggiato (${name} troncato)`);
    ranges.push([localOffset, dataStart + compressedSize]);
    if (!name.endsWith('/')) entries.set(name, { name, method, crc, compressedSize, size, dataStart });
    p = next;
  }
  if (p !== cdOffset + cdSize) throw new ZipError('archivio ZIP danneggiato (directory centrale incoerente)');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k][0] < ranges[k - 1][1]) throw new ZipError('archivio ZIP non valido (voci sovrapposte)');
  }

  return {
    entries,
    async read(name: string): Promise<Uint8Array> {
      const e = entries.get(name);
      if (!e) throw new ZipError(`manca il file ${name} nell'archivio`);
      const raw = bytes.subarray(e.dataStart, e.dataStart + e.compressedSize);
      const data = e.method === 0 ? raw.slice() : await inflateRawBounded(raw, e.size, name);
      if ((await crc32Async(data)) !== e.crc) throw new ZipError(`file danneggiato nell'archivio: ${name} (controllo CRC fallito)`);
      return data;
    },
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates into a buffer of exactly `size` bytes; stops as soon as the data would exceed it. */
async function inflateRawBounded(data: Uint8Array, size: number, name: string): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let at = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (at + value.length > size) {
        await reader.cancel();
        throw new ZipError(`archivio sospetto: ${name} supera la dimensione dichiarata`);
      }
      out.set(value, at);
      at += value.length;
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError(`file danneggiato nell'archivio: ${name} (dati compressi non validi)`);
  }
  if (at !== size) throw new ZipError(`file danneggiato nell'archivio: ${name} (dimensione diversa da quella dichiarata)`);
  return out;
}
