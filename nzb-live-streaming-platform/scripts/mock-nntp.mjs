#!/usr/bin/env node
/**
 * Mock NNTP server + fixture generator for end-to-end testing.
 *
 *   node scripts/mock-nntp.mjs [--port 1190] [--http 1191] [--ttl 900]
 *
 * Builds these "posts" from scripts/fixtures/*:
 *   1. direct.nzb   — demo.mp4 + demo.jpg + readme.nfo + demo.srt posted directly (yEnc, 500KB parts)
 *   2. rar.nzb      — demo.mp4 inside a 3-volume STORED RAR4 set with obfuscated
 *                     subject + yEnc names; a PAR2 index reveals real names.
 *   3. zip.nzb      — demo.jpg + readme.nfo inside a stored ZIP
 *   4. broken.nzb   — like direct, but segment #3 of the mp4 is missing (430)
 *                     and segment #5 has a corrupted CRC.
 * NZBs are served over HTTP (http://127.0.0.1:1191/<name>.nzb) and written to
 * scripts/fixtures/out/. The process exits after --ttl seconds so it can never
 * wedge a CI shell.
 */
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "1"] : [])).filter((x) => x.length));
const PORT = Number(args.port ?? 1190);
const HTTP_PORT = Number(args.http ?? 1191);
const TTL = Number(args.ttl ?? 900);
const PART = 500 * 1000;
const here = path.dirname(new URL(import.meta.url).pathname);
const fx = path.join(here, "fixtures");
const out = path.join(fx, "out");
fs.mkdirSync(out, { recursive: true });

/* ------------------------------- helpers -------------------------------- */
const CRC_T = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const hex8 = (n) => n.toString(16).padStart(8, "0");

function yenc(data, { name, fileSize, part, total, begin, corrupt = false }) {
  const lineLen = 128;
  const head = `=ybegin part=${part} total=${total} line=${lineLen} size=${fileSize} name=${name}\r\n=ypart begin=${begin + 1} end=${begin + data.length}\r\n`;
  const bytes = [];
  let col = 0;
  for (let i = 0; i < data.length; i++) {
    let c = (data[i] + 42) & 0xff;
    let esc = c === 0 || c === 0x0a || c === 0x0d || c === 0x3d || (col === 0 && (c === 0x2e || c === 0x20 || c === 0x09)) || (col === lineLen - 1 && (c === 0x20 || c === 0x09));
    if (esc) {
      bytes.push(0x3d);
      c = (c + 64) & 0xff;
      col++;
    }
    bytes.push(c);
    if (++col >= lineLen) {
      bytes.push(0x0d, 0x0a);
      col = 0;
    }
  }
  if (col) bytes.push(0x0d, 0x0a);
  const crc = corrupt ? "deadbeef" : hex8(crc32(data));
  const tail = `=yend size=${data.length} part=${part} pcrc32=${crc}\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(bytes), Buffer.from(tail, "latin1")]);
}

/** dot-stuff an article body for the wire */
function dotStuff(buf) {
  const s = buf.toString("latin1").split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l));
  return Buffer.from(s.join("\r\n"), "latin1");
}

const articles = new Map(); // messageId -> Buffer (already stuffed) | { code: 430 }
let midSeq = 0;
const mid = () => `${Date.now().toString(36)}${(++midSeq).toString(36)}$${crypto.randomBytes(6).toString("hex")}@mock.nntp`;

/** Post a file → returns NZB <file> xml. */
function post(data, { yencName, subjectName = yencName, missing = [], corrupt = [] }) {
  const total = Math.ceil(data.length / PART);
  const segs = [];
  for (let p = 0; p < total; p++) {
    const chunk = data.subarray(p * PART, Math.min(data.length, (p + 1) * PART));
    const id = mid();
    const art = dotStuff(yenc(chunk, { name: yencName, fileSize: data.length, part: p + 1, total, begin: p * PART, corrupt: corrupt.includes(p) }));
    if (missing.includes(p)) articles.set(id, { code: 430 });
    else articles.set(id, art);
    segs.push(`   <segment bytes="${art.length}" number="${p + 1}">${id}</segment>`);
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return ` <file poster="mock@example.com" date="${Math.floor(Date.now() / 1000)}" subject="${esc(`[mock] "${subjectName}" yEnc (1/${total})`)}">\n  <groups><group>alt.binaries.test</group></groups>\n  <segments>\n${segs.join("\n")}\n  </segments>\n </file>`;
}
const nzb = (name, files) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n<head><meta type="name">${name}</meta></head>\n${files.join("\n")}\n</nzb>\n`;
  fs.writeFileSync(path.join(out, `${name}.nzb`), xml);
  return xml;
};

/* ---------------------------- RAR4 store writer --------------------------- */
function rar4Volumes(fileName, data, volCount) {
  const perVol = Math.ceil(data.length / volCount);
  const vols = [];
  const block = (type, flags, body, addSize) => {
    const size = 7 + body.length;
    const hdr = Buffer.alloc(7);
    hdr[2] = type;
    hdr.writeUInt16LE(flags, 3);
    hdr.writeUInt16LE(size, 5);
    const full = Buffer.concat([hdr, body]);
    const crc = crc32(full.subarray(2)) & 0xffff;
    full.writeUInt16LE(crc, 0);
    void addSize;
    return full;
  };
  const nameBuf = Buffer.from(fileName, "utf8");
  for (let v = 0; v < volCount; v++) {
    const chunk = data.subarray(v * perVol, Math.min(data.length, (v + 1) * perVol));
    const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    const main = block(0x73, 0x0001 | (v === 0 ? 0x0100 : 0), Buffer.alloc(6));
    const fh = Buffer.alloc(25 + nameBuf.length);
    fh.writeUInt32LE(chunk.length, 0); // pack size
    fh.writeUInt32LE(data.length, 4); // unp size
    fh[8] = 2; // host os windows
    fh.writeUInt32LE(crc32(chunk), 9);
    fh.writeUInt32LE(0, 13); // ftime
    fh[17] = 29; // unp ver
    fh[18] = 0x30; // method store
    fh.writeUInt16LE(nameBuf.length, 19);
    fh.writeUInt32LE(0x20, 21); // attr
    nameBuf.copy(fh, 25);
    const flags = 0x8000 | (v > 0 ? 0x01 : 0) | (v < volCount - 1 ? 0x02 : 0);
    const fileHdr = block(0x74, flags, fh);
    const end = block(0x7b, 0x4000 | (v < volCount - 1 ? 0x0001 : 0), Buffer.alloc(0));
    vols.push(Buffer.concat([marker, main, fileHdr, chunk, end]));
  }
  return vols;
}

/* ------------------------------ PAR2 writer ------------------------------ */
function par2Index(files /* [{name, data}] */) {
  const md5 = (b) => crypto.createHash("md5").update(b).digest();
  const packets = [];
  const descs = files.map(({ name, data }) => {
    const nameBuf = Buffer.from(name, "utf8");
    const padded = Buffer.alloc(Math.ceil(nameBuf.length / 4) * 4);
    nameBuf.copy(padded);
    const md5full = md5(data);
    const md5_16k = md5(data.subarray(0, 16384));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(data.length));
    const fileId = md5(Buffer.concat([md5_16k, len, nameBuf]));
    return { fileId, body: Buffer.concat([fileId, md5full, md5_16k, len, padded]) };
  });
  const sliceSize = Buffer.alloc(8);
  sliceSize.writeBigUInt64LE(BigInt(PART));
  const nfiles = Buffer.alloc(4);
  nfiles.writeUInt32LE(descs.length);
  const mainBody = Buffer.concat([sliceSize, nfiles, ...descs.map((d) => d.fileId)]);
  const setId = md5(mainBody);
  const packet = (type, body) => {
    const t = Buffer.alloc(16);
    Buffer.from(type, "latin1").copy(t);
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(64 + body.length));
    const tail = Buffer.concat([setId, t, body]);
    return Buffer.concat([Buffer.from("PAR2\0PKT", "latin1"), len, md5(tail), tail]);
  };
  packets.push(packet("PAR 2.0\0Main", mainBody));
  for (const d of descs) packets.push(packet("PAR 2.0\0FileDesc", d.body));
  return Buffer.concat(packets);
}

/* ------------------------------- fixtures -------------------------------- */
function ensureFixtures(fxDir) {
  const mp4Path = path.join(fxDir, "demo.mp4");
  const jpgPath = path.join(fxDir, "demo.jpg");
  if (!fs.existsSync(mp4Path)) {
    const size = 86800000;
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(0x18, 0);
    buf.write("ftyp", 4, "ascii");
    buf.write("isom", 8, "ascii");
    buf.writeUInt32BE(0x00000200, 12);
    buf.write("isom", 16, "ascii");
    buf.write("iso2", 20, "ascii");
    for (let i = 24; i <= size - 4; i += 4) {
      buf.writeUInt32BE((i * 1103515245 + 12345) >>> 0, i);
    }
    fs.writeFileSync(mp4Path, buf);
  }
  if (!fs.existsSync(jpgPath)) {
    const size = 200000;
    const buf = Buffer.alloc(size);
    buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
    buf[4] = 0x00; buf[5] = 0x10;
    buf.write("JFIF", 6, "ascii");
    buf[10] = 0x00; buf[11] = 0x01; buf[12] = 0x01;
    for (let i = 13; i <= size - 4; i += 4) {
      buf.writeUInt32BE((i * 1664525 + 1013904223) >>> 0, i);
    }
    fs.writeFileSync(jpgPath, buf);
  }
}
ensureFixtures(fx);
const mp4 = fs.readFileSync(path.join(fx, "demo.mp4"));
const jpg = fs.readFileSync(path.join(fx, "demo.jpg"));
const nfo = Buffer.from(`nzb.stream mock release\n=======================\nvideo : demo.mp4 (${mp4.length} bytes)\nposted: ${new Date().toISOString()}\n`);
const srt = Buffer.from(`1\n00:00:00,500 --> 00:00:04,000\nStreamed live from usenet (yEnc → HTTP range)\n\n2\n00:00:04,500 --> 00:00:09,000\nNo download manager involved.\n`);

console.log(`[mock] building fixtures: mp4=${mp4.length}B jpg=${jpg.length}B`);
nzb("direct", [post(mp4, { yencName: "demo.mp4" }), post(jpg, { yencName: "demo.jpg" }), post(nfo, { yencName: "readme.nfo" }), post(srt, { yencName: "demo.en.srt" })]);

const vols = rar4Volumes("Demo.Release.2024.1080p.mp4", mp4, 3);
const volNames = vols.map((_, i) => `demo.release.part${i + 1}.rar`);
const par2 = par2Index(vols.map((v, i) => ({ name: volNames[i], data: v })));
const obf = () => crypto.randomBytes(16).toString("hex");
nzb("rar", [
  ...vols.map((v) => post(v, { yencName: obf(), subjectName: obf() })),
  post(par2, { yencName: "demo.release.par2" }),
  post(nfo, { yencName: "demo.release.nfo" }),
  post(srt, { yencName: "demo.release.srt" }),
]);
fs.writeFileSync(path.join(out, volNames[0]), vols[0]);

// zip (stored) via system zip
const zipTmp = path.join(out, "zipsrc");
fs.mkdirSync(zipTmp, { recursive: true });
fs.writeFileSync(path.join(zipTmp, "cover.jpg"), jpg);
fs.writeFileSync(path.join(zipTmp, "readme.nfo"), nfo);
const zipPath = path.join(out, "bundle.zip");
try {
  fs.rmSync(zipPath, { force: true });
  execFileSync("zip", ["-0", "-j", "-q", zipPath, path.join(zipTmp, "cover.jpg"), path.join(zipTmp, "readme.nfo")], { timeout: 20000 });
  nzb("zip", [post(fs.readFileSync(zipPath), { yencName: "bundle.zip" })]);
  const zipDeflate = path.join(out, "bundle-deflate.zip");
  fs.rmSync(zipDeflate, { force: true });
  execFileSync("zip", ["-9", "-j", "-q", zipDeflate, path.join(zipTmp, "cover.jpg"), path.join(zipTmp, "readme.nfo")], { timeout: 20000 });
  nzb("zipdeflate", [post(fs.readFileSync(zipDeflate), { yencName: "bundle-deflate.zip" })]);
} catch (e) {
  console.log("[mock] zip unavailable, skipping zip fixture:", e.message);
}

nzb("broken", [post(mp4, { yencName: "broken.mp4", missing: [2], corrupt: [4] }), post(nfo, { yencName: "readme.nfo" })]);
console.log(`[mock] ${articles.size} articles in memory; NZBs written to ${out}`);

/* ------------------------------ NNTP server ------------------------------ */
const server = net.createServer((sock) => {
  let buf = "";
  let user = null;
  sock.write("200 mock.nntp ready (posting prohibited)\r\n");
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const [cmd, ...rest] = line.split(" ");
      const C = cmd.toUpperCase();
      if (C === "AUTHINFO") {
        if (rest[0]?.toUpperCase() === "USER") {
          user = rest[1];
          sock.write("381 password required\r\n");
        } else sock.write(user === "test" && rest[1] === "test" ? "281 welcome\r\n" : "481 authentication failed\r\n");
      } else if (C === "GROUP") sock.write(`211 ${articles.size} 1 ${articles.size} ${rest[0]}\r\n`);
      else if (C === "DATE") sock.write(`111 ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}\r\n`);
      else if (C === "BODY") {
        const id = (rest[0] ?? "").replace(/^<|>$/g, "");
        const art = articles.get(id);
        if (!art || art.code) sock.write("430 no such article\r\n");
        else {
          sock.write(`222 0 <${id}> body\r\n`);
          sock.write(art);
          sock.write(art.length && !art.subarray(-2).equals(Buffer.from("\r\n")) ? "\r\n.\r\n" : ".\r\n");
        }
      } else if (C === "QUIT") {
        sock.end("205 bye\r\n");
      } else sock.write("500 unknown command\r\n");
    }
  });
  sock.on("error", () => {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`[mock] NNTP listening on 127.0.0.1:${PORT} (user test / pass test, or no auth)`));

http
  .createServer((req, res) => {
    const f = path.join(out, path.basename(req.url.split("?")[0]));
    if (!fs.existsSync(f)) return void (res.writeHead(404), res.end("not found"));
    res.writeHead(200, { "content-type": f.endsWith(".nzb") ? "application/x-nzb" : "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  })
  .listen(HTTP_PORT, "127.0.0.1", () => console.log(`[mock] HTTP fixtures on http://127.0.0.1:${HTTP_PORT}/{direct,rar,zip,broken}.nzb`));

setTimeout(() => {
  console.log("[mock] ttl reached, exiting");
  process.exit(0);
}, TTL * 1000).unref();
