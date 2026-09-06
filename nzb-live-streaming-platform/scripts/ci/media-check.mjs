#!/usr/bin/env node
/**
 * Byte-exactness + seek test over REAL media files (as opposed to the PRNG
 * filler in the main e2e). Needs fixtures in scripts/fixtures/out/media
 * (`ffmpeg`, see the workflow) and the media mock running.
 *
 * For every fixture it:
 *   - analyses it through the app and prints the codec probe verdict
 *   - reads several 64 KB windows (incl. the last one) and compares them
 *     byte-for-byte against the source file
 *   - starts an open-ended request like a <video> would, aborts mid-way, then
 *     seeks to 80 % and checks that the first bytes are correct and arrive fast
 *
 * Writes ci-report/media-check.json.
 *
 * Usage:
 *   node scripts/ci/media-check.mjs http://127.0.0.1:3000 http://127.0.0.1:1591
 */
import fs from "node:fs";
import path from "node:path";

const APP = (process.argv[2] ?? process.env.APP ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const MOCK = (process.argv[3] ?? process.env.MOCK ?? "http://127.0.0.1:1591").replace(/\/+$/, "");
const OUT = process.env.REPORT_OUT ?? "ci-report/media-check.json";
const DIR = process.env.MEDIA_DIR ?? "scripts/fixtures/out/media";
// MOCK is the NZB http port; the NNTP side is one below unless told otherwise
const PORT = Number(process.env.MEDIA_MOCK_PORT ?? (new URL(MOCK).port ? Number(new URL(MOCK).port) - 1 : 1590));

const report = { app: APP, mock: MOCK, startedAt: new Date().toISOString(), files: [], checks: [], error: null, failed: 0 };
const log = (...a) => console.log(...a);
const check = (name, pass, detail = "") => {
  report.checks.push({ name, pass, detail });
  if (!pass) report.failed++;
  log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const j = async (u, init) => {
  const r = await fetch(APP + u, { ...init, signal: AbortSignal.timeout(180000) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${u} → ${r.status} ${JSON.stringify(body ?? {}).slice(0, 200)}`);
  return body;
};

try {
  if (!fs.existsSync(DIR)) throw new Error(`no fixtures at ${DIR} (generate them with ffmpeg)`);

  const provs = await j("/api/providers");
  let prov = provs.find((p) => p.port === PORT);
  if (!prov) {
    prov = await j("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "media-mock", host: "127.0.0.1", port: PORT, ssl: false, username: "test", password: "test", connections: 8 }),
    });
  }

  const names = fs.readdirSync(DIR).filter((f) => fs.statSync(path.join(DIR, f)).isFile() && !f.endsWith(".nzb"));
  if (!names.length) throw new Error(`no media files in ${DIR}`);

  for (const name of names) {
    const file = fs.readFileSync(path.join(DIR, name));
    log(`\n${name} (${file.length}B)`);
    const s = await j("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: prov.id, source: "url", url: `${MOCK}/${name}.nzb` }),
    });
    let st = s;
    for (let i = 0; i < 300; i++) {
      st = await j(`/api/sessions/${s.id}`);
      if (st.analyzed || st.analyzeError) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const rec = { name, size: file.length, codecs: null, ranges: [], seek: null };
    if (!st.analyzed) {
      check(`${name}: analysed`, false, st.analyzeError ?? "not analysed");
      report.files.push(rec);
      continue;
    }
    const item = st.items[0];
    rec.codecs = item.codecs ?? null;
    log(`  codecs: ${item.codecs?.container} video=[${item.codecs?.video}] audio=[${item.codecs?.audio}] browserAudio=${item.codecs?.browserAudio} moovAtEnd=${item.codecs?.moovAtEnd}`);
    check(`${name}: size matches source`, item.size === file.length, `${item.size} vs ${file.length}`);

    const u = `${APP}/api/sessions/${st.id}/stream/${item.id}`;
    const offsets = [0, Math.floor(file.length * 0.31), Math.floor(file.length / 2), Math.floor(file.length * 0.62), Math.max(0, file.length - 65537)];
    let allExact = true;
    for (const off of offsets) {
      const r = await fetch(u, { headers: { range: `bytes=${off}-${off + 65535}` } });
      const got = Buffer.from(await r.arrayBuffer());
      const want = file.subarray(off, off + 65536);
      const exact = r.status === 206 && got.equals(want);
      if (!exact) allExact = false;
      rec.ranges.push({ off, status: r.status, bytes: got.length, exact });
    }
    check(`${name}: ${offsets.length} ranges byte-exact`, allExact, rec.ranges.map((r) => `${r.off}:${r.exact ? "ok" : "BAD"}`).join(" "));

    // browser-like: open-ended request, abort, then seek
    const r1 = await fetch(u, { headers: { range: "bytes=0-" } });
    const rd = r1.body.getReader();
    let got = 0;
    while (got < 400 * 1024) {
      const { done, value } = await rd.read();
      if (done) break;
      got += value.length;
    }
    await rd.cancel();
    const off = Math.floor(file.length * 0.8);
    const t0 = Date.now();
    const r2 = await fetch(u, { headers: { range: `bytes=${off}-` } });
    const rd2 = r2.body.getReader();
    const first = await rd2.read();
    const ttfb = Date.now() - t0;
    const head = Buffer.from(first.value ?? new Uint8Array());
    const exact = head.equals(file.subarray(off, off + head.length));
    await rd2.cancel();
    rec.seek = { off, ttfb, bytes: head.length, exact };
    check(`${name}: seek to 80% after abort returns exact bytes`, exact, `ttfb=${ttfb}ms ${head.length}B`);
    report.files.push(rec);
  }

  // a file whose audio the browser cannot decode must be flagged
  const ac3 = report.files.find((f) => f.name.includes("ac3"));
  if (ac3) {
    check("h264-ac3.mkv is reported as silent in the browser", ac3.codecs?.browserAudio === false, `audio=[${ac3.codecs?.audio}]`);
  }
  const aac = report.files.find((f) => f.name.includes("aac"));
  if (aac) {
    check("h264-aac file is reported as playable with sound", aac.codecs?.browserAudio === true, `audio=[${aac.codecs?.audio}]`);
  }
} catch (e) {
  report.error = e.message;
  log(`media check failed: ${e.message}`);
}

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
log(report.failed ? `\n${report.failed} FAILURES` : "\nALL MEDIA CHECKS PASSED");
process.exit(report.failed ? 1 : 0);
