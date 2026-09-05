import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { dropSession, getSession } from "@/lib/usenet/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Session info + media items. ?analyze=1 (re)runs analysis; ?wait=1 blocks until it finishes. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  try {
    const s = await getSession(id);
    if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
    const force = sp.get("analyze") === "1";
    if (force || (!s.items && !s.analyzeError) || (sp.get("retry") === "1" && s.analyzeError)) {
      const p = s.analyze(force).catch(() => []);
      if (sp.get("wait") === "1") await Promise.race([p, new Promise((r) => setTimeout(r, 25000))]);
    }
    return NextResponse.json({ ...s.info(), items: s.items ?? [], stats: s.diag.stats });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await dropSession(id);
  await db.delete(sessions).where(eq(sessions.id, id));
  return NextResponse.json({ ok: true });
}
