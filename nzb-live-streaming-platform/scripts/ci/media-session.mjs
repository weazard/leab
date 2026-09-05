#!/usr/bin/env node
/**
 * Creates a session against the media mock so the browser test has a real,
 * deterministic release to play (no indexer, no provider credentials needed).
 *
 * Writes ci-report/media-target.json in the same shape real-e2e.mjs uses.
 *
 * Usage:
 *   node scripts/ci/media-session.mjs http://127.0.0.1:3000 http://127.0.0.1:1591/h264-aac.mp4.nzb
 */
import fs from "node:fs";
import path from "node:path";

const APP = (process.argv[2] ?? process.env.APP ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const NZB = process.argv[3] ?? process.env.NZB_URL ?? "";
const OUT = process.env.REPORT_OUT ?? "ci-report/media-target.json";
const PORT = Number(process.env.MEDIA_MOCK_PORT ?? 1590);
const PICK = process.env.MEDIA_PICK ?? ""; // substring to select one of several files

const j = async (u, init) => {
  const r = await fetch(APP + u, { ...init, signal: AbortSignal.timeout(180000) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${u} → ${r.status} ${JSON.stringify(body ?? {}).slice(0, 300)}`);
  return body;
};

const out = { ok: false };
try {
  if (!NZB) throw new Error("no nzb url given");

  const provs = await j("/api/providers");
  let prov = provs.find((p) => p.port === PORT);
  if (!prov) {
    prov = await j("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "media-mock", host: "127.0.0.1", port: PORT, ssl: false, username: "test", password: "test", connections: 8 }),
    });
  }

  const s = await j("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: prov.id, source: "url", url: NZB }),
  });

  let st = s;
  for (let i = 0; i < 300; i++) {
    st = await j(`/api/sessions/${s.id}`);
    if (st.analyzed || st.analyzeError) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!st.analyzed) throw new Error(`analysis failed: ${st.analyzeError}`);

  const items = st.items ?? [];
  const item = (PICK ? items.find((i) => i.name.includes(PICK)) : items[0]) ?? items[0];
  if (!item) throw new Error("no items in the nzb");

  Object.assign(out, {
    ok: true,
    sessionId: st.id,
    itemId: item.id,
    name: item.name,
    size: item.size,
    mime: item.mime,
    container: item.codecs?.container,
    video: item.codecs?.video,
    audio: item.codecs?.audio,
    browserAudio: item.codecs?.browserAudio,
    browserVideo: item.codecs?.browserVideo,
    moovAtEnd: item.codecs?.moovAtEnd,
    notes: item.codecs?.notes,
    items: items.map((i) => ({ id: i.id, name: i.name, size: i.size, mime: i.mime })),
  });
  console.log(`session ${st.id} item ${item.id} — ${item.name} ${item.size}B ${item.mime}`);
  console.log(`  codecs: ${out.container} video=[${out.video}] audio=[${out.audio}] browserAudio=${out.browserAudio}`);
} catch (e) {
  out.error = e.message;
  console.error(`media session failed: ${e.message}`);
}

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
