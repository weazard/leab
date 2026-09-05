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

export function Player({ sessionId, item, items, onEvent }: { sessionId: string; item: MediaItem; items: MediaItem[]; onEvent?: (m: string) => void }) {
  const base = `/api/sessions/${sessionId}/stream/${item.id}`;
  const [mimeOverride, setMimeOverride] = useState<string>("");
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const src = mimeOverride ? `${base}?mime=${encodeURIComponent(mimeOverride)}` : base;
  const absolute = typeof window !== "undefined" ? `${window.location.origin}${base}` : base;
  const subtitles = items.filter((i) => i.kind === "subtitle" && (i.ext === "srt" || i.ext === "vtt") && i.playable);

  useEffect(() => {
    setErr(null);
    setText(null);
    setMimeOverride("");
    if (item.kind === "text" || (item.kind === "subtitle" && item.ext !== "srt" && item.ext !== "vtt")) {
      fetch(`${base}`, { headers: { range: "bytes=0-1048575" } })
        .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((t) => setText(t))
        .catch((e) => setErr(String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

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

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl overflow-hidden bg-black border border-zinc-800 min-h-[200px] flex items-center justify-center">
        {item.kind === "video" && item.playable && (
          <video
            key={src}
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={src}
            controls
            autoPlay
            playsInline
            crossOrigin="anonymous"
            className="w-full max-h-[70vh] bg-black"
            onError={mediaError}
            onLoadedMetadata={() => onEvent?.(`metadata loaded: ${item.name}`)}
          >
            {subtitles.map((s, i) => (
              <track key={s.id} kind="subtitles" label={s.name} srcLang={/\.([a-z]{2,3})\.(srt|vtt)$/i.exec(s.name)?.[1] ?? "en"} src={`/api/sessions/${sessionId}/stream/${s.id}?vtt=1`} default={i === 0} />
            ))}
          </video>
        )}
        {item.kind === "audio" && item.playable && (
          <div className="p-8 w-full flex flex-col items-center gap-4">
            <div className="text-5xl">🎵</div>
            <div className="text-zinc-200 text-center break-all">{item.name}</div>
            <audio
              key={src}
              ref={(el) => {
                mediaRef.current = el;
              }}
              src={src}
              controls
              autoPlay
              className="w-full max-w-xl"
              onError={mediaError}
            />
          </div>
        )}
        {item.kind === "image" && item.playable && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={item.name} className="max-h-[70vh] object-contain" onError={() => setErr("image failed to load")} />
        )}
        {item.kind === "pdf" && <iframe title={item.name} src={src} className="w-full h-[70vh] bg-white" />}
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
      {err && <div className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">{err}</div>}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">{item.ext ? item.ext.toUpperCase() : "BIN"}</span>
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">{fmtBytes(item.size)}</span>
        <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-300">{item.container === "direct" ? "direct" : `inside ${item.container}`}</span>
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
