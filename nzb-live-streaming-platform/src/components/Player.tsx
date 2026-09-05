"use client";
import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "@/lib/usenet/session";

export function fmtBytes(n: number) {
  if (!n && n !== 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(s: number) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mmss = `${m}:${sec.toString().padStart(2, "0")}`;
  return h ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}` : mmss;
}

export function Player({ sessionId, item, items, onEvent }: { sessionId: string; item: MediaItem; items: MediaItem[]; onEvent?: (m: string) => void }) {
  const base = `/api/sessions/${sessionId}/stream/${item.id}`;
  const [mimeOverride, setMimeOverride] = useState<string>("");
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [prep, setPrep] = useState<{ pct: number; detail: string } | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const streamSrc = mimeOverride ? `${base}?mime=${encodeURIComponent(mimeOverride)}` : base;
  const mediaSrc = item.needsDecompress ? blobUrl : streamSrc;
  const absolute = typeof window !== "undefined" ? `${window.location.origin}${base}` : base;
  const subtitles = items.filter((i) => i.kind === "subtitle" && (i.ext === "srt" || i.ext === "vtt") && i.playable);

  useEffect(() => {
    // reset viewer state when the selected item changes
    // eslint-disable-next-line react-hooks/set-state-in-effect -- item switch is an external event
    setErr(null);
    setText(null);
    setMimeOverride("");
    setBlobUrl(null);
    setPrep(null);
    setWaiting(false);
    setDuration(0);
    setCurrent(0);
    if (item.kind === "text" || (item.kind === "subtitle" && item.ext !== "srt" && item.ext !== "vtt")) {
      fetch(`${base}`, { headers: { range: "bytes=0-1048575" } })
        .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((t) => setText(t))
        .catch((e) => setErr(String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Compressed archives: pull the fully inflated body into a blob so the
  // <video> element can seek locally. Native range requests would otherwise
  // stall on the first tail-probe (moov-at-end) until the whole RAR inflates.
  useEffect(() => {
    if (!item.needsDecompress) return;
    if (!(item.kind === "video" || item.kind === "audio" || item.kind === "image" || item.kind === "pdf")) return;
    const ac = new AbortController();
    let objectUrl: string | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const run = async () => {
      setPrep({ pct: 1, detail: `Inflating ${item.method ?? "compressed"} ${item.container}…` });
      onEvent?.(`inflate start: ${item.name} (${item.method})`);
      poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/sessions/${sessionId}/diag?snapshot=1`);
          if (!r.ok) return;
          const j = (await r.json()) as { stats?: { bytesDownloaded?: number; bytesDecoded?: number }; events?: Array<{ cat: string; msg: string }> };
          const dl = j.stats?.bytesDownloaded ?? 0;
          const packed = item.packedSize || item.size;
          const last = [...(j.events ?? [])].reverse().find((e) => e.cat === "archive");
          setPrep((p) =>
            p
              ? {
                  pct: Math.min(90, Math.max(p.pct, (dl / Math.max(packed, 1)) * 85)),
                  detail: last?.msg ?? `${fmtBytes(dl)} fetched from usenet`,
                }
              : p,
          );
        } catch {
          /* ignore */
        }
      }, 700);
      const res = await fetch(streamSrc, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || item.size;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no response body");
      const chunks: Uint8Array[] = [];
      let rec = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        rec += value.length;
        setPrep({ pct: Math.min(99, (rec / Math.max(total, 1)) * 100), detail: `${fmtBytes(rec)} / ${fmtBytes(total)} inflated` });
      }
      const blob = new Blob(chunks as BlobPart[], { type: mimeOverride || item.browserMime });
      objectUrl = URL.createObjectURL(blob);
      setBlobUrl(objectUrl);
      setPrep(null);
      onEvent?.(`inflate ready: ${item.name} (${fmtBytes(rec)})`);
    };
    run().catch((e) => {
      if ((e as Error).name === "AbortError") return;
      const m = `Inflate failed: ${(e as Error).message}`;
      setErr(m);
      setPrep(null);
      onEvent?.(m);
    });
    return () => {
      ac.abort();
      if (poll) clearInterval(poll);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.needsDecompress, streamSrc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = mediaRef.current;
      if (!el || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        el.paused ? void el.play() : el.pause();
      } else if (e.code === "ArrowRight") el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
      else if (e.code === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
      else if (e.key === "f") void (el as HTMLVideoElement).requestFullscreen?.();
      else if (e.key === "m" && "muted" in el) el.muted = !el.muted;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mediaSrc]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Stream URL", absolute);
    }
  };

  const mediaError = () => {
    const el = mediaRef.current;
    const code = el?.error?.code;
    const msgs: Record<number, string> = {
      1: "aborted",
      2: "network error while fetching the stream",
      3: "decode error — the codec inside this container is not supported by this browser",
      4: "source not supported — the browser refused this container/mime",
    };
    const m = `Playback error ${code ?? "?"}: ${msgs[code ?? 0] ?? el?.error?.message ?? "unknown"}`;
    setErr(m);
    onEvent?.(m);
  };

  const showVideo = item.kind === "video" && item.playable;
  const showAudio = item.kind === "audio" && item.playable;
  const preparing = !!(item.needsDecompress && !blobUrl && !err && (showVideo || showAudio || item.kind === "image" || item.kind === "pdf"));

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl overflow-hidden bg-black border border-zinc-800 min-h-[200px] flex items-center justify-center relative">
        {preparing && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-zinc-950/90 p-8 text-center">
            <div className="text-4xl">🎬</div>
            <div className="font-medium text-zinc-100 break-all">{item.name}</div>
            <div className="text-sm text-zinc-400 max-w-md">{prep?.detail ?? `Preparing compressed ${item.container} (${item.method})…`}</div>
            <div className="w-full max-w-md h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${prep?.pct ?? 5}%` }} />
            </div>
            <div className="text-xs text-zinc-500">{Math.round(prep?.pct ?? 0)}% · fetching from usenet, then inflating in WASM</div>
          </div>
        )}
        {waiting && !preparing && (
          <div className="absolute top-3 left-3 z-10 text-[11px] px-2 py-1 rounded bg-black/70 text-emerald-300 border border-emerald-900">buffering from usenet…</div>
        )}
        {showVideo && (
          <video
            key={mediaSrc ?? item.id}
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={mediaSrc ?? undefined}
            controls
            autoPlay
            playsInline
            crossOrigin="anonymous"
            className="w-full max-h-[70vh] bg-black"
            onError={mediaError}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onTimeUpdate={(e) => setCurrent((e.target as HTMLVideoElement).currentTime)}
            onLoadedMetadata={(e) => {
              const v = e.target as HTMLVideoElement;
              setDuration(v.duration);
              onEvent?.(`metadata loaded: ${item.name} (${fmtTime(v.duration)})`);
              void v.play().catch(() => {});
            }}
          >
            {subtitles.map((s, i) => (
              <track key={s.id} kind="subtitles" label={s.name} srcLang={/\.([a-z]{2,3})\.(srt|vtt)$/i.exec(s.name)?.[1] ?? "en"} src={`/api/sessions/${sessionId}/stream/${s.id}?vtt=1`} default={i === 0} />
            ))}
          </video>
        )}
        {showAudio && (
          <div className="p-8 w-full flex flex-col items-center gap-4">
            <div className="text-5xl">🎵</div>
            <div className="text-zinc-200 text-center break-all">{item.name}</div>
            <audio
              key={mediaSrc ?? item.id}
              ref={(el) => {
                mediaRef.current = el;
              }}
              src={mediaSrc ?? undefined}
              controls
              autoPlay
              className="w-full max-w-xl"
              onError={mediaError}
              onTimeUpdate={(e) => setCurrent((e.target as HTMLAudioElement).currentTime)}
              onLoadedMetadata={(e) => setDuration((e.target as HTMLAudioElement).duration)}
            />
          </div>
        )}
        {item.kind === "image" && item.playable && (!item.needsDecompress || blobUrl) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaSrc ?? streamSrc} alt={item.name} className="max-h-[70vh] object-contain" onError={() => setErr("image failed to load")} />
        )}
        {item.kind === "pdf" && (!item.needsDecompress || blobUrl) && <iframe title={item.name} src={mediaSrc ?? streamSrc} className="w-full h-[70vh] bg-white" />}
        {(item.kind === "text" || item.kind === "subtitle") && (
          <pre className="w-full max-h-[70vh] overflow-auto p-4 text-xs text-zinc-200 whitespace-pre-wrap font-mono">{text ?? (err ? "" : "loading…")}</pre>
        )}
        {!item.playable && item.kind !== "pdf" && item.kind !== "text" && item.kind !== "subtitle" && (
          <div className="p-8 text-center text-zinc-300 max-w-lg">
            <div className="text-4xl mb-3">📦</div>
            <div className="font-medium break-all">{item.name}</div>
            <div className="text-sm text-zinc-400 mt-2">{item.reason ?? "This item cannot be played in the browser."}</div>
            <div className="text-xs text-zinc-500 mt-3">You can still download it or open the stream URL in VLC / mpv (both support HTTP range seeking).</div>
          </div>
        )}
      </div>
      {(showVideo || showAudio) && duration > 0 && (
        <div className="text-[11px] text-zinc-500 flex gap-3">
          <span>
            {fmtTime(current)} / {fmtTime(duration)}
          </span>
          {item.needsDecompress && <span className="text-orange-300">local blob (seekable) after inflate</span>}
          {!item.needsDecompress && <span>HTTP 206 ranges · usenet live</span>}
        </div>
      )}
      {err && <div className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">{err}</div>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">{item.ext ? item.ext.toUpperCase() : "BIN"}</span>
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">{fmtBytes(item.size)}</span>
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">{item.container === "direct" ? "direct" : `inside ${item.container}`}</span>
        {item.needsDecompress && <span className="px-2 py-1 rounded bg-orange-950 text-orange-200">{item.method ?? "compressed"}</span>}
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-400">{item.browserMime}</span>
        <div className="grow" />
        {item.kind === "video" && (
          <select value={mimeOverride} onChange={(e) => setMimeOverride(e.target.value)} className="bg-zinc-800 text-zinc-200 rounded px-2 py-1" title="Force the mime type the browser sees">
            <option value="">mime: auto</option>
            <option value="video/mp4">video/mp4</option>
            <option value="video/webm">video/webm</option>
            <option value="video/x-matroska">video/x-matroska</option>
            <option value="video/mp2t">video/mp2t</option>
          </select>
        )}
        <button onClick={copy} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
          {copied ? "copied!" : "copy stream URL"}
        </button>
        <a href={`${base}?m3u=1`} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
          open in VLC (.m3u)
        </a>
        <a href={`${base}?dl=1`} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
          download
        </a>
      </div>
    </div>
  );
}
