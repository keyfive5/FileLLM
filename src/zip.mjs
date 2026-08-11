// A minimal ZIP central-directory reader, so we can read .docx/.xlsx/.pptx
// (which are just ZIPs of XML) without pulling in a dependency.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;

/**
 * @returns {Map<string, {offset:number, method:number, csize:number, usize:number}>}
 */
export function readZipDirectory(buf) {
  const eocd = findEOCD(buf);
  if (!eocd) throw new Error('Not a ZIP file (no end-of-central-directory record)');

  let { entries, cenOffset } = eocd;

  // ZIP64 tail, present on files with >65535 entries or >4GB members.
  const locatorPos = eocd.pos - 20;
  if (locatorPos >= 0 && buf.readUInt32LE(locatorPos) === EOCD64_LOCATOR_SIG) {
    const z64 = Number(buf.readBigUInt64LE(locatorPos + 8));
    if (z64 >= 0 && z64 + 4 <= buf.length && buf.readUInt32LE(z64) === EOCD64_SIG) {
      entries = Number(buf.readBigUInt64LE(z64 + 32));
      cenOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const map = new Map();
  let p = cenOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // ZIP64 extended-information extra field overrides the 0xFFFFFFFF sentinels.
    if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const sz = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + sz;
      }
    }

    map.set(name, { offset, method, csize, usize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

/** Inflate one member by name. Returns null when absent. */
export function readZipEntry(buf, dir, name) {
  const ent = dir.get(name);
  if (!ent) return null;

  const lh = ent.offset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;

  // csize can be 0 in the local header when a data descriptor is used; the
  // central directory value we already read is the authoritative one.
  const end = ent.csize > 0 ? start + ent.csize : buf.length;
  const raw = buf.subarray(start, Math.min(end, buf.length));

  if (ent.method === 0) return raw;
  if (ent.method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      // Truncated tail (common with data descriptors) — salvage what inflated.
      try {
        return zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        return null;
      }
    }
  }
  return null; // bzip2/lzma members are rare in OOXML; skip rather than guess.
}

/** All member names matching a predicate, in directory order. */
export function listZipEntries(dir, predicate) {
  const out = [];
  for (const name of dir.keys()) if (predicate(name)) out.push(name);
  return out;
}

// ------------------------------------------------------------- writing
// Only used by the self-test, which builds real .docx files so the proof
// exercises the same parsing path as a document off the user's disk.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Build a ZIP from [{name, data}] using stored (uncompressed) members. */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(body);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // fixed DOS date, keeps output deterministic
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

function findEOCD(buf) {
  const maxBack = Math.min(buf.length, 66 * 1024);
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return {
        pos: i,
        entries: buf.readUInt16LE(i + 10),
        cenOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  return null;
}
