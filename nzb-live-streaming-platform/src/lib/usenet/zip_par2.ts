/**
 * ZIP (stored entries → streamable) and PAR2 (recover real filenames of
 * obfuscated posts + expose integrity metadata) parsers.
 */
import type { RandomReader } from "./virtualfile";
import type { ArchiveEntry, ArchiveInfo } from "./rar";
import type { Diag } from "./diag";

const td = new TextDecoder();
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export async function parseZip(r: RandomReader, diag: Diag): Promise<ArchiveInfo> {
  const warnings: string[] = [];
  const tailLen = Math.min(r.size, 66 * 1024);
  const tail = await r.read(r.size - tailLen, tailLen);
  // find End Of Central Directory
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    diag.warn("archive", `${r.name}: ZIP central directory not found (truncated?)`);
    return { format: "zip", entries: [], encryptedHeaders: false, volumesParsed: 0, warnings: ["no EOCD"] };
  }
  const v = dv(tail);
  let cdSize = v.getUint32(eocd + 12, true);
  let cdOffset = v.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // ZIP64 locator sits 20 bytes before EOCD
    const loc = eocd - 20;
    if (loc >= 0 && tail[loc] === 0x50 && tail[loc + 1] === 0x4b && tail[loc + 2] === 0x06 && tail[loc + 3] === 0x07) {
      const z64Off = Number(v.getBigUint64(loc + 8, true));
      const z = await r.read(z64Off, 56);
      const zv = dv(z);
      cdSize = Number(zv.getBigUint64(40, true));
      cdOffset = Number(zv.getBigUint64(48, true));
    }
  }
  const cd = await r.read(cdOffset, cdSize);
  const cv = dv(cd);
  const entries: ArchiveEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50) {
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    let compSize = cv.getUint32(p + 20, true);
    let uncompSize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let localOff = cv.getUint32(p + 42, true);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // zip64 extra
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cv.getUint16(e, true);
        const sz = cv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) {
            uncompSize = Number(cv.getBigUint64(q, true));
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(cv.getBigUint64(q, true));
            q += 8;
          }
          if (localOff === 0xffffffff) localOff = Number(cv.getBigUint64(q, true));
        }
        e += 4 + sz;
      }
    }
    const isDir = name.endsWith("/");
    if (!isDir) {
      entries.push({
        name,
        size: uncompSize,
        packedSize: compSize,
        method: method === 0 ? "store" : method === 8 ? "compressed(deflate)" : `compressed(${method})`,
        stored: method === 0,
        encrypted: !!(flags & 0x1),
        isDir,
        chunks: [{ volume: 0, offset: localOff, length: compSize }], // offset fixed up lazily (local header)
        format: "zip",
        crc: crc.toString(16).padStart(8, "0"),
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  // resolve local header sizes for stored entries (30 + n + m)
  for (const e of entries) {
    if (!e.stored) continue;
    const lh = await r.read(e.chunks[0].offset, 30);
    const lv = dv(lh);
    if (lv.getUint32(0, true) !== 0x04034b50) {
      warnings.push(`${e.name}: bad local header`);
      continue;
    }
    const n = lv.getUint16(26, true);
    const m = lv.getUint16(28, true);
    e.chunks[0].offset += 30 + n + m;
  }
  diag.info("archive", `ZIP parsed: ${entries.length} entries in ${r.name}`, {
    entries: entries.map((e) => ({ name: e.name, size: e.size, method: e.method })),
  });
  return { format: "zip", entries, encryptedHeaders: false, volumesParsed: 1, warnings };
}

/* ----------------------------------- PAR2 ---------------------------------- */

export interface Par2File {
  id: string;
  name: string;
  size: number;
  md5: string;
  md5_16k: string;
}

export interface Par2Info {
  setId: string;
  sliceSize: number;
  files: Par2File[];
  recoveryBlocks: number;
  packets: number;
}

const PAR2_MAGIC = [0x50, 0x41, 0x52, 0x32, 0x00, 0x50, 0x4b, 0x54]; // "PAR2\0PKT"

function hex(b: Uint8Array) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Parses a (small, index) PAR2 file. Reads it fully — index par2 files are tiny. */
export async function parsePar2(r: RandomReader, diag: Diag, maxBytes = 4 * 1024 * 1024): Promise<Par2Info | null> {
  const len = Math.min(r.size, maxBytes);
  const buf = await r.read(0, len);
  const v = dv(buf);
  let p = 0;
  const files: Par2File[] = [];
  let sliceSize = 0;
  let setId = "";
  let recovery = 0;
  let packets = 0;
  while (p + 64 <= buf.length) {
    if (!PAR2_MAGIC.every((m, i) => buf[p + i] === m)) {
      p++;
      continue;
    }
    const plen = Number(v.getBigUint64(p + 8, true));
    if (plen < 64 || p + plen > buf.length) break;
    packets++;
    setId ||= hex(buf.subarray(p + 32, p + 48));
    const type = td.decode(buf.subarray(p + 48, p + 64)).replace(/\0+$/, "");
    const body = buf.subarray(p + 64, p + plen);
    if (type === "PAR 2.0\0Main") {
      sliceSize = Number(new DataView(body.buffer, body.byteOffset).getBigUint64(0, true));
    } else if (type === "PAR 2.0\0FileDesc") {
      const id = hex(body.subarray(0, 16));
      const md5 = hex(body.subarray(16, 32));
      const md5_16k = hex(body.subarray(32, 48));
      const size = Number(new DataView(body.buffer, body.byteOffset).getBigUint64(48, true));
      const name = td.decode(body.subarray(56)).replace(/\0+$/, "");
      if (!files.some((f) => f.id === id)) files.push({ id, name, size, md5, md5_16k });
    } else if (type === "PAR 2.0\0RecvSlic") {
      recovery++;
    }
    p += plen;
  }
  if (!packets) {
    diag.warn("archive", `${r.name}: no PAR2 packets found`);
    return null;
  }
  diag.info("archive", `PAR2 index parsed: ${files.length} protected file(s), slice=${sliceSize}B, recovery blocks in this file=${recovery}`, {
    files: files.map((f) => ({ name: f.name, size: f.size, md5: f.md5 })),
  });
  return { setId, sliceSize, files, recoveryBlocks: recovery, packets };
}
