/**
 * yEnc decoder (RFC-less usenet binary encoding). Works on a raw NNTP
 * article body (still dot-stuffed). Returns decoded bytes + header metadata
 * + CRC verification so diagnostics can show exactly what went wrong.
 */

export interface YencHeader {
  name?: string;
  size?: number; // total file size
  line?: number;
  part?: number;
  total?: number;
  begin?: number; // 1-based inclusive
  end?: number; // inclusive
}

export interface YencResult {
  data: Uint8Array;
  header: YencHeader;
  /** 0-based inclusive start offset of this part inside the file */
  begin: number;
  /** 0-based inclusive end offset */
  end: number;
  /** total file size according to =ybegin size= */
  fileSize: number | null;
  /** part crc as declared in =yend (pcrc32 or crc32) */
  declaredCrc: string | null;
  actualCrc: string;
  crcOk: boolean | null; // null if no crc declared
  declaredSize: number | null; // =yend size=
  sizeOk: boolean | null;
  encoding: "yenc" | "uuencode" | "raw";
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parseYLine(line: string): Record<string, string> {
  // "=ybegin part=1 total=10 line=128 size=123 name=foo bar.mkv"
  const out: Record<string, string> = {};
  const nameIdx = line.indexOf(" name=");
  let rest = line;
  if (nameIdx >= 0) {
    out.name = line.slice(nameIdx + 6).replace(/\r?\n$/, "");
    rest = line.slice(0, nameIdx);
  }
  for (const m of rest.matchAll(/(\w+)=([^\s]+)/g)) out[m[1]] = m[2];
  return out;
}

function indexOfSeq(buf: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

function lineEnd(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length; i++) if (buf[i] === 0x0a) return i;
  return buf.length;
}

const YBEGIN = [0x3d, 0x79, 0x62, 0x65, 0x67, 0x69, 0x6e, 0x20]; // "=ybegin "
const YPART = [0x3d, 0x79, 0x70, 0x61, 0x72, 0x74, 0x20]; // "=ypart "
const YEND = [0x3d, 0x79, 0x65, 0x6e, 0x64, 0x20]; // "=yend "

const td = new TextDecoder("latin1");

export function decodeYenc(body: Uint8Array): YencResult {
  // locate =ybegin at start of a line
  let yb = -1;
  let searchFrom = 0;
  while (true) {
    const idx = indexOfSeq(body, YBEGIN, searchFrom);
    if (idx < 0) break;
    if (idx === 0 || body[idx - 1] === 0x0a) {
      yb = idx;
      break;
    }
    searchFrom = idx + 1;
  }
  if (yb < 0) return decodeFallback(body);

  const ybEnd = lineEnd(body, yb);
  const header = parseYLine(td.decode(body.subarray(yb, ybEnd)).trim());
  let dataStart = ybEnd + 1;
  let partHdr: Record<string, string> | null = null;
  if (indexOfSeq(body, YPART, dataStart) === dataStart) {
    const pe = lineEnd(body, dataStart);
    partHdr = parseYLine(td.decode(body.subarray(dataStart, pe)).trim());
    dataStart = pe + 1;
  }
  // find =yend at start of a line, scanning backwards is cheaper (it is near the end)
  let ye = -1;
  let from = dataStart;
  while (true) {
    const idx = indexOfSeq(body, YEND, from);
    if (idx < 0) break;
    if (body[idx - 1] === 0x0a) {
      ye = idx;
      break;
    }
    from = idx + 1;
  }
  const dataEnd = ye >= 0 ? ye : body.length;
  const endHdr = ye >= 0 ? parseYLine(td.decode(body.subarray(ye, lineEnd(body, ye))).trim()) : {};

  // decode
  const out = new Uint8Array(dataEnd - dataStart);
  let o = 0;
  let atLineStart = true;
  for (let i = dataStart; i < dataEnd; i++) {
    let b = body[i];
    if (b === 0x0d || b === 0x0a) {
      atLineStart = b === 0x0a ? true : atLineStart;
      continue;
    }
    if (atLineStart) {
      atLineStart = false;
      // NNTP dot-stuffing: a line beginning with ".." is really "."
      if (b === 0x2e && body[i + 1] === 0x2e) {
        continue; // skip the stuffed dot, next iteration handles the real one
      }
    }
    if (b === 0x3d) {
      i++;
      if (i >= dataEnd) break;
      b = (body[i] - 64) & 0xff;
    }
    out[o++] = (b - 42) & 0xff;
  }
  const data = out.subarray(0, o);

  const fileSize = header.size ? Number(header.size) : null;
  const begin = partHdr?.begin ? Number(partHdr.begin) - 1 : 0;
  const end = partHdr?.end ? Number(partHdr.end) - 1 : begin + data.length - 1;
  const declaredCrc = (endHdr.pcrc32 ?? endHdr.crc32 ?? null)?.toLowerCase() ?? null;
  const actualCrc = crc32(data).toString(16).padStart(8, "0");
  const declaredSize = endHdr.size ? Number(endHdr.size) : null;

  return {
    data,
    header: {
      name: header.name,
      size: fileSize ?? undefined,
      line: header.line ? Number(header.line) : undefined,
      part: header.part ? Number(header.part) : undefined,
      total: header.total ? Number(header.total) : undefined,
      begin: partHdr?.begin ? Number(partHdr.begin) : undefined,
      end: partHdr?.end ? Number(partHdr.end) : undefined,
    },
    begin,
    end,
    fileSize,
    declaredCrc,
    actualCrc,
    crcOk: declaredCrc ? declaredCrc.replace(/^0+/, "") === actualCrc.replace(/^0+/, "") : null,
    declaredSize,
    sizeOk: declaredSize != null ? declaredSize === data.length : null,
    encoding: "yenc",
  };
}

/** uuencode fallback (rare, but old posts use it) — else raw body. */
function decodeFallback(body: Uint8Array): YencResult {
  const text = td.decode(body);
  const m = /^begin \d{3} (.+)$/m.exec(text);
  if (m) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith("begin "));
    const chunks: number[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l === "end" || l === "`" || l.length === 0) {
        if (l === "end") break;
        continue;
      }
      const n = (l.charCodeAt(0) - 32) & 0x3f;
      let produced = 0;
      for (let j = 1; j + 3 < l.length + 1 && produced < n; j += 4) {
        const c = [0, 1, 2, 3].map((k) => ((l.charCodeAt(j + k) || 32) - 32) & 0x3f);
        const bytes = [
          (c[0] << 2) | (c[1] >> 4),
          ((c[1] & 0xf) << 4) | (c[2] >> 2),
          ((c[2] & 0x3) << 6) | c[3],
        ];
        for (const bt of bytes) {
          if (produced < n) {
            chunks.push(bt & 0xff);
            produced++;
          }
        }
      }
    }
    const data = Uint8Array.from(chunks);
    return {
      data,
      header: { name: m[1].trim() },
      begin: 0,
      end: data.length - 1,
      fileSize: null,
      declaredCrc: null,
      actualCrc: crc32(data).toString(16).padStart(8, "0"),
      crcOk: null,
      declaredSize: null,
      sizeOk: null,
      encoding: "uuencode",
    };
  }
  // raw: strip dot stuffing line-wise
  const parts: Uint8Array[] = [];
  let lineStart = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === 0x0a) {
      let s = lineStart;
      if (body[s] === 0x2e && body[s + 1] === 0x2e) s++;
      parts.push(body.subarray(s, Math.min(i + 1, body.length)));
      lineStart = i + 1;
    }
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const data = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return {
    data,
    header: {},
    begin: 0,
    end: data.length - 1,
    fileSize: null,
    declaredCrc: null,
    actualCrc: crc32(data).toString(16).padStart(8, "0"),
    crcOk: null,
    declaredSize: null,
    sizeOk: null,
    encoding: "raw",
  };
}

/** Encoder — used by the mock NNTP server / e2e fixtures. */
export function encodeYencPart(
  data: Uint8Array,
  opts: { name: string; fileSize: number; part: number; total: number; begin: number; lineLen?: number },
): Uint8Array {
  const lineLen = opts.lineLen ?? 128;
  const outParts: string[] = [];
  outParts.push(
    `=ybegin part=${opts.part} total=${opts.total} line=${lineLen} size=${opts.fileSize} name=${opts.name}\r\n`,
  );
  outParts.push(`=ypart begin=${opts.begin + 1} end=${opts.begin + data.length}\r\n`);
  const bytes: number[] = [];
  let col = 0;
  for (let i = 0; i < data.length; i++) {
    let c = (data[i] + 42) & 0xff;
    let escape = c === 0x00 || c === 0x0a || c === 0x0d || c === 0x3d;
    if (!escape && col === 0 && (c === 0x2e || c === 0x09 || c === 0x20)) escape = true; // leading dot/space
    if (!escape && col === lineLen - 1 && (c === 0x09 || c === 0x20)) escape = true; // trailing
    if (escape) {
      bytes.push(0x3d);
      c = (c + 64) & 0xff;
      col++;
    }
    bytes.push(c);
    col++;
    if (col >= lineLen) {
      bytes.push(0x0d, 0x0a);
      col = 0;
    }
  }
  if (col !== 0) bytes.push(0x0d, 0x0a);
  const crc = crc32(data).toString(16).padStart(8, "0");
  outParts.push(`=yend size=${data.length} part=${opts.part} pcrc32=${crc}\r\n`);
  const head = new TextEncoder().encode(outParts[0] + outParts[1]);
  const tail = new TextEncoder().encode(outParts[2]);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}
