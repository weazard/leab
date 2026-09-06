import { db } from "@/db";
import { settings } from "@/db/schema";

export interface IndexerConfig {
  url: string;
  apiKey: string;
  source: "settings" | "env" | "none";
}

export async function getIndexerConfig(): Promise<IndexerConfig> {
  const rows = await db.select().from(settings).catch(() => []);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const url = (map.indexer_url || process.env.NEWZNAB_URL || "https://api.nzb.life").replace(/\/+$/, "");
  const apiKey = map.indexer_key || process.env.NEWZNAB_API_KEY || "";
  return { url, apiKey, source: map.indexer_key ? "settings" : process.env.NEWZNAB_API_KEY ? "env" : "none" };
}

export interface SearchResult {
  guid: string;
  title: string;
  size: number;
  category: string;
  pubDate: string;
  nzbUrl: string;
  details?: string;
}

interface NewznabItem {
  title?: string;
  guid?: string | { "@attributes"?: Record<string, string>; text?: string } | Record<string, unknown>;
  link?: string;
  pubDate?: string;
  category?: string;
  enclosure?: { "@attributes"?: Record<string, string> };
  attr?: Array<{ "@attributes"?: { name?: string; value?: string } }> | { "@attributes"?: { name?: string; value?: string } };
}

export async function newznabSearch(
  cfg: IndexerConfig,
  q: { query?: string; type?: "search" | "tvsearch" | "movie"; cat?: string; imdbid?: string; season?: string; ep?: string; offset?: number; limit?: number },
): Promise<{ results: SearchResult[]; total: number; url: string; raw?: string }> {
  const u = new URL(`${cfg.url}/api`);
  u.searchParams.set("t", q.type ?? "search");
  if (q.query) u.searchParams.set("q", q.query);
  if (q.cat) u.searchParams.set("cat", q.cat);
  if (q.imdbid) u.searchParams.set("imdbid", q.imdbid.replace(/^tt/, ""));
  if (q.season) u.searchParams.set("season", q.season);
  if (q.ep) u.searchParams.set("ep", q.ep);
  u.searchParams.set("o", "json");
  u.searchParams.set("extended", "1");
  u.searchParams.set("limit", String(q.limit ?? 50));
  if (q.offset) u.searchParams.set("offset", String(q.offset));
  u.searchParams.set("apikey", cfg.apiKey);
  const res = await fetch(u, { signal: AbortSignal.timeout(25000), headers: { "user-agent": "nzbstream/1.0" }, redirect: "follow" });
  const text = await res.text();
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`indexer returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (json.error || (json["@attributes"] as Record<string, string> | undefined)?.code) {
    const a = (json.error ?? json["@attributes"]) as Record<string, string>;
    throw new Error(`indexer error ${a.code ?? ""}: ${a.description ?? JSON.stringify(a)}`);
  }
  const channel = (json.channel ?? {}) as Record<string, unknown>;
  // keep a peek at the payload: debugging a silent "0 results" from a runner
  // is impossible otherwise (the api key lives in the query string)
  const raw = text.slice(0, 400);
  const itemsRaw = channel.item;
  const items: NewznabItem[] = Array.isArray(itemsRaw) ? itemsRaw : itemsRaw ? [itemsRaw as NewznabItem] : [];
  const total = Number(((channel.response as Record<string, unknown> | undefined)?.["@attributes"] as Record<string, string> | undefined)?.total ?? items.length);
  const results: SearchResult[] = items.map((it) => {
    const attrs = Array.isArray(it.attr) ? it.attr : it.attr ? [it.attr] : [];
    const attr = (n: string) => attrs.find((a) => a["@attributes"]?.name === n)?.["@attributes"]?.value;
    let guid = attr("guid") ?? "";
    if (!guid) {
      const g = typeof it.guid === "string" ? it.guid : ((it.guid as Record<string, unknown>)?.text as string) ?? "";
      guid = g.split("/").pop() ?? g;
    }
    const size = Number(attr("size") ?? it.enclosure?.["@attributes"]?.length ?? 0);
    return {
      guid,
      title: it.title ?? guid,
      size,
      category: it.category ?? attr("category") ?? "",
      pubDate: it.pubDate ?? "",
      nzbUrl: `${cfg.url}/api?t=get&id=${encodeURIComponent(guid)}&apikey=${encodeURIComponent(cfg.apiKey)}`,
      details: typeof it.guid === "string" ? it.guid : undefined,
    };
  });
  return { results, total, raw, url: u.toString().replace(cfg.apiKey, "***") };
}
