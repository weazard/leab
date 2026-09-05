import { NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { getIndexerConfig } from "@/lib/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cfg = await getIndexerConfig();
  return NextResponse.json({ indexerUrl: cfg.url, hasKey: !!cfg.apiKey, keySource: cfg.source, keyHint: cfg.apiKey ? `…${cfg.apiKey.slice(-4)}` : "" });
}

export async function POST(req: Request) {
  const b = (await req.json()) as { indexerUrl?: string; apiKey?: string };
  const put = async (key: string, value: string) =>
    db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  if (b.indexerUrl !== undefined) await put("indexer_url", b.indexerUrl.trim());
  if (b.apiKey) await put("indexer_key", b.apiKey.trim());
  const cfg = await getIndexerConfig();
  return NextResponse.json({ indexerUrl: cfg.url, hasKey: !!cfg.apiKey, keySource: cfg.source, keyHint: cfg.apiKey ? `…${cfg.apiKey.slice(-4)}` : "" });
}
