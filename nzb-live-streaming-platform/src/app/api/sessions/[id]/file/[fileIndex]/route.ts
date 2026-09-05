import { NextResponse } from "next/server";
import { getSession } from "@/lib/usenet/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; fileIndex: string }> };

/** Range-serve a raw NZB file (e.g. a RAR volume) so WASM extractors can pull bytes. */
export async function GET(req: Request, ctx: Ctx) {
  return handle(req, ctx, false);
}
export async function HEAD(req: Request, ctx: Ctx) {
  return handle(req, ctx, true);
}

async function handle(req: Request, { params }: Ctx, headOnly: boolean) {
  const { id, fileIndex } = await params;
  const s = await getSession(id);
  if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const idx = Number(fileIndex);
  const file = s.files[idx];
  if (!file) return NextResponse.json({ error: "file not found" }, { status: 404 });
  try {
    await file.init();
  } catch (e) {
    return NextResponse.json({ error: `cannot read first segment: ${(e as Error).message}` }, { status: 502 });
  }
  const size = file.size;
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-range, content-length, accept-ranges",
    "content-disposition": `inline; filename="${file.name.replace(/[^\w.\- ()[\]]+/g, "_")}"`,
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
    if (m[1] === "") start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (headOnly) return new Response(null, { status, headers });
  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort());
  const gen = file.stream(start, end, ac.signal);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      ac.abort();
      void gen.return(undefined);
    },
  });
  return new Response(body, { status, headers });
}
