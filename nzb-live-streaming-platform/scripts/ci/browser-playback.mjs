#!/usr/bin/env node
/**
 * Real-browser playback test. Drives the actual player UI in Chrome and
 * measures what a user experiences:
 *
 *   - how long until the first frame is on screen
 *   - whether the audio track is actually being decoded ("no sound" reports)
 *   - how many times it re-buffers while watching
 *   - whether a jump (seek) recovers, incl. back to an already-seen position
 *
 * Usage:
 *   SESSION_ID=… ITEM_ID=… node scripts/ci/browser-playback.mjs http://127.0.0.1:3000
 * (or point REPORT_TARGET at the probe's ci-report/target.json)
 */
import fs from "node:fs";
import path from "node:path";

const APP = (process.argv[2] ?? process.env.APP ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const OUT = process.env.REPORT_OUT ?? "ci-report/playback.json";
const TARGET = process.env.REPORT_TARGET ?? "ci-report/target.json";

const report = { app: APP, startedAt: new Date().toISOString(), checks: [], findings: [], error: null };
const log = (...a) => console.log(...a);
const check = (name, pass, detail = "") => {
  report.checks.push({ name, pass, detail });
  log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const finding = (msg) => {
  report.findings.push(msg);
  log(`  ! ${msg}`);
};

let target = { sessionId: process.env.SESSION_ID, itemId: process.env.ITEM_ID };
if (fs.existsSync(TARGET) && !target.sessionId) target = JSON.parse(fs.readFileSync(TARGET, "utf8"));
if (!target?.sessionId) {
  report.error = "no session id (probe step did not produce ci-report/target.json)";
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(report.error);
  process.exit(0);
}

const url = `${APP}/?s=${target.sessionId}${target.itemId ? `&item=${target.itemId}` : ""}`;
log(`opening ${url}`);

let chromiumMod;
try {
  ({ chromium: chromiumMod } = await import("playwright"));
} catch {
  try {
    ({ chromium: chromiumMod } = await import("playwright-core"));
  } catch (e) {
    report.error = `playwright not installed: ${e.message}`;
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    process.exit(0);
  }
}

async function launch() {
  const attempts = [
    { channel: "chrome", label: "google-chrome (has H.264/AAC)" },
    { channel: undefined, label: "bundled chromium (no proprietary codecs)" },
  ];
  for (const a of attempts) {
    try {
      const browser = await chromiumMod.launch({
        channel: a.channel,
        args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
      });
      report.browser = a.label;
      log(`  browser: ${a.label}`);
      return browser;
    } catch (e) {
      log(`  could not launch ${a.label}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error("no browser available");
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ""}`));
const responses = [];
page.on("response", (r) => {
  if (/\/stream\//.test(r.url())) responses.push({ url: r.url().slice(-60), status: r.status(), headers: r.headers()["content-type"] });
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

/* instrument the <video> element as soon as it appears */
await page.waitForSelector("video", { timeout: 180000 }).catch(() => {});
const hasVideo = await page.$("video");
if (!hasVideo) {
  const body = (await page.textContent("body").catch(() => "")) ?? "";
  report.error = "no <video> element — player did not render: " + body.replace(/\s+/g, " ").slice(0, 300);
  check("player renders a <video>", false, report.error);
} else {
  await page.evaluate(() => {
    const v = document.querySelector("video");
    const w = window;
    w.__ev = [];
    const t0 = performance.now();
    for (const name of ["loadstart", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "playing", "waiting", "stalled", "seeking", "seeked", "suspend", "error", "ended"]) {
      v.addEventListener(name, () => w.__ev.push({ name, t: Math.round(performance.now() - t0), ct: v.currentTime }));
    }
  });

  const started = Date.now();
  let playing = false;
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return !!v && v.readyState >= 3 && v.currentTime > 0.05 && !v.paused;
      },
      { timeout: 180000, polling: 500 },
    );
    playing = true;
  } catch {
    playing = false;
  }
  const ttpMs = Date.now() - started;

  const state = await page.evaluate(() => {
    const v = document.querySelector("video");
    return {
      readyState: v.readyState,
      networkState: v.networkState,
      currentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      decodedFrames: v.webkitDecodedFrameCount ?? null,
      droppedFrames: v.webkitDroppedFrameCount ?? null,
      audioDecodedBytes: v.webkitAudioDecodedByteCount ?? null,
      videoDecodedBytes: v.webkitVideoDecodedByteCount ?? null,
      buffered: v.buffered.length ? { start: v.buffered.start(0), end: v.buffered.end(0) } : null,
      src: v.currentSrc.slice(-80),
      events: window.__ev ?? [],
    };
  });
  report.state = state;
  report.timeToPlayingMs = ttpMs;

  log(`  time to playing: ${ttpMs}ms  (readyState=${state.readyState} duration=${state.duration} ${state.videoWidth}x${state.videoHeight})`);
  log(`  decoded: ${state.decodedFrames} frames, audio=${state.audioDecodedBytes}B video=${state.videoDecodedBytes}B`);
  log(`  events: ${state.events.map((e) => e.name).join(",")}`);

  check("video reaches playing state", playing, `${ttpMs}ms`);
  check("first frame within 60s", playing && ttpMs < 60000, `${ttpMs}ms`);
  check("video has dimensions", state.videoWidth > 0 && state.videoHeight > 0, `${state.videoWidth}x${state.videoHeight}`);
  if (state.error) {
    const msgs = { 1: "aborted", 2: "network error", 3: "decode error (codec not supported)", 4: "source not supported (container/mime rejected)" };
    finding(`media error ${state.error.code}: ${msgs[state.error.code] ?? state.error.message}`);
  }

  /* watch for 12s and count re-buffers + decoded audio */
  const t1 = Date.now();
  const before = state;
  await new Promise((r) => setTimeout(r, 12000));
  const after = await page.evaluate(() => {
    const v = document.querySelector("video");
    return {
      currentTime: v.currentTime,
      decodedFrames: v.webkitDecodedFrameCount ?? null,
      audioDecodedBytes: v.webkitAudioDecodedByteCount ?? null,
      events: window.__ev ?? [],
    };
  });
  const advanced = after.currentTime - before.currentTime;
  const waits = after.events.filter((e) => e.name === "waiting").length;
  const stalls = after.events.filter((e) => e.name === "stalled").length;
  const audioDelta = (after.audioDecodedBytes ?? 0) - (before.audioDecodedBytes ?? 0);
  log(`  12s of playback: +${advanced.toFixed(1)}s of media, ${waits} waiting, ${stalls} stalled, audio bytes decoded: ${audioDelta}`);
  check("playback advances in real time", advanced > 6, `+${advanced.toFixed(1)}s in ${Date.now() - t1}ms`);
  check("no repeated re-buffering", waits <= 3, `${waits} waiting events`);
  check("audio track is being decoded", audioDelta > 0, `${audioDelta}B decoded — 0 means the browser cannot decode this audio codec (silent playback)`);
  if (audioDelta === 0) finding("No audio decoded: the release uses an audio codec the browser cannot decode (AC3/DTS/TrueHD) — this is the 'no sound' symptom.");

  /* seek forward, then back to an already-seen position */
  const seekTo = async (frac, label) => {
    const target = await page.evaluate((f) => {
      const v = document.querySelector("video");
      const t = (v.duration || 0) * f;
      v.currentTime = t;
      return t;
    }, frac);
    const t0 = Date.now();
    let ok = false;
    try {
      await page.waitForFunction(
        (t) => {
          const v = document.querySelector("video");
          return !v.paused && Math.abs(v.currentTime - t) < 3 && v.readyState >= 3;
        },
        target,
        { timeout: 90000, polling: 300 },
      );
      ok = true;
    } catch {
      ok = false;
    }
    const ms = Date.now() - t0;
    const st = await page.evaluate(() => {
      const v = document.querySelector("video");
      return { currentTime: v.currentTime, paused: v.paused, error: v.error ? v.error.code : null, readyState: v.readyState, buffered: v.buffered.length ? { end: v.buffered.end(v.buffered.length - 1) } : null };
    });
    log(`  seek ${label} → ${target.toFixed(0)}s: ${ok ? "recovered" : "FAILED"} in ${ms}ms (paused=${st.paused} err=${st.error} rs=${st.readyState})`);
    check(`seek ${label} recovers`, ok, `${ms}ms${st.error ? ` error=${st.error}` : ""}`);
    return { label, target, ok, ms, ...st };
  };
  report.seeks = [];
  report.seeks.push(await seekTo(0.4, "forward to 40%"));
  report.seeks.push(await seekTo(0.05, "back to an already-played position"));
  report.seeks.push(await seekTo(0.75, "forward to 75%"));
}

report.consoleErrors = consoleErrors.slice(0, 20);
report.failedRequests = failedRequests.slice(0, 20);
report.mediaResponses = responses.slice(0, 20);
report.finishedAt = new Date().toISOString();

await browser.close().catch(() => {});

try {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`report → ${OUT}`);
} catch (e) {
  log(`could not write report: ${e.message}`);
}
