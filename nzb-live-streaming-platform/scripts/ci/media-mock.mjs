#!/usr/bin/env node
/**
 * NNTP mock that serves REAL media files as multi-part yEnc posts.
 *
 * The built-in `scripts/mock-nntp.mjs` fixtures are PRNG filler: fine for
 * byte-exactness, useless for answering "does it play, and is there sound?".
 * This one posts whatever is in a directory, so CI can stream actual
 * H.264/AAC and H.264/AC3 files through the whole pipeline.
 *
 * Usage:
 *   node scripts/ci/media-mock.mjs --dir scripts/fixtures/out/media \
 *        --port 1590 --http 1591 --part 900000 [--delay-ms 20]
 *
 * NZBs are served at /<filename>.nzb — e.g. /faststart.mp4.nzb
 */
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const dir = path.resolve(arg("dir", "scripts/fixtures/out/media"));
const PORT = Number(arg("port", 1590));
const HTTP = Number(arg("http", 1591));
const PART = Number(arg("part", 900 * 1024));
const DELAY = Number(arg("delay-ms", 0));
const TTL = Number(arg("ttl", 3600));

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function yencPart(d, part, total, size, begin, name) {
  const LINE = 128;
  let col = 0;
  const out = [];
  for (let i = 0; i < d.length; i++) {
    let c = (d[i] + 42) & 0xff;
    const esc =
      c === 0 ||
      c === 0x0a ||
      c === 0x0d ||
      c === 0x3d ||
      (col === 0 && (c === 0x2e || c === 0x20 || c === 0x09)) ||
      (col === LINE - 1 && (c === 0x20 || c === 0x09));
    if (esc) {
      out.push(0x3d);
      c = (c + 64) & 0xff;
      col++;
    }
    out.push(c);
    col++;
    if (col >= LINE) {
      out.push(0x0d, 0x0a);
      col = 0;
    }
  }
  if (col) out.push(0x0d, 0x0a);
  const head = Buffer.from(
    `=ybegin part=${part} total=${total} line=128 size=${size} name=${name}\r\n=ypart begin=${begin + 1} end=${begin + d.length}\r\n`,
  );
  const tail = Buffer.from(`=yend size=${d.length} part=${part} pcrc32=${crc32(d).toString(16).padStart(8, "0")}\r\n`);
  return Buffer.concat([head, Buffer.from(out), tail]);
}

if (!fs.existsSync(dir)) {
  console.error(`[media-mock] no such directory: ${dir}`);
  process.exit(1);
}

const bodies = new Map();
const nzbs = new Map();
const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !f.endsWith(".nzb"));

for (const name of files) {
  const data = fs.readFileSync(path.join(dir, name));
  const total = Math.ceil(data.length / PART);
  const ids = [];
  for (let i = 0; i < total; i++) {
    const id = `${name.replace(/\W/g, "")}part${i}@media.mock`;
    ids.push(id);
    bodies.set(id, yencPart(data.subarray(i * PART, Math.min(data.length, (i + 1) * PART)), i + 1, total, data.length, i * PART, name));
  }
  nzbs.set(
    `/${name}.nzb`,
    `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="mock@poster" date="1700000000" subject="${name} (1/${total})">
<groups><group>alt.binaries.test</group></groups><segments>
${ids.map((id, i) => `<segment bytes="${bodies.get(id).length}" number="${i + 1}">${id}</segment>`).join("\n")}
</segments></file></nzb>`,
  );
  console.log(`[media-mock] ${name}: ${data.length}B in ${total} parts of ${PART}B`);
}

net
  .createServer((s) => {
    s.write("200 media mock ready (posting prohibited)\r\n");
    let buf = "";
    s.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let nl;
      while ((nl = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.split(" ")[0].toUpperCase();
        if (cmd === "AUTHINFO") s.write("281 ok\r\n");
        else if (cmd === "BODY") {
          const id = /<([^>]+)>/.exec(line)?.[1] ?? "";
          const body = bodies.get(id);
          if (!body) {
            s.write("430 no such article\r\n");
            continue;
          }
          s.write("222 body follows\r\n");
          void (async () => {
            for (let i = 0; i < body.length; i += 64 * 1024) {
              if (s.destroyed) return;
              s.write(body.subarray(i, Math.min(body.length, i + 64 * 1024)));
              if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
            }
            try {
              s.write(Buffer.from(".\r\n"));
            } catch {
              /* client gone */
            }
          })();
          return;
        } else if (cmd === "QUIT") {
          s.write("205 bye\r\n");
          s.end();
        } else {
          s.write("500 unknown command\r\n");
        }
      }
    });
    s.on("error", () => {});
  })
  .listen(PORT, "127.0.0.1", () => console.log(`[media-mock] NNTP on 127.0.0.1:${PORT}`));

http
  .createServer((q, r) => {
    const body = nzbs.get(q.url);
    if (!body) {
      r.writeHead(404);
      r.end("no such nzb");
      return;
    }
    r.writeHead(200, { "content-type": "application/x-nzb" });
    r.end(body);
  })
  .listen(HTTP, "127.0.0.1", () =>
    console.log(`[media-mock] NZBs on http://127.0.0.1:${HTTP}/${files.map((f) => f + ".nzb").join(" ")}`),
  );

setTimeout(() => process.exit(0), TTL * 1000).unref?.();
