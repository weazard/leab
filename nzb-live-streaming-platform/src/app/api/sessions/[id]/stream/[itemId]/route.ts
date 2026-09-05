import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { getSession } from "@/lib/usenet/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/**
 * HTTP byte-range streaming of a media item straight out of usenet.
 *   ?dl=1         → Content-Disposition: attachment
 *   ?vtt=1        → convert SubRip (.srt) to WebVTT on the fly
 *   ?mime=<type>  → override the Content-Type given to the browser
 *   ?m3u=1        → playlist pointing at this stream (open in VLC/mpv)
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(req, ctx, false);
}
export async function HEAD(req: Request, ctx: Ctx) {
  return handle(req, ctx, true);
}

async function handle(req: Request, { params }: Ctx, headOnly: boolean) {
  const { id, itemId } = await params;
  const url = new URL(req.url);
  const sp = url.searchParams;
  const s = await getSession(id);
  if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
  if (!s.items) await s.analyze().catch(() => {});
  const item = s.getItem(itemId);
  if (!item) return NextResponse.json({ error: "item not found" }, { status: 404 });
  const diag = s.diag;

  if (sp.get("m3u") === "1") {
    const streamUrl = `${url.origin}/api/sessions/${id}/stream/${itemId}`;
    const body = `#EXTM3U\n#EXTINF:-1,${item.name}\n${streamUrl}\n`;
    return new Response(body, {
      headers: { "content-type": "audio/x-mpegurl", "content-disposition": `attachment; filename="${safeName(item.name)}.m3u"` },
    });
  }

  const reader = s.reader(item);
  if (item.src.type === "direct") {
    try {
      await s.files[item.src.file].init();
    } catch (e) {
      return NextResponse.json({ error: `cannot read first segment: ${(e as Error).message}` }, { status: 502 });
    }
  }
  const size = reader.size;
  void db.update(sessions).set({ lastPlayedAt: new Date() }).where(eq(sessions.id, id)).catch(() => {});

  // SRT → VTT conversion (small text files: read fully)
  if (sp.get("vtt") === "1") {
    const buf = await reader.read(0, Math.min(size, 5 * 1024 * 1024));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const vtt = "WEBVTT\n\n" + text.replace(/^\uFEFF/, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/\r/g, "");
    diag.info("range", `served ${item.name} as WebVTT (${vtt.length} chars)`);
    return new Response(vtt, { headers: { "content-type": "text/vtt; charset=utf-8", "cache-control": "no-store" } });
  }

  const mime = sp.get("mime") || (sp.get("dl") === "1" ? item.mime : item.browserMime);
  const headers = new Headers({
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": `${sp.get("dl") === "1" ? "attachment" : "inline"}; filename="${safeName(item.name)}"`,
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-range, content-length, accept-ranges",
  });

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (m[1] === "") {
      // suffix range
      const n = Number(m[2]);
      start = Math.max(0, size - n);
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      headers.set("content-range", `bytes */${size}`);
      diag.warn("range", `${item.name}: unsatisfiable range ${range} (size ${size})`);
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (headOnly) return new Response(null, { status, headers });

  const ac = new AbortController();
  const ua = req.headers.get("user-agent") ?? "";
  const label = `${item.name} [${start}-${end}] (${fmtBytes(end - start + 1)})`;
  diag.info("range", `range request ${status} ${label}${range ? ` ← "${range}"` : ""}`, {
    item: item.id,
    start,
    end,
    size,
    ua: ua.slice(0, 60),
  });
  diag.stats.activeStreams++;
  const t0 = Date.now();
  let sent = 0;
  const gen = reader.stream(start, end, ac.signal);
  let finished = false;
  const finish = (why: string) => {
    if (finished) return;
    finished = true;
    diag.stats.activeStreams = Math.max(0, diag.stats.activeStreams - 1);
    diag.stats.bytesServed += sent;
    const ms = Date.now() - t0;
    diag.info("range", `${why} ${item.name}: sent ${fmtBytes(sent)} of ${fmtBytes(end - start + 1)} in ${ms}ms (${fmtBytes((sent / Math.max(ms, 1)) * 1000)}/s)`, {
      item: item.id,
      sent,
      ms,
    });
  };
  req.signal.addEventListener("abort", () => {
    ac.abort();
    finish("client aborted");
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          finish("completed");
          return;
        }
        sent += value.length;
        controller.enqueue(value);
      } catch (e) {
        diag.error("range", `${item.name}: stream error: ${(e as Error).message}`);
        controller.error(e);
        finish("errored");
      }
    },
    cancel() {
      ac.abort();
      void gen.return(undefined);
      finish("cancelled");
    },
  });
  return new Response(body, { status, headers });
}

function safeName(n: string) {
  return n.replace(/[^\w.\- ()\[\]]+/g, "_");
}
function fmtBytes(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
