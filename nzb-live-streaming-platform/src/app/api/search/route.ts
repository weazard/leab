import { NextResponse } from "next/server";
import { getIndexerConfig, newznabSearch } from "@/lib/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    const cfg = await getIndexerConfig();
    if (!cfg.apiKey) return NextResponse.json({ error: "No indexer API key configured (settings → indexer)" }, { status: 400 });
    const type = (sp.get("type") as "search" | "tvsearch" | "movie" | null) ?? "search";
    const out = await newznabSearch(cfg, {
      query: sp.get("q") ?? undefined,
      type,
      cat: sp.get("cat") ?? undefined,
      imdbid: sp.get("imdbid") ?? undefined,
      season: sp.get("season") ?? undefined,
      ep: sp.get("ep") ?? undefined,
      offset: Number(sp.get("offset") ?? 0) || 0,
      limit: Number(sp.get("limit") ?? 50) || 50,
    });
    return NextResponse.json({ ...out, indexer: cfg.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
