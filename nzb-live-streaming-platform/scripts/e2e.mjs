#!/usr/bin/env node
/**
 * End-to-end test against a running app (default http://127.0.0.1:3000) and
 * the mock NNTP server (scripts/mock-nntp.mjs). Verifies, byte-for-byte, that
 * ranges streamed through the whole stack (NNTP → yEnc → RAR/ZIP map → HTTP)
 * equal the original fixture files, and that diagnostics report faults.
 *
 *   node scripts/e2e.mjs [appUrl]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const APP = process.argv[2] ?? "http://127.0.0.1:3000";
const here = path.dirname(new URL(import.meta.url).pathname);
const fx = path.join(here, "fixtures");
const mp4 = fs.readFileSync(path.join(fx, "demo.mp4"));
const jpg = fs.readFileSync(path.join(fx, "demo.jpg"));
const sha = (b) => crypto.createHash("sha1").update(b).digest("hex").slice(0, 12);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};
const j = async (url, init) => {
  const r = await fetch(APP + url, { ...init, signal: AbortSignal.timeout(120000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
const range = async (url, start, end) => {
  const r = await fetch(APP + url, { headers: { range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(180000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, cr: r.headers.get("content-range"), ct: r.headers.get("content-type"), cl: r.headers.get("content-length") };
};
const waitAnalyzed = async (id) => {
  for (let i = 0; i < 90; i++) {
    const s = await j(`/api/sessions/${id}`);
    if (s.analyzed || s.analyzeError) return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("analysis timeout");
};

console.log(`e2e against ${APP}`);

/* 1. provider */
console.log("\n[1] provider setup + connection test");
const test = await j("/api/providers/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host: "127.0.0.1", port: 1190, ssl: false, username: "test", password: "test" }) });
ok(test.ok, `connection test: ${test.ok ? `${test.ms}ms "${test.greeting}"` : test.error}`);
const bad = await j("/api/providers/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host: "127.0.0.1", port: 1190, ssl: false, username: "test", password: "wrong" }) });
ok(!bad.ok && /Authentication failed: 481/.test(bad.error ?? ""), `bad password rejected: ${bad.error}`);
const existing = (await j("/api/providers")).find((p) => p.host === "127.0.0.1" && p.port === 1190);
const prov = existing ?? (await j("/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mock", host: "127.0.0.1", port: 1190, ssl: false, username: "test", password: "test", connections: 6 }) }));
ok(prov.id > 0, `provider #${prov.id} ready`);

/* 2. direct post */
console.log("\n[2] direct post (mp4 + jpg + nfo + srt) via NZB URL");
let s = await j("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: prov.id, source: "url", url: "http://127.0.0.1:1191/direct.nzb" }) });
s = await waitAnalyzed(s.id);
ok(s.analyzed, `analyzed: ${s.items.map((i) => `${i.name}(${i.kind},${i.playable ? "playable" : "no"})`).join(", ")}`);
const video = s.items.find((i) => i.name === "demo.mp4");
ok(video && video.size === mp4.length, `mp4 size from yEnc header ${video?.size} == ${mp4.length}`);
ok(video?.browserMime === "video/mp4", `mime ${video?.browserMime}`);
{
  const u = `/api/sessions/${s.id}/stream/${video.id}`;
  const head = await fetch(APP + u, { method: "HEAD" });
  ok(head.headers.get("accept-ranges") === "bytes" && Number(head.headers.get("content-length")) === mp4.length, `HEAD: accept-ranges + content-length ${head.headers.get("content-length")}`);
  // first bytes (moov/ftyp probe like a browser does)
  let r = await range(u, 0, 65535);
  ok(r.status === 206 && r.buf.equals(mp4.subarray(0, 65536)), `range 0-65535 → ${r.status} ${r.cr} bytes match`);
  // seek deep into the file crossing segment boundaries (500000 part size)
  r = await range(u, 40_123_456, 41_999_999);
  ok(r.status === 206 && r.buf.equals(mp4.subarray(40_123_456, 42_000_000)), `range 40123456-41999999 (crosses 4 segments) bytes match [${sha(r.buf)}]`);
  // tail (browsers fetch moov at the end for non-faststart mp4)
  r = await range(u, mp4.length - 1_000_000, mp4.length - 1);
  ok(r.status === 206 && r.buf.equals(mp4.subarray(mp4.length - 1_000_000)), `tail range bytes match (${r.buf.length}B)`);
  // suffix range
  r = await fetch(APP + u, { headers: { range: "bytes=-1000" } });
  const suf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 206 && suf.equals(mp4.subarray(mp4.length - 1000)), `suffix range bytes=-1000 ok`);
  // unsatisfiable
  r = await range(u, mp4.length + 10, mp4.length + 20);
  ok(r.status === 416, `unsatisfiable range → ${r.status}`);
  // full sequential stream — the real "play it through" test (86MB)
  const t0 = Date.now();
  const full = await fetch(APP + u, { signal: AbortSignal.timeout(600000) });
  const fb = Buffer.from(await full.arrayBuffer());
  const ms = Date.now() - t0;
  ok(full.status === 200 && fb.length === mp4.length && sha(fb) === sha(mp4), `full stream ${fb.length}B sha=${sha(fb)} in ${ms}ms (${(fb.length / 1048576 / (ms / 1000)).toFixed(1)} MB/s) matches original`);
}
const image = s.items.find((i) => i.name === "demo.jpg");
{
  const r = await range(`/api/sessions/${s.id}/stream/${image.id}`, 0, jpg.length - 1);
  ok(r.buf.equals(jpg) && r.ct === "image/jpeg", `jpg streamed intact (${r.ct})`);
}
const sub = s.items.find((i) => i.ext === "srt");
{
  const r = await fetch(`${APP}/api/sessions/${s.id}/stream/${sub.id}?vtt=1`);
  const t = await r.text();
  ok(t.startsWith("WEBVTT") && t.includes("00:00:00.500 --> 00:00:04.000"), `srt → vtt conversion`);
}
const nfo = s.items.find((i) => i.ext === "nfo");
ok(nfo?.kind === "text", `nfo detected as text`);
{
  const snap = await j(`/api/sessions/${s.id}/diag?snapshot=1`);
  const f = snap.files.find((f) => f.name === "demo.mp4");
  ok(snap.stats.segmentsFailed === 0 && snap.stats.crcErrors === 0, `diag: ${snap.stats.segmentsOk} segments ok, 0 failed, 0 crc errors, ${snap.stats.connectionsOpenedTotal} connections opened`);
  ok(f && /^2+$/.test(f.states), `diag: segment map for demo.mp4 fully green (${f?.states.length} segs)`);
  ok(snap.events.some((e) => e.cat === "range") && snap.events.some((e) => e.cat === "segment" && e.data?.crcOk === true), `diag: range + segment events with crc info present`);
}

/* 3. rar set (obfuscated names, par2) */
console.log("\n[3] obfuscated 3-volume stored RAR set + PAR2 name recovery");
let r2 = await j("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: prov.id, source: "url", url: "http://127.0.0.1:1191/rar.nzb" }) });
r2 = await waitAnalyzed(r2.id);
ok(r2.analyzed, `analyzed: ${r2.items.map((i) => `${i.name}(${i.container})`).join(", ")}`);
ok(r2.files.some((f) => /^demo\.release\.part\d\.rar$/.test(f.name)), `par2 recovered volume names: ${r2.files.map((f) => f.name).join(", ")}`);
const inRar = r2.items.find((i) => i.container === "rar" && i.kind === "video");
ok(inRar && inRar.name === "Demo.Release.2024.1080p.mp4" && inRar.size === mp4.length && inRar.playable, `rar entry ${inRar?.name} size ${inRar?.size} playable=${inRar?.playable}`);
{
  const u = `/api/sessions/${r2.id}/stream/${inRar.id}`;
  let r = await range(u, 0, 99_999);
  ok(r.status === 206 && r.buf.equals(mp4.subarray(0, 100_000)), `rar: range 0-99999 matches`);
  // crosses volume 1→2 boundary (perVol = ceil(len/3))
  const perVol = Math.ceil(mp4.length / 3);
  r = await range(u, perVol - 300_000, perVol + 300_000 - 1);
  ok(r.status === 206 && r.buf.equals(mp4.subarray(perVol - 300_000, perVol + 300_000)), `rar: range spanning volume boundary at ${perVol} matches`);
  r = await range(u, mp4.length - 5000, mp4.length - 1);
  ok(r.status === 206 && r.buf.equals(mp4.subarray(mp4.length - 5000)), `rar: tail range matches`);
  const t0 = Date.now();
  const full = await fetch(APP + u, { signal: AbortSignal.timeout(600000) });
  const fb = Buffer.from(await full.arrayBuffer());
  ok(fb.length === mp4.length && sha(fb) === sha(mp4), `rar: full stream through 3 volumes sha=${sha(fb)} matches in ${Date.now() - t0}ms`);
  const m3u = await (await fetch(APP + u + "?m3u=1")).text();
  ok(m3u.includes("#EXTM3U") && m3u.includes(u), `m3u playlist for VLC generated`);
}

/* 4. zip */
console.log("\n[4] stored ZIP");
let z = await j("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: prov.id, source: "url", url: "http://127.0.0.1:1191/zip.nzb" }) });
z = await waitAnalyzed(z.id);
const zj = z.items.find((i) => i.container === "zip" && i.name === "cover.jpg");
ok(zj && zj.playable, `zip entries: ${z.items.map((i) => `${i.name}(${i.container},${i.playable})`).join(", ")}`);
{
  const r = await range(`/api/sessions/${z.id}/stream/${zj.id}`, 0, jpg.length - 1);
  ok(r.buf.equals(jpg), `zip: cover.jpg streamed intact from inside the archive`);
}

/* 5. broken post: missing segment (430) + corrupted crc */
console.log("\n[5] broken post — missing segment #3 (430) and bad CRC on #5");
let b = await j("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: prov.id, source: "url", url: "http://127.0.0.1:1191/broken.nzb" }) });
b = await waitAnalyzed(b.id);
const bv = b.items.find((i) => i.kind === "video");
{
  const u = `/api/sessions/${b.id}/stream/${bv.id}`;
  const r = await range(u, 0, 3_000_000 - 1); // covers segments 0..5
  ok(r.status === 206 && r.buf.length === 3_000_000, `stream continues past the hole (${r.buf.length}B delivered)`);
  ok(r.buf.subarray(1_000_000, 1_500_000).every((x) => x === 0), `missing segment zero-filled (bytes 1000000-1499999)`);
  ok(r.buf.subarray(0, 1_000_000).equals(mp4.subarray(0, 1_000_000)) && r.buf.subarray(1_500_000, 2_000_000).equals(mp4.subarray(1_500_000, 2_000_000)), `neighbouring segments intact`);
  const snap = await j(`/api/sessions/${b.id}/diag?snapshot=1`);
  const errs = snap.events.filter((e) => e.level === "error" && e.cat === "segment");
  const crc = snap.events.filter((e) => /CRC MISMATCH/.test(e.msg));
  ok(errs.length >= 1 && /430/.test(errs[0].msg) && errs[0].data?.seg === 2, `diag error names the segment: "${errs[0]?.msg.slice(0, 90)}"`);
  ok(crc.length >= 1 && crc[0].data?.seg === 4, `diag flags CRC mismatch on segment 5: "${crc[0]?.msg.slice(0, 100)}"`);
  ok(snap.stats.segmentsFailed >= 1 && snap.stats.crcErrors >= 1, `stats: failed=${snap.stats.segmentsFailed} crcErrors=${snap.stats.crcErrors}`);
  const f = snap.files.find((f) => f.name === "broken.mp4");
  ok(f && f.states[2] === "3" && f.states[4] === "3" && f.states[0] === "2", `segment map shows red at #3 and #5: ${f?.states.slice(0, 8)}…`);
}

/* 6. SSE diag stream */
console.log("\n[6] diagnostics SSE");
{
  const ac = new AbortController();
  const r = await fetch(`${APP}/api/sessions/${b.id}/diag?since=0`, { signal: ac.signal });
  const reader = r.body.getReader();
  let text = "";
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    while (text.length < 20000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
      if (text.includes("event: log") && text.includes("event: snapshot")) break;
    }
  } catch {}
  clearTimeout(t);
  ac.abort();
  ok(r.headers.get("content-type")?.startsWith("text/event-stream") && text.includes("event: snapshot") && text.includes("event: log"), `SSE delivers snapshot + log events`);
}

/* 7. indexer search (live nzb.life) — informational, network dependent */
console.log("\n[7] indexer search (nzb.life)");
try {
  const sr = await j(`/api/search?q=${encodeURIComponent("big buck bunny")}`);
  ok(Array.isArray(sr.results) && sr.results.length > 0 && sr.results[0].guid, `search returned ${sr.results.length}/${sr.total} results, first: "${sr.results[0]?.title}"`);
} catch (e) {
  console.log(`  ~ indexer unreachable from this sandbox: ${e.message}`);
}

/* 8. sessions list + cleanup */
console.log("\n[8] persistence");
const list = await j("/api/sessions");
ok(list.some((x) => x.id === s.id) && list.some((x) => x.id === r2.id), `sessions persisted (${list.length} rows)`);
await j(`/api/sessions/${z.id}`, { method: "DELETE" });
await j(`/api/sessions/${b.id}`, { method: "DELETE" });
ok(!(await j("/api/sessions")).some((x) => x.id === z.id), `session delete works`);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
