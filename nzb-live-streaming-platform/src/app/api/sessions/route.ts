import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { providers, sessions } from "@/db/schema";
import { parseNzb } from "@/lib/usenet/nzb";
import { StreamSession, providerToConfig, registerSession } from "@/lib/usenet/session";
import { getIndexerConfig } from "@/lib/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      source: sessions.source,
      providerId: sessions.providerId,
      fileCount: sessions.fileCount,
      totalBytes: sessions.totalBytes,
      createdAt: sessions.createdAt,
      analyzed: sessions.itemsJson,
    })
    .from(sessions)
    .orderBy(desc(sessions.createdAt))
    .limit(50);
  return NextResponse.json(rows.map((r) => ({ ...r, analyzed: !!r.analyzed })));
}

/**
 * Create a session from an NZB. Accepts JSON:
 *  { providerId, source: "url"|"indexer"|"paste", url?, guid?, xml?, title? }
 * or multipart/form-data with fields providerId, file (the .nzb), title.
 */
export async function POST(req: Request) {
  try {
    let providerId: number | null = null;
    let xml = "";
    let source = "paste";
    let sourceRef: string | null = null;
    let title = "";
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      providerId = Number(fd.get("providerId")) || null;
      const f = fd.get("file");
      if (!(f instanceof File)) throw new Error("file missing");
      xml = await f.text();
      source = "upload";
      sourceRef = f.name;
      title = String(fd.get("title") ?? "") || f.name.replace(/\.nzb$/i, "");
    } else {
      const b = (await req.json()) as { providerId?: number; source?: string; url?: string; guid?: string; xml?: string; title?: string };
      providerId = b.providerId ?? null;
      title = b.title ?? "";
      if (b.source === "indexer" && b.guid) {
        const cfg = await getIndexerConfig();
        const u = `${cfg.url}/api?t=get&id=${encodeURIComponent(b.guid)}&apikey=${encodeURIComponent(cfg.apiKey)}`;
        xml = await fetchNzb(u);
        source = "indexer";
        sourceRef = b.guid;
      } else if (b.url) {
        xml = await fetchNzb(b.url);
        source = "url";
        sourceRef = b.url;
        title ||= decodeURIComponent(b.url.split("/").pop() ?? "").replace(/\.nzb$/i, "").split("?")[0];
      } else if (b.xml) {
        xml = b.xml;
      } else throw new Error("Provide url, guid or xml");
    }
    const nzb = parseNzb(xml);
    title ||= nzb.meta.name || nzb.files[0].subjectName.replace(/\.(part\d+\.)?(rar|r\d\d|par2|nfo|sfv|\d{3})$/i, "") || "Untitled";

    let prov;
    if (providerId) [prov] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
    if (!prov) [prov] = await db.select().from(providers).limit(1);
    if (!prov) throw new Error("Configure an NNTP provider first");

    const [row] = await db
      .insert(sessions)
      .values({
        title,
        source,
        sourceRef,
        providerId: prov.id,
        nzbXml: xml,
        fileCount: nzb.files.length,
        totalBytes: Math.min(2147483647, nzb.files.reduce((n, f) => n + f.encodedBytes, 0)),
      })
      .returning();
    const sess = new StreamSession(row.id, row.title, nzb, providerToConfig(prov), row.createdAt.getTime(), null);
    registerSession(sess);
    // kick off analysis in the background; the UI polls /api/sessions/[id]
    void sess.analyze().catch(() => {});
    return NextResponse.json(sess.info(), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

async function fetchNzb(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "follow", headers: { "user-agent": "nzbstream/1.0" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`NZB download failed: HTTP ${res.status} ${text.slice(0, 120)}`);
  if (!/<nzb[\s>]/i.test(text)) throw new Error(`URL did not return an NZB (${res.headers.get("content-type")}): ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  return text;
}
