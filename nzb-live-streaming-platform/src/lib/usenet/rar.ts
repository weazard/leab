/**
 * RAR 4.x and RAR 5.x header walker over random-access volumes.
 *
 * Usenet releases are almost always "stored" (method 0 / m0) multi-volume
 * archives, which means the media file bytes are laid out verbatim across
 * the volumes. We map each archived file to a list of (volume, offset, len)
 * chunks and can then serve byte ranges without downloading everything.
 * Compressed / encrypted entries are reported (with the reason) but can't be
 * streamed.
 */
import type { RandomReader } from "./virtualfile";
import type { Diag } from "./diag";

export interface ArchiveChunk {
  volume: number; // index into volumes[]
  offset: number; // offset inside that volume
  length: number;
}

export interface ArchiveEntry {
  name: string;
  size: number; // unpacked size
  packedSize: number;
  method: string; // "store" | "compressed(mX)" | ...
  stored: boolean;
  encrypted: boolean;
  isDir: boolean;
  chunks: ArchiveChunk[];
  format: "rar4" | "rar5" | "zip";
  crc?: string;
}

export interface ArchiveInfo {
  format: "rar4" | "rar5" | "zip" | "unknown";
  entries: ArchiveEntry[];
  encryptedHeaders: boolean;
  volumesParsed: number;
  warnings: string[];
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const RAR4_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const RAR5_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

function hasSig(b: Uint8Array, sig: number[]) {
  return sig.every((v, i) => b[i] === v);
}

export function detectRarFormat(head: Uint8Array): "rar4" | "rar5" | null {
  if (hasSig(head, RAR5_SIG)) return "rar5";
  if (hasSig(head, RAR4_SIG)) return "rar4";
  return null;
}

const td = new TextDecoder();

interface VolResult {
  parts: Array<{ name: string; size: number; packedSize: number; method: string; stored: boolean; encrypted: boolean; isDir: boolean; offset: number; splitBefore: boolean; splitAfter: boolean; crc?: string }>;
  format: "rar4" | "rar5";
  encryptedHeaders: boolean;
  warnings: string[];
}

/** Buffered reader: fetches windows so header parsing doesn't issue tiny reads. */
class Window {
  private buf: Uint8Array = new Uint8Array(0);
  private bufStart = 0;
  constructor(private readonly r: RandomReader) {}
  async get(offset: number, len: number): Promise<Uint8Array> {
    if (offset < this.bufStart || offset + len > this.bufStart + this.buf.length) {
      const want = Math.max(len, 64 * 1024);
      const avail = Math.max(0, Math.min(want, this.r.size - offset));
      this.buf = await this.r.read(offset, avail);
      this.bufStart = offset;
    }
    const rel = offset - this.bufStart;
    return this.buf.subarray(rel, rel + len);
  }
}

async function parseRar4Volume(r: RandomReader, w: Window, warnings: string[]): Promise<VolResult> {
  const parts: VolResult["parts"] = [];
  let pos = 7;
  let encryptedHeaders = false;
  const size = r.size;
  while (pos + 7 <= size) {
    const h = await w.get(pos, Math.min(7 + 4 + 32 + 1024, size - pos));
    if (h.length < 7) break;
    const v = dv(h);
    const type = h[2];
    const flags = v.getUint16(3, true);
    let headSize = v.getUint16(5, true);
    let addSize = 0;
    if (flags & 0x8000 && h.length >= 11) addSize = v.getUint32(7, true);
    if (headSize < 7) {
      warnings.push(`rar4: corrupt header at ${pos}`);
      break;
    }
    if (type === 0x73) {
      if (flags & 0x0080) encryptedHeaders = true;
    } else if (type === 0x74) {
      // file header
      if (h.length < 32) break;
      const packLo = v.getUint32(7, true);
      const unpLo = v.getUint32(11, true);
      const crc = v.getUint32(16, true);
      const method = h[25];
      const nameSize = v.getUint16(26, true);
      let off = 32;
      let packSize = packLo;
      let unpSize = unpLo;
      if (flags & 0x100) {
        packSize = v.getUint32(32, true) * 2 ** 32 + packLo;
        unpSize = v.getUint32(36, true) * 2 ** 32 + unpLo;
        off = 40;
      }
      let nameBytes = h.subarray(off, off + nameSize);
      if (nameBytes.length < nameSize) {
        const full = await w.get(pos, headSize);
        nameBytes = full.subarray(off, off + nameSize);
      }
      let name: string;
      if (flags & 0x200) {
        const z = nameBytes.indexOf(0);
        name = z >= 0 ? td.decode(nameBytes.subarray(0, z)) : td.decode(nameBytes);
      } else name = td.decode(nameBytes);
      name = name.replace(/\\/g, "/");
      const isDir = (flags & 0xe0) === 0xe0;
      parts.push({
        name,
        size: unpSize,
        packedSize: packSize,
        method: method === 0x30 ? "store" : `compressed(m${method - 0x30})`,
        stored: method === 0x30,
        encrypted: !!(flags & 0x04),
        isDir,
        offset: pos + headSize,
        splitBefore: !!(flags & 0x01),
        splitAfter: !!(flags & 0x02),
        crc: crc.toString(16).padStart(8, "0"),
      });
      addSize = packSize;
    } else if (type === 0x7b) {
      break; // end of archive
    }
    pos += headSize + addSize;
    // Avoid fetching a whole extra segment just to read a 7-byte end block.
    if (size - pos <= 64) break;
  }
  return { parts, format: "rar4", encryptedHeaders, warnings };
}

function vint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  let shift = 0;
  let i = p;
  while (i < b.length) {
    const c = b[i++];
    v += (c & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(c & 0x80)) break;
  }
  return [v, i];
}

async function parseRar5Volume(r: RandomReader, w: Window, warnings: string[]): Promise<VolResult> {
  const parts: VolResult["parts"] = [];
  let pos = 8;
  let encryptedHeaders = false;
  const size = r.size;
  while (pos + 7 <= size) {
    const h = await w.get(pos, Math.min(4096, size - pos));
    if (h.length < 7) break;
    let p = 4; // skip crc
    const [headSize, p1] = vint(h, p);
    p = p1;
    const headStart = p; // header data start (relative)
    const [type, p2] = vint(h, p);
    p = p2;
    const [hflags, p3] = vint(h, p);
    p = p3;
    let extraSize = 0;
    let dataSize = 0;
    if (hflags & 0x01) {
      const [es, pn] = vint(h, p);
      extraSize = es;
      p = pn;
    }
    if (hflags & 0x02) {
      const [ds, pn] = vint(h, p);
      dataSize = ds;
      p = pn;
    }
    const totalHead = headStart + headSize;
    if (type === 4) encryptedHeaders = true;
    if (type === 5) break; // end of archive
    if (type === 2 || type === 3) {
      // file / service header
      const [fflags, q1] = vint(h, p);
      const [unpSize, q2] = vint(h, q1);
      const [, q3] = vint(h, q2); // attributes
      let q = q3;
      if (fflags & 0x02) q += 4; // mtime
      let crc: string | undefined;
      if (fflags & 0x04) {
        crc = dv(h).getUint32(q, true).toString(16).padStart(8, "0");
        q += 4;
      }
      const [compInfo, q4] = vint(h, q);
      const [, q5] = vint(h, q4); // host os
      const [nameLen, q6] = vint(h, q5);
      const name = td.decode(h.subarray(q6, q6 + nameLen));
      const method = (compInfo >> 7) & 7;
      let encrypted = false;
      // extra records: type 1 = file encryption
      if (extraSize) {
        let e = q6 + nameLen;
        const eEnd = totalHead;
        while (e < eEnd && e < h.length) {
          const [rsize, e1] = vint(h, e);
          const [rtype] = vint(h, e1);
          if (rtype === 1) encrypted = true;
          e = e1 + rsize;
          if (rsize === 0) break;
        }
      }
      if (type === 2) {
        parts.push({
          name,
          size: unpSize,
          packedSize: dataSize,
          method: method === 0 ? "store" : `compressed(m${method})`,
          stored: method === 0,
          encrypted,
          isDir: !!(fflags & 0x01),
          offset: pos + totalHead,
          splitBefore: !!(hflags & 0x08),
          splitAfter: !!(hflags & 0x10),
          crc,
        });
      }
    }
    if (totalHead <= 4) {
      warnings.push(`rar5: corrupt header at ${pos}`);
      break;
    }
    pos += totalHead + dataSize;
    if (size - pos <= 64) break;
  }
  return { parts, format: "rar5", encryptedHeaders, warnings };
}

/**
 * Parse an ordered list of volumes into archive entries. Volumes are parsed
 * concurrently (each needs at least its first segment fetched).
 */
export async function parseRarSet(volumes: RandomReader[], diag: Diag, concurrency = 8): Promise<ArchiveInfo> {
  const warnings: string[] = [];
  const results: (VolResult | null)[] = new Array(volumes.length).fill(null);
  let next = 0;
  let format: "rar4" | "rar5" | "unknown" = "unknown";
  const worker = async () => {
    while (next < volumes.length) {
      const i = next++;
      const r = volumes[i];
      try {
        const w = new Window(r);
        const head = await w.get(0, Math.min(8, r.size));
        const fmt = detectRarFormat(head);
        if (!fmt) {
          warnings.push(`${r.name}: not a RAR volume`);
          diag.warn("archive", `${r.name}: no RAR signature`);
          continue;
        }
        format = fmt;
        const t0 = Date.now();
        results[i] = fmt === "rar5" ? await parseRar5Volume(r, w, warnings) : await parseRar4Volume(r, w, warnings);
        diag.debug("archive", `${r.name}: ${fmt} volume ${i + 1}/${volumes.length} parsed in ${Date.now() - t0}ms — ${results[i]!.parts.length} file header(s)`, {
          volume: i,
          parts: results[i]!.parts.map((p) => ({ name: p.name, packed: p.packedSize, offset: p.offset, splitBefore: p.splitBefore, splitAfter: p.splitAfter })),
        });
      } catch (e) {
        warnings.push(`${r.name}: ${(e as Error).message}`);
        diag.error("archive", `${r.name}: parse failed: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, volumes.length) }, worker));

  // stitch continued files across volumes (by name, in volume order)
  const entries: ArchiveEntry[] = [];
  const byName = new Map<string, ArchiveEntry>();
  let encryptedHeaders = false;
  results.forEach((vr, vi) => {
    if (!vr) return;
    if (vr.encryptedHeaders) encryptedHeaders = true;
    for (const p of vr.parts) {
      if (p.isDir) continue;
      let e = p.splitBefore ? byName.get(p.name) : undefined;
      if (!e) {
        e = {
          name: p.name,
          size: p.size,
          packedSize: 0,
          method: p.method,
          stored: p.stored,
          encrypted: p.encrypted,
          isDir: false,
          chunks: [],
          format: vr.format,
          crc: p.crc,
        };
        entries.push(e);
        byName.set(p.name, e);
      }
      e.packedSize += p.packedSize;
      e.chunks.push({ volume: vi, offset: p.offset, length: p.packedSize });
    }
  });
  for (const e of entries) {
    const mapped = e.chunks.reduce((n, c) => n + c.length, 0);
    if (e.stored && mapped !== e.size) {
      warnings.push(`${e.name}: mapped ${mapped} of ${e.size} bytes (missing volumes?)`);
      diag.warn("archive", `${e.name}: only ${mapped}/${e.size} bytes mapped across ${e.chunks.length} volume(s)`);
    }
  }
  diag.info("archive", `RAR set parsed: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, format=${format}, volumes=${results.filter(Boolean).length}/${volumes.length}${encryptedHeaders ? ", ENCRYPTED HEADERS" : ""}`, {
    entries: entries.map((e) => ({ name: e.name, size: e.size, method: e.method, chunks: e.chunks.length })),
  });
  return { format, entries, encryptedHeaders, volumesParsed: results.filter(Boolean).length, warnings };
}

/** Group + order RAR volumes by their file names. */
export function rarVolumeKey(name: string): { base: string; index: number } | null {
  const n = name.toLowerCase();
  let m = /^(.*?)\.part(\d+)\.rar$/.exec(n);
  if (m) return { base: m[1], index: parseInt(m[2], 10) };
  m = /^(.*?)\.r(\d{2,3})$/.exec(n);
  if (m) return { base: m[1], index: parseInt(m[2], 10) + 1 };
  m = /^(.*?)\.rar$/.exec(n);
  if (m) return { base: m[1], index: 0 };
  m = /^(.*?)\.(\d{3})$/.exec(n);
  if (m && !/\.(mp4|mkv|avi|ts)$/.test(m[1])) return { base: m[1], index: parseInt(m[2], 10) };
  return null;
}
