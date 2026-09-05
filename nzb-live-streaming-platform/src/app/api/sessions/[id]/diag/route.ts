import { NextResponse } from "next/server";
import { getSession } from "@/lib/usenet/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Diagnostics. Default: Server-Sent Events (backlog since ?since=seq, then live).
 * ?snapshot=1 returns JSON: stats + recent events + per-file segment maps
 * (works on platforms that buffer streaming responses).
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const s = await getSession(id);
  if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const since = Number(sp.get("since") ?? 0) || 0;
  const snapshot = () => ({
    stats: { ...s.diag.stats, cacheBytes: s.diag.stats.cacheBytes, poolSize: s.pool.size, poolBusy: s.pool.busy },
    lastSeq: s.diag.lastSeq,
    files: s.files.map((f) => ({ index: f.file.index, name: f.resolvedName, segments: f.segmentCount, states: f.stateString(), partSize: f.estimatedPartSize, size: f.size })),
  });
  if (sp.get("snapshot") === "1") {
    return NextResponse.json({ ...snapshot(), events: s.diag.since(since, Number(sp.get("limit") ?? 500) || 500) });
  }

  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };
      send("snapshot", snapshot());
      for (const e of s.diag.since(since, 300)) send("log", e);
      unsub = s.diag.subscribe((e) => send("log", e));
      timer = setInterval(() => send("snapshot", snapshot()), 1000);
      req.signal.addEventListener("abort", () => {
        unsub?.();
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsub?.();
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
