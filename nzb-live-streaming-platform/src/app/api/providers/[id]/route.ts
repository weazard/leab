import { db } from "@/db";
import { providers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { parseProviderBody, sanitize } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  try {
    const raw = (await req.json()) as Record<string, unknown>;
    const body = parseProviderBody(raw);
    const [existing] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    // keep stored password if the client sent the mask / nothing
    if (!raw.password || raw.password === "••••••") body.password = existing.password;
    const [row] = await db.update(providers).set(body).where(eq(providers.id, id)).returning();
    return NextResponse.json(sanitize(row));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  await db.delete(providers).where(eq(providers.id, id));
  return NextResponse.json({ ok: true });
}
