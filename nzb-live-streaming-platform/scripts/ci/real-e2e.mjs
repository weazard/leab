#!/usr/bin/env node
/**
 * Real end-to-end probe against a *live* NNTP provider + newznab indexer.
 *
 * Drives the app purely through its public HTTP API (exactly what the browser
 * does) and reports the numbers that decide whether playback feels "live":
 *
 *   - TTFB for the first bytes of a range (does it start streaming, or does it
 *     buffer the whole file first?)
 *   - TTFB after a simulated seek (does a jump re-download / stall?)
 *   - byte-for-byte determinism of repeated ranges
 *   - container + codec identification of the actual release, and whether the
 *     browser can decode it (this is what causes "no sound" / "won't play")
 *   - Archive layout: stored vs compressed (compressed ⇒ full inflate first)
 *
 * Usage:
 *   node scripts/ci/real-e2e.mjs http://127.0.0.1:3000
 *
 * Env:
 *   PROVIDER_HOST/PORT/SSL/USER/PASS/CONNS   NNTP provider to create
 *   SEARCH_QUERY                             what to search for (default below)
 *   SEARCH_CAT                               newznab cat (default 5040 = TV HD)
 *   NZB_URL                                  skip search, use this .nzb url
 *   PICK_MAX_BYTES / PICK_MIN_BYTES          size window for the pick
 *   REPORT_OUT                               where to write the json report
 *   FFPROBE                                  path to ffprobe (optional)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const APP = (process.argv[2] ?? process.env.APP ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const OUT = process.env.REPORT_OUT ?? "ci-report.json";

const PROVIDER = {
  name: process.env.PROVIDER_NAME ?? "supernews",
  host: process.env.PROVIDER_HOST ?? "news.supernews.com",
  port: Number(process.env.PROVIDER_PORT ?? 563),
  ssl: (process.env.PROVIDER_SSL ?? "1") === "1",
  username: process.env.PROVIDER_USER ?? "",
  password: process.env.PROVIDER_PASS ?? "",
  connections: Number(process.env.PROVIDER_CONNS ?? 8),
};

const SEARCH_QUERY = process.env.SEARCH_QUERY ?? "Silo S01E01";
const SEARCH_CAT = process.env.SEARCH_CAT ?? "5040";
const PICK_MIN = Number(process.env.PICK_MIN_BYTES ?? 300 * 1024 * 1024);
const PICK_MAX = Number(process.env.PICK_MAX_BYTES ?? 4 * 1024 * 1024 * 1024);
const FFPROBE = process.env.FFPROBE ?? "ffprobe";

const report = {
  startedAt: new Date().toISOString(),
  app: APP,
  provider: { ...PROVIDER, password: PROVIDER.password ? "***" : "" },
  steps: [],
  checks: [],
  findings: [],
  error: null,
};
const log = (...a) => console.log(...a);
const step = (name, data = {}) => {
  report.steps.push({ at: new Date().toISOString(), name, ...data });
  log(`\n### ${name}`, Object.keys(data).length ? JSON.stringify(data) : "");
};
const check = (name, pass, detail = "") => {
  report.checks.push({ name, pass, detail });
  log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const finding = (sev, msg) => {
  report.findings.push({ sev, msg });
  log(`  ! [${sev}] ${msg}`);
};

const j = async (url, init) => {
  const r = await fetch(APP + url, { ...init, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${r.status} ${text.slice(0, 300)}`);
  return body;
};

const fmt = (n) => {
  if (n == null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
};
const sha = (buf) => crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);

/** Fetch a byte range, measuring time-to-first-byte and throughput. */
async function timedRange(base, start, end, { maxBytes = Infinity, abort = null, headers = {} } = {}) {
  const range = end == null ? `bytes=${start}-` : `bytes=${start}-${end}`;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = abort ? setTimeout(() => ac.abort(), abort) : null;
  const res = await fetch(base, { headers: { range, ...headers }, signal: ac.signal }).catch((e) => {
    if (e.name === "AbortError") return { aborted: true };
    throw e;
  });
  if (res && res.aborted) {
    if (timer) clearTimeout(timer);
    return { aborted: true, range, msAbort: Date.now() - t0 };
  }
  const tHead = Date.now();
  const status = res.status;
  const cr = res.headers.get("content-range");
  const cl = Number(res.headers.get("content-length") ?? 0);
  const ct = res.headers.get("content-type");
  let ttfb = null;
  const chunks = [];
  let got = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = Date.now() - t0;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (got >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (e) {
    if (timer) clearTimeout(timer);
    if ((e.name ?? "") === "AbortError") {
      return { aborted: true, range, status, ttfb, got, msAbort: Date.now() - t0 };
    }
    throw e;
  }
  if (timer) clearTimeout(timer);
  const ms = Date.now() - t0;
  const buf = Buffer.concat(chunks);
  return {
    range,
    status,
    contentRange: cr,
    contentLength: cl,
    contentType: ct,
    headMs: tHead - t0,
    ttfbMs: ttfb,
    totalMs: ms,
    bytes: got,
    kbps: got && ttfb != null ? Math.round(got / Math.max(ms - ttfb, 1)) : null,
    sha: sha(buf),
    head: buf.subarray(0, 64),
    buf: buf.length <= 32 * 1024 * 1024 ? buf : undefined,
  };
}

/* ------------------------- container / codec probing ------------------------ */

function parseMp4Codecs(buf) {
  // walk top-level boxes; return codec fourccs found in moov>trak>mdia>minf>stbl>stsd
  const out = { video: [], audio: [], boxes: [], moovAtEnd: null };
  let p = 0;
  const boxes = [];
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(p + 8));
    if (!size || size < 8) break;
    boxes.push({ type, at: p, size });
    if (type === "moov") out.moovAtEnd = p > buf.length / 2;
    p += size;
  }
  out.boxes = boxes.map((b) => b.type);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) return out;
  const mb = buf.subarray(moov.at, moov.at + Math.min(moov.size, buf.length - moov.at));
  // crude scan: find "stsd" then read entries
  const idx = mb.indexOf(Buffer.from("stsd", "ascii"));
  if (idx < 0) return out;
  let q = idx + 12; // skip size/type/version+flags/entry_count(4)
  const count = mb.readUInt32BE(idx + 8);
  for (let i = 0; i < count && q + 8 <= mb.length; i++) {
    const esize = mb.readUInt32BE(q);
    const fmt4 = mb.toString("ascii", q + 4, q + 8);
    // hdlr type decides video vs audio; approximate by fourcc
    if (/^(avc1|avc3|hev1|hvc1|vp09|av01|mp4v)$/.test(fmt4)) out.video.push(fmt4);
    else if (/^(mp4a|ac-3|ec-3|Opus|alac|dtsc|dtsh|dtsl|sowt|twos|lpcm)$/.test(fmt4)) out.audio.push(fmt4);
    else if (/^(soun|vide)$/.test(fmt4)) out.audio.push(fmt4);
    if (!esize || esize < 8) break;
    q += esize;
  }
  return out;
}

function parseMkvCodecs(buf) {
  const out = { video: [], audio: [], subs: [], container: "matroska" };
  const s = buf.toString("latin1");
  const grab = (re) => {
    const set = new Set();
    let m;
    while ((m = re.exec(s))) set.add(m[1]);
    return [...set];
  };
  out.video = grab(/V_MPEG4\/ISO\/[A-Z0-9]+|V_MPEGH\/ISO\/HEVC|V_VP9|V_AV1|V_MS\/VFW\/WVC1|V_REAL\/[A-Z0-9]+/g);
  out.audio = grab(/A_AAC|A_AC3|A_EAC3|A_DTS|A_TRUEHD|A_FLAC|A_OPUS|A_VORBIS|A_MP3|A_PCM\/[A-Z_]*/g);
  out.subs = grab(/S_TEXT\/[A-Z0-9]+|S_ASS|S_VOBSUB/g);
  return out;
}

function identify(head, tail) {
  const first = head.subarray(0, 64);
  if (first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3) return "matroska";
  if (first.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (first.subarray(0, 2).toString("latin1") === "PK") return "zip";
  if (first.subarray(0, 4).toString("ascii") === "Rar!") return "rar";
  if (head.subarray(0, 4).toString("latin1") === "\x47\x40\x11\x10" || (head[0] === 0x47 && head[188] === 0x47)) return "mpegts";
  if (first.subarray(0, 3).toString("ascii") === "RIFF" && first.subarray(8, 12).toString("ascii") === "AVI ") return "avi";
  if (first.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  void tail;
  return "unknown";
}

const BROWSER_AUDIO_OK = new Set(["mp4a", "Opus", "A_AAC", "A_OPUS", "A_VORBIS", "A_FLAC", "A_MP3"]);
const BROWSER_VIDEO_OK = new Set(["avc1", "avc3", "vp09", "av01", "V_MPEG4/ISO/AVC", "V_VP9", "V_AV1"]);

async function ffprobeFile(file) {
  try {
    const out = execFileSync(
      FFPROBE,
      ["-v", "error", "-show_entries", "stream=index,codec_name,codec_type,profile,channels,width,height", "-show_entries", "format=duration,format_name,size", "-of", "json", file],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 60000 },
    ).toString();
    return JSON.parse(out);
  } catch (e) {
    return { error: String(e.message ?? e).slice(0, 200) };
  }
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  step("health");
  const health = await j("/api/health");
  check("app responds", true, JSON.stringify(health));

  /* 1. provider */
  step("create provider", { host: PROVIDER.host, port: PROVIDER.port });
  const prov = await j("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(PROVIDER),
  });
  report.providerId = prov.id;
  const test = await j("/api/providers/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: prov.id }),
  });
  report.providerTest = { ok: test.ok, error: test.error, ...(test.info ?? {}) };
  check("NNTP provider connects + auths", !!test.ok, test.error ?? JSON.stringify(test.info ?? {}).slice(0, 200));
  if (!test.ok) throw new Error(`provider unusable: ${test.error}`);

  /* 2. search */
  let picked = null;
  if (process.env.NZB_URL) {
    picked = { title: process.env.NZB_URL, link: process.env.NZB_URL, guid: process.env.NZB_URL, size: 0 };
    step("using explicit NZB_URL", { url: process.env.NZB_URL });
  } else {
    step("search indexer", { q: SEARCH_QUERY, cat: SEARCH_CAT });

    // Indexers are picky: "Silo S01E01" only matches on some, and the cat
    // filter silently zeroes out results on others. Try several shapes and
    // keep the first one that returns anything — the raw response of the first
    // attempt goes in the report so a dead API key is visible.
    const bare = SEARCH_QUERY.replace(/\s*[sS]\d{1,2}[eE]\d{1,3}.*$/, "").trim();
    const ep = /[sS](\d{1,2})[eE](\d{1,3})/.exec(SEARCH_QUERY);
    const strategies = [
      { label: `tvsearch q=${bare} s${ep?.[1] ?? 1}e${ep?.[2] ?? 1} cat=${SEARCH_CAT}`, qs: `type=tvsearch&q=${encodeURIComponent(bare)}&season=${ep?.[1] ?? 1}&ep=${ep?.[2] ?? 1}&cat=${SEARCH_CAT}&limit=60` },
      { label: `tvsearch q=${bare} s${ep?.[1] ?? 1}e${ep?.[2] ?? 1} (no cat)`, qs: `type=tvsearch&q=${encodeURIComponent(bare)}&season=${ep?.[1] ?? 1}&ep=${ep?.[2] ?? 1}&limit=60` },
      { label: `search q=${SEARCH_QUERY} cat=${SEARCH_CAT}`, qs: `q=${encodeURIComponent(SEARCH_QUERY)}&cat=${SEARCH_CAT}&limit=60` },
      { label: `search q=${bare}`, qs: `q=${encodeURIComponent(bare)}&limit=100` },
    ];

    let res = { items: [] };
    let items = [];
    report.searchTries = [];
    for (const st of strategies) {
      let r;
      try {
        r = await j(`/api/search?${st.qs}`);
      } catch (e) {
        report.searchTries.push({ ...st, error: String(e.message).slice(0, 300) });
        log(`  ${st.label} → ${String(e.message).slice(0, 160)}`);
        continue;
      }
      const got = (r.results ?? r.items ?? []).filter((i) => i.size >= PICK_MIN && i.size <= PICK_MAX);
      report.searchTries.push({ ...st, raw: r.raw ?? undefined, error: r.error, total: (r.results ?? r.items ?? []).length, inWindow: got.length, sample: (r.results ?? r.items ?? []).slice(0, 3).map((i) => i.title) });
      log(`  ${st.label} → ${(r.results ?? r.items ?? []).length} results, ${got.length} in size window${r.error ? ` (error: ${String(r.error).slice(0, 120)})` : ""}`);
      if (got.length) {
        res = r;
        items = got;
        report.search = { strategy: st.label, total: (r.results ?? r.items ?? []).length, candidates: got.slice(0, 10).map((i) => ({ title: i.title, size: i.size, sizeHuman: fmt(i.size) })) };
        break;
      }
      if ((res.results ?? []).length === 0) res = r; // keep the last response for the report
    }
    if (items.length === 0) {
      // fall back to anything the indexer returned, whatever its size
      const any = (res.results ?? res.items ?? []).slice(0, 10);
      if (any.length) {
        log("  ! nothing inside the size window — falling back to the smallest result");
        items = [...(res.results ?? res.items ?? [])].sort((a, b) => (a.size ?? 0) - (b.size ?? 0)).slice(0, 1);
        report.search = { ...(report.search ?? {}), fellBackOutsideWindow: true };
      }
    }
    for (const i of items.slice(0, 10)) log(`    - ${i.title} (${fmt(i.size)})`);
    check("indexer returns candidates", items.length > 0, `${items.length} candidates`);
    if (!items.length) throw new Error("no candidate releases in size window");
    // pick the smallest playable-looking candidate → fastest to verify
    picked = items.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0];
    step("picked release", { title: picked.title, size: fmt(picked.size) });
  }

  /* 3. session */
  const created = await j("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: prov.id, source: "url", url: picked.link, title: picked.title }),
  });
  step("session created", { id: created.id, files: created.fileCount, total: fmt(created.totalBytes) });
  const sid = created.id;
  report.sessionId = sid;

  let sess = null;
  for (let i = 0; i < 120; i++) {
    sess = await j(`/api/sessions/${sid}`);
    if (sess.analyzed || sess.analyzeError) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (sess.analyzeError) throw new Error(`analysis failed: ${sess.analyzeError}`);
  step("analysis done", { items: (sess.items ?? []).length, ms: Date.now() - Date.parse(report.startedAt) });
  report.items = (sess.items ?? []).map((i) => ({
    name: i.name,
    size: i.size,
    kind: i.kind,
    ext: i.ext,
    mime: i.mime,
    browserMime: i.browserMime,
    container: i.container,
    method: i.method,
    needsDecompress: i.needsDecompress,
    playable: i.playable,
    reason: i.reason,
  }));
  for (const i of sess.items ?? []) {
    log(`    • ${i.name} — ${fmt(i.size)} ${i.kind}/${i.ext} container=${i.container} method=${i.method ?? "-"} needsDecompress=${!!i.needsDecompress} playable=${i.playable} mime=${i.browserMime}${i.reason ? ` (${i.reason})` : ""}`);
  }

  const vids = (sess.items ?? []).filter((i) => i.kind === "video").sort((a, b) => b.size - a.size);
  if (!vids.length) throw new Error("no video item found in release");
  const item = vids[0];
  // hand the target over to the browser playback test
  try {
    fs.mkdirSync("ci-report", { recursive: true });
    fs.writeFileSync("ci-report/target.json", JSON.stringify({ sessionId: sid, itemId: item.id, name: item.name, size: item.size, container: item.container, method: item.method }));
  } catch {
    /* best effort */
  }
  step("probing video item", { name: item.name, size: fmt(item.size), container: item.container });
  const base = `${APP}/api/sessions/${sid}/stream/${item.id}`;

  /* 4. HEAD + basic range behaviour */
  const hr = await fetch(base, { method: "HEAD", signal: AbortSignal.timeout(60000) });
  report.head = {
    status: hr.status,
    acceptRanges: hr.headers.get("accept-ranges"),
    contentLength: hr.headers.get("content-length"),
    contentType: hr.headers.get("content-type"),
  };
  check("HEAD advertises ranges", hr.headers.get("accept-ranges") === "bytes", JSON.stringify(report.head));
  check("HEAD content-length == item size", Number(hr.headers.get("content-length")) === item.size, `${hr.headers.get("content-length")} vs ${item.size}`);

  /* 5. first bytes — is it "live"? */
  const first = await timedRange(base, 0, 1024 * 1024 - 1);
  report.firstRange = strip(first);
  log(`  first 1MB: status=${first.status} ttfb=${first.ttfbMs}ms total=${first.totalMs}ms ${fmt(first.bytes)} (${first.kbps} KB/s)`);
  check("range 0-1MB returns 206", first.status === 206, String(first.status));
  check("first byte arrives < 15s (feels live)", (first.ttfbMs ?? 1e9) < 15000, `ttfb=${first.ttfbMs}ms`);
  if (item.needsDecompress) {
    finding("info", `item is ${item.method} — server inflates the whole entry before any byte is sent (by design for compressed RAR/ZIP)`);
  }

  /* 6. container + codecs from the head (and tail for mp4) */
  const container = identify(first.head, null);
  let codecs = { container };
  if (container === "matroska") {
    const big = await timedRange(base, 0, 4 * 1024 * 1024 - 1);
    codecs = { ...parseMkvCodecs(big.buf), container };
  } else if (container === "mp4") {
    let moovFound = false;
    let scan = parseMp4Codecs(first.buf ?? Buffer.alloc(0));
    if (scan.boxes.includes("moov")) moovFound = true;
    if (!moovFound) {
      const tail = await timedRange(base, Math.max(0, item.size - 8 * 1024 * 1024), item.size - 1);
      report.tailRange = strip(tail);
      scan = parseMp4Codecs(tail.buf ?? Buffer.alloc(0));
      moovFound = scan.boxes.includes("moov");
      report.moovAtEnd = moovFound ? "tail" : "not found in last 8MB";
    } else {
      report.moovAtEnd = "head (faststart)";
    }
    codecs = { ...scan, container };
  }
  report.codecs = codecs;
  log(`  container=${container} codecs=${JSON.stringify(codecs)}`);
  report.playability = assessPlayability(container, codecs, item);
  for (const f of report.playability.notes) log(`  · ${f}`);

  /* 7. simulated seek: jump to 25/50/75% and measure TTFB */
  const seeks = [];
  for (const frac of [0.25, 0.5, 0.75]) {
    const off = Math.floor(item.size * frac);
    const r1 = await timedRange(base, off, off + 512 * 1024 - 1);
    seeks.push({ frac, offset: off, ...strip(r1) });
    log(`  seek ${frac * 100}%: status=${r1.status} ttfb=${r1.ttfbMs}ms total=${r1.totalMs}ms`);
    check(`seek to ${frac * 100}% returns 206`, r1.status === 206, String(r1.status));
    check(`seek to ${frac * 100}% TTFB < 20s`, (r1.ttfbMs ?? 1e9) < 20000, `ttfb=${r1.ttfbMs}ms`);
  }
  report.seeks = seeks;

  /* 8. open-ended request like a <video> makes, aborted after 2MB */
  const openEnded = await timedRange(base, Math.floor(item.size * 0.5), null, { maxBytes: 2 * 1024 * 1024 });
  report.openEnded = strip(openEnded);
  log(`  open-ended from 50%: status=${openEnded.status} ttfb=${openEnded.ttfbMs}ms got=${fmt(openEnded.bytes)}`);
  check("open-ended range starts < 20s", (openEnded.ttfbMs ?? 1e9) < 20000, `ttfb=${openEnded.ttfbMs}ms`);
  check("open-ended range is 206 with content-range", openEnded.status === 206 && !!openEnded.contentRange, `${openEnded.status} ${openEnded.contentRange}`);

  /* 9. determinism: same range twice must be identical */
  const off = Math.floor(item.size * 0.33);
  const a = await timedRange(base, off, off + 256 * 1024 - 1);
  const b = await timedRange(base, off, off + 256 * 1024 - 1);
  check("repeated range is byte-identical", a.sha === b.sha, `${a.sha} vs ${b.sha} (2nd ttfb=${b.ttfbMs}ms, cached should be ~0)`);
  report.cacheCoherence = { sha1: a.sha, sha2: b.sha, ttfb1: a.ttfbMs, ttfb2: b.ttfbMs };

  /* 10. 416 handling */
  const oor = await fetch(base, { headers: { range: `bytes=${item.size + 100}-${item.size + 200}` }, signal: AbortSignal.timeout(60000) });
  report.oor = { status: oor.status, contentRange: oor.headers.get("content-range") };
  check("out-of-range → 416", oor.status === 416, String(oor.status));
  await oor.body?.cancel().catch(() => {});

  /* 12. full-file container probe with ffprobe on a partial (head+tail) if available */
  if (process.env.DO_FFPROBE === "1") {
    try {
      const dir = fs.mkdtempSync("/tmp/probe-");
      const headFile = path.join(dir, "head.bin");
      const headBytes = await timedRange(base, 0, 16 * 1024 * 1024 - 1);
      fs.writeFileSync(headFile, headBytes.buf ?? Buffer.alloc(0));
      const tailBytes = await timedRange(base, Math.max(0, item.size - 16 * 1024 * 1024), item.size - 1);
      const tailFile = path.join(dir, "tail.bin");
      fs.writeFileSync(tailFile, tailBytes.buf ?? Buffer.alloc(0));
      report.ffprobe = { head: await ffprobeFile(headFile), tail: await ffprobeFile(tailFile) };
      log(`  ffprobe head: ${JSON.stringify(report.ffprobe.head).slice(0, 400)}`);
      log(`  ffprobe tail: ${JSON.stringify(report.ffprobe.tail).slice(0, 400)}`);
    } catch (e) {
      report.ffprobe = { error: String(e.message ?? e).slice(0, 200) };
    }
  }

  /* 13. diagnostics tail */
  try {
    const snap = await j(`/api/sessions/${sid}/diag?snapshot=1&limit=400`);
    const cats = {};
    for (const e of snap.events ?? []) cats[e.cat] = (cats[e.cat] ?? 0) + 1;
    report.diag = { stats: snap.stats, eventCats: cats, sample: (snap.events ?? []).slice(-60).map((e) => `${e.cat}: ${e.msg}`) };
    log(`  diag stats: ${JSON.stringify(snap.stats)}`);
    log(`  diag event categories: ${JSON.stringify(cats)}`);
  } catch (e) {
    report.diag = { error: String(e.message ?? e).slice(0, 200) };
  }

  /* 14. subtitle availability */
  const subs = (sess.items ?? []).filter((i) => i.kind === "subtitle");
  report.subtitles = subs.map((s) => ({ name: s.name, size: s.size, ext: s.ext, playable: s.playable }));

  const failed = report.checks.filter((c) => !c.pass);
  report.summary = { checks: report.checks.length, failed: failed.length, findings: report.findings.length };
  log(`\n=== ${report.checks.length - failed.length}/${report.checks.length} checks passed ===`);
}

function strip(r) {
  const { buf, head, ...rest } = r;
  void buf;
  void head;
  return rest;
}

function assessPlayability(container, codecs, item) {
  const notes = [];
  const video = codecs.video ?? [];
  const audio = codecs.audio ?? [];
  let browserVideo = video.length ? video.some((c) => BROWSER_VIDEO_OK.has(c)) : null;
  let browserAudio = audio.length ? audio.some((c) => BROWSER_AUDIO_OK.has(c)) : null;
  if (container === "matroska") {
    notes.push("Matroska (MKV) is not a container Chrome/Safari can demux — even with supported codecs the browser will not play it. Options: remux to fMP4 server-side/in-browser, or open in VLC.");
    browserVideo = false;
    browserAudio = false;
  }
  if (video.some((c) => /hev1|hvc1|HEVC|V_MPEGH/.test(c))) {
    notes.push("HEVC/x265 video: browser decode depends on OS/hardware support; often unsupported on Linux/Windows Chrome.");
    browserVideo = browserVideo && false ? false : browserVideo;
  }
  if (audio.some((c) => /A_AC3|A_EAC3|A_DTS|A_TRUEHD|ac-3|ec-3/.test(c))) {
    notes.push("AC3/E-AC3/DTS/TrueHD audio: browsers cannot decode this — playback will be silent (matches the 'no sound' report).");
    browserAudio = false;
  }
  if (item.needsDecompress) notes.push(`compressed entry (${item.method}): whole file is inflated on the server before the first byte — not "live".`);
  return { container, video, audio, browserVideo, browserAudio, notes };
}

main()
  .catch((e) => {
    report.error = String(e.stack ?? e.message ?? e).slice(0, 2000);
    log(`\n!!! FAILED: ${report.error}`);
  })
  .finally(() => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    try {
      fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
      log(`\nreport → ${OUT}`);
    } catch (e) {
      log(`could not write report: ${e.message}`);
    }
    process.exitCode = report.error ? 1 : 0;
  });
