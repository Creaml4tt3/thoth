/**
 * CRC-32 (IEEE 802.3, the ZIP polynomial) without platform APIs, using
 * slicing-by-8 tables. `crc32(data, previous)` continues a running checksum
 * exactly like `zlib.crc32(data, previous)`.
 */
const TABLES = (() => {
  const t = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n]!;
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff]! ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

export function crc32(data: Uint8Array, previous = 0): number {
  const t = TABLES;
  let crc = ~previous;
  let i = 0;
  const n = data.length;
  for (; n - i >= 8; i += 8) {
    const lo = crc ^ (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24));
    crc =
      t[1792 + (lo & 0xff)]! ^
      t[1536 + ((lo >>> 8) & 0xff)]! ^
      t[1280 + ((lo >>> 16) & 0xff)]! ^
      t[1024 + (lo >>> 24)]! ^
      t[768 + data[i + 4]!]! ^
      t[512 + data[i + 5]!]! ^
      t[256 + data[i + 6]!]! ^
      t[data[i + 7]!]!;
  }
  for (; i < n; i++) crc = t[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}
