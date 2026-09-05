import { db } from "@/db";
import { providers } from "@/db/schema";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { parseProviderBody, sanitize } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const rows = await db.select().from(providers).orderBy(desc(providers.id));
  return NextResponse.json(rows.map(sanitize));
}

export async function POST(req: Request) {
  try {
    const body = parseProviderBody(await req.json());
    const [row] = await db.insert(providers).values(body).returning();
    return NextResponse.json(sanitize(row), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
