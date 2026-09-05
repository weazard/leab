# nzb.stream — stream usenet content live in the browser

Think WebTorrent/Stremio, but for NZBs: nothing is "downloaded" first. Byte ranges the
`<video>` element asks for are translated into NNTP `BODY` fetches, yEnc-decoded, CRC-checked,
mapped through RAR/ZIP container headers and streamed back as an HTTP `206 Partial Content`
response. Seeking works. VLC/mpv can open the same URL.

```
browser <video>  ──Range──▶  /api/sessions/:id/stream/:item
                                   │  RandomReader (direct file | RAR/ZIP chunk map)
                                   ▼
                          NzbVirtualFile.stream(start,end)
                                   │  guess segment by part size → verify with =ypart begin/end
                                   ▼
                     NntpPool (N conns, retries, GROUP fallback) → yEnc decode + CRC32
                                   │
                                   ▼
                    LRU segment cache (in-memory, SEGMENT_CACHE_MB)
```

## Features

- **Any NNTP provider** — host/port/TLS/auth/connection count stored in Postgres, live connection test.
- **Sources** — newznab indexer search (nzb.life preconfigured via `NEWZNAB_URL` / `NEWZNAB_API_KEY`,
  overridable in the UI), NZB URL, `.nzb` upload, pasted XML. NZBs are persisted so any serverless
  instance can rebuild a session.
- **Formats** — yEnc (+uuencode fallback), **RAR4 & RAR5** multi-volume archives (stored *and*
  compressed m1–m5), **ZIP** stored + deflate entries (incl. ZIP64), **PAR2** index parsing (used to
  recover real file names of obfuscated posts by size + MD5-16k; on-the-fly repair is not attempted),
  magic-byte detection for mp4/mov/mkv/webm/avi/ts/mpg/wmv/flv/mp3/flac/ogg/wav/m4a/jpg/png/gif/webp/pdf/nfo/srt/…
  Encrypted entries are listed with the reason they can't be streamed.
- **Compressed playback** — ZIP deflate is inflated with the Web `DecompressionStream` API (works on
  CF Workers / Wasmer / Node). Compressed RAR is extracted with **7-Zip WASM** (no native binary, no
  stdout). The player waits with a progress bar, then plays from a local blob so seeking works even
  when `moov` is at the end of the file. VLC/download hit the same inflated stream. Capped by
  `MAX_INFLATE_MB` (default 512).
- **Player** — `<video>`/`<audio>`/image/PDF/text viewers with buffering status, keyboard shortcuts
  (space / arrows / f / m), sidecar `.srt` auto-converted to WebVTT, mime override (e.g. serve MKV as
  `video/webm`, which Chrome demuxes), "open in VLC" `.m3u`, direct download.
- **Diagnostics checkbox** — live SSE feed of *everything*: connection lifecycle, every segment
  (message-id, bytes, ms, connection, attempt, CRC declared vs actual), 430/timeout errors, retries,
  archive header parsing, range requests, zero-filled holes, cache stats, plus a colour-coded
  per-file segment map. Falls back to polling where streaming responses are buffered.
- **Fault tolerance** — missing articles (430) are zero-filled so playback continues; CRC mismatches
  are flagged; dead connections are rotated; every socket op is timeout-guarded.

## Run locally

```
npm install
npx drizzle-kit push
npm run dev
```

## End-to-end test (no real provider needed)

```
node scripts/mock-nntp.mjs &      # mock NNTP (127.0.0.1:1190, user/pass test/test) + fixture NZBs on :1191
node scripts/e2e.mjs http://127.0.0.1:3000
```

The harness posts a real 86 MB MP4 (direct, inside a 3-volume stored RAR with obfuscated names +
PAR2, inside a stored ZIP, a deflate ZIP, and a "broken" copy with a missing segment and a corrupted
CRC) and verifies byte-exact range responses, full-file SHA, volume-boundary seeks, SRT→VTT, 416
handling, diagnostics content, SSE, indexer search and persistence. The RAR5 walker is additionally
verified against libarchive's RAR5 test corpus.

## Deploying to edge / serverless

The engine only needs raw TCP (+TLS) and streaming responses. Everything else is plain Next.js +
Postgres (Neon/Supabase/etc. via `DATABASE_URL`).

| Platform | Notes |
| --- | --- |
| **Vercel / Netlify / Node hosts** | Works out of the box (`runtime = "nodejs"` route handlers, `node:tls`). Raise function duration for long streams. |
| **Cloudflare Workers/Pages (OpenNext)** | Enable `nodejs_compat`. The socket layer (`src/lib/usenet/socket.ts`) auto-detects workerd and uses `cloudflare:sockets` `connect()` (TLS via `secureTransport`). |
| **Wasmer Edge (WinterJS)** | Uses Node compat `net`/`tls`; deploy the standalone Next.js build. |
| **Convex** | Use Convex for the DB/actions and keep the streaming route on a Node/CF host — Convex actions cannot stream HTTP responses. |

Set `SEGMENT_CACHE_MB` to match the instance memory (default 256). Because the cache and NNTP pool are
per-instance, pin streaming requests to a region for best cache hit rates.

Compressed RAR inflate keeps the unpacked file in instance memory (capped by `MAX_INFLATE_MB`). On tiny
edge isolates prefer stored (m0) releases or raise the limit on a fat Node host. 7-Zip WASM is loaded
from `node_modules` (`serverExternalPackages`); it never writes to real stdout/stdin.

## Environment

```
DATABASE_URL=postgres://...
NEWZNAB_URL=https://api.nzb.life
NEWZNAB_API_KEY=...            # or set it in the UI (stored in the settings table)
SEGMENT_CACHE_MB=256
MAX_INFLATE_MB=512             # unpacked-size cap for compressed RAR/ZIP
RAR_EXTRACT_TIMEOUT_MS=180000  # 7-Zip WASM extract watchdog
NNTP_TIMEOUT_MS=30000
```
