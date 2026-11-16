/** CRC-32 (IEEE, as in PNG and ZIP). */
let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  return table;
}

/** `crc` continues a previous value (pass the result of an earlier call). */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = crcTable();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Same result as crc32(), yielding to the event loop every 8 MiB so large files do not freeze the page. */
export async function crc32Async(data: Uint8Array): Promise<number> {
  const CHUNK = 8 * 1024 * 1024;
  let crc = 0;
  for (let at = 0; at < data.length; at += CHUNK) {
    crc = crc32(data.subarray(at, at + CHUNK), crc);
    if (at + CHUNK < data.length) {
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve);
      await tick.promise;
    }
  }
  return crc;
}
