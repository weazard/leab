import { NextResponse } from "next/server";
import { db } from "@/db";
import { providers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Diag } from "@/lib/usenet/diag";
import { NntpPool } from "@/lib/usenet/nntp";
import { parseProviderBody } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Test an NNTP provider: connect, greet, auth, DATE. Body = provider fields or {id}. */
export async function POST(req: Request) {
  try {
    const raw = (await req.json()) as Record<string, unknown>;
    let cfg;
    if (raw.id && (!raw.password || raw.password === "••••••")) {
      const [p] = await db.select().from(providers).where(eq(providers.id, Number(raw.id))).limit(1);
      if (!p) return NextResponse.json({ error: "provider not found" }, { status: 404 });
      cfg = { ...parseProviderBody({ ...p, ...raw, password: p.password }), password: p.password };
    } else cfg = parseProviderBody(raw);
    const diag = new Diag(50);
    const res = await NntpPool.test({ ...cfg, timeoutMs: 15000 }, diag);
    return NextResponse.json({ ...res, log: diag.since(0) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
