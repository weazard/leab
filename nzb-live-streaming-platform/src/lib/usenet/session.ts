/**
 * Streaming sessions: NZB + provider + in-memory engine state.
 *
 * Sessions are persisted (NZB xml, provider id, analysed item list) so a
 * cold serverless instance can rebuild everything it needs lazily. The
 * heavy state (NNTP pool, segment cache, diagnostics) is per-instance.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { providers, sessions, type Provider } from "@/db/schema";
import { Diag } from "./diag";
import { NntpPool, type NntpConfig } from "./nntp";
import { parseNzb, type ParsedNzb } from "./nzb";
import { NzbVirtualFile, type RandomReader } from "./virtualfile";
import { parseRarSet, rarVolumeKey, type ArchiveChunk } from "./rar";
import { parsePar2, parseZip, type Par2Info } from "./zip_par2";
import { detect, type MediaKind } from "./detect";
import { segmentCache } from "./cache";
import { InflatingReader, maxInflateBytes } from "./inflate";
import { probeCodecs, type CodecInfo } from "./codecs";

const fmtBytesLocal = (n: number) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

export interface MediaItem {
  id: string;
  name: string;
  size: number;
  kind: MediaKind;
  ext: string;
  mime: string;
  browserMime: string;
  playable: boolean;
  /** compressed RAR/ZIP — server inflates (WASM / DecompressionStream) then serves ranges */
  needsDecompress?: boolean;
  packedSize?: number;
  method?: string;
  container: "direct" | "rar" | "zip";
  containerName?: string;
  reason?: string;
  crc?: string;
  /** container + codec probe, when the head of the file could be parsed */
  codecs?: CodecInfo;
  /** how to rebuild a reader on a fresh instance */
  src: { type: "direct"; file: number } | { type: "chunks"; files: number[]; chunks: ArchiveChunk[] };
}

export interface SessionInfo {
  id: string;
  title: string;
  provider: { id: number | null; name: string; host: string };
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  analyzed: boolean;
  analyzing: boolean;
  analyzeError?: string;
  meta: Record<string, string>;
  par2?: { files: number; sliceSize: number };
  files: Array<{ index: number; name: string; size: number; segments: number; groups: string[] }>;
}

export class StreamSession {
  readonly diag = new Diag();
  readonly pool: NntpPool;
  readonly files: NzbVirtualFile[];
  items: MediaItem[] | null = null;
  par2: Par2Info | null = null;
  analyzeError: string | null = null;
  private analyzing: Promise<MediaItem[]> | null = null;
  private readers = new Map<string, RandomReader>();
  lastAccess = Date.now();

  constructor(
    readonly id: string,
    readonly title: string,
    readonly nzb: ParsedNzb,
    readonly providerCfg: NntpConfig & { id: number | null; name: string },
    readonly createdAt: number,
    cachedItems: MediaItem[] | null,
  ) {
    this.pool = new NntpPool(providerCfg, this.diag);
    this.files = nzb.files.map((f) => new NzbVirtualFile(id, f, this.pool, this.diag));
    if (cachedItems) {
      this.items = cachedItems.map(hydrateCompressed);
      // restore resolved names for display
      for (const it of this.items) if (it.src.type === "direct") this.files[it.src.file].resolvedName = it.name;
    }
    this.diag.info("session", `session ${id} ready: "${title}" — ${nzb.files.length} files, provider ${providerCfg.name} (${providerCfg.host}:${providerCfg.port} tls=${providerCfg.ssl}, ${providerCfg.connections} conns)`, {
      files: nzb.files.length,
      cachedAnalysis: !!cachedItems,
    });
  }

  touch() {
    this.lastAccess = Date.now();
  }

  info(): SessionInfo {
    return {
      id: this.id,
      title: this.title,
      provider: { id: this.providerCfg.id, name: this.providerCfg.name, host: this.providerCfg.host },
      fileCount: this.files.length,
      totalBytes: this.files.reduce((n, f) => n + f.size, 0),
      createdAt: this.createdAt,
      analyzed: !!this.items,
      analyzing: !!this.analyzing,
      analyzeError: this.analyzeError ?? undefined,
      meta: this.nzb.meta,
      par2: this.par2 ? { files: this.par2.files.length, sliceSize: this.par2.sliceSize } : undefined,
      files: this.files.map((f) => ({
        index: f.file.index,
        name: f.resolvedName,
        size: f.size,
        segments: f.segmentCount,
        groups: f.file.groups,
      })),
    };
  }

  /** Inspect every file (first segment), recover names, map archives → media items. */
  analyze(force = false): Promise<MediaItem[]> {
    if (this.items && !force) return Promise.resolve(this.items);
    if (this.analyzing) return this.analyzing;
    this.analyzing = this.doAnalyze()
      .then(async (items) => {
        this.items = items;
        this.analyzeError = null;
        await db
          .update(sessions)
          .set({ itemsJson: JSON.stringify(items), totalBytes: Math.min(2147483647, this.files.reduce((n, f) => n + f.size, 0)) })
          .where(eq(sessions.id, this.id))
          .catch((e) => this.diag.warn("session", `could not persist analysis: ${(e as Error).message}`));
        return items;
      })
      .catch((e) => {
        this.analyzeError = (e as Error).message;
        this.diag.error("analyze", `analysis failed: ${this.analyzeError}`);
        throw e;
      })
      .finally(() => (this.analyzing = null));
    return this.analyzing;
  }

  private async doAnalyze(): Promise<MediaItem[]> {
    const t0 = Date.now();
    this.diag.info("analyze", `analyzing ${this.files.length} file(s): fetching first segment of each to learn size, real name and type`);

    // 1. init files (bounded concurrency).
    //
    // PAR2 / sfv / nfo volumes are only fetched when we actually need them:
    // a scene release easily carries 10–40 of them and none of them are the
    // movie, so probing all of them first means the user waits on round trips
    // that cannot possibly produce a play button.
    const failed = new Set<number>();
    const readable = new Set<number>();
    // Is this an obfuscated post name? Deliberately conservative: a false
    // positive costs a full PAR2 fetch of dozens of recovery volumes before
    // anything can play, so `Some_Show_S01E01_1080p_WEB-DL` must stay "not
    // random" even though it is long and made of url-safe characters.
    const looksRandom = (n: string) => {
      const base = n.replace(/\.[A-Za-z0-9]+$/, "");
      if (/^[a-f0-9]{24,}$/i.test(base)) return true; // md5/sha1-style hash
      if (!/^[A-Za-z0-9+/=]{24,}$/.test(base)) return false; // separators ⇒ a real name
      const upper = /[A-Z]/.test(base);
      const lower = /[a-z]/.test(base);
      const digits = (base.match(/\d/g) ?? []).length;
      return (upper && lower && digits >= 3) || !/[aeiouy]/i.test(base);
    };
    // PAR2 recovery volumes only: nfo/sfv are single tiny articles and are
    // worth showing, a par2 set can be 40 articles and is worth nothing here.
    // Match the raw subject too — nameFromSubject() turns
    // "…@TSRG.mkv.vol31+17.par2" into "@TSRG.mkv", which hides the extension.
    const isRecovery = (i: number) => {
      const f = this.files[i];
      const hay = `${f.file.subject ?? ""} ${f.resolvedName ?? ""}`;
      return /\.(par2|srr|md5)(?:[\s"'\]]|$)/i.test(hay);
    };
    const bytesOf = (i: number) => this.files[i].file.segments.reduce((a, s) => a + (s.bytes ?? 0), 0);

    const initAll = async (idxs: number[]) => {
      let next = 0;
      const conc = Math.max(1, Math.min(this.providerCfg.connections, 16));
      await Promise.all(
        Array.from({ length: conc }, async () => {
          while (next < idxs.length) {
            const i = idxs[next++];
            try {
              await this.files[i].init();
              readable.add(i);
            } catch (e) {
              failed.add(i);
              this.diag.error("analyze", `file#${i} "${this.files[i].resolvedName}" unreadable: ${(e as Error).message}`);
            }
          }
        }),
      );
    };

    const all = this.files.map((_, i) => i);
    const media = all.filter((i) => !isRecovery(i));
    const recovery = all.filter(isRecovery);
    // biggest first: that's the episode, and it's what the user is waiting for
    media.sort((a, b) => bytesOf(b) - bytesOf(a));
    await initAll(media);
    const obfuscated = media.filter((i) => readable.has(i) && looksRandom(this.files[i].yencName ?? this.files[i].resolvedName ?? ""));
    this.diag.info("analyze", `probed ${media.length} media file(s), ${recovery.length} recovery volume(s) deferred${obfuscated.length ? ` — names look obfuscated (${obfuscated.map((i) => this.files[i].resolvedName).slice(0, 2).join(", ")})` : ""}`);
    if (!readable.size || obfuscated.length) {
      // Nothing playable, or obfuscated names that PAR2 can resolve.
      //
      // Smallest volume first: the .par2 index is a few KB while the recovery
      // volumes are tens of MB, and the index alone is enough to recover the
      // real file names. Stop at the first volume that parses.
      recovery.sort((a, b) => bytesOf(a) - bytesOf(b));
      for (const i of recovery) {
        try {
          await this.files[i].init();
          readable.add(i);
        } catch (e) {
          failed.add(i);
          this.diag.error("analyze", `file#${i} "${this.files[i].resolvedName}" unreadable: ${(e as Error).message}`);
          continue;
        }
        if (!/\.par2$/i.test(`${this.files[i].yencName ?? ""} ${this.files[i].resolvedName ?? ""} ${this.files[i].file.subject ?? ""}`)) continue;
        try {
          this.par2 = await parsePar2(this.files[i], this.diag);
          this.diag.info("analyze", `PAR2 index recovered from file#${i} (${fmtBytesLocal(bytesOf(i))} encoded) — ${this.par2?.files.length ?? 0} protected file(s)`);
          break;
        } catch (e) {
          this.diag.warn("archive", `PAR2 parse of file#${i} failed: ${(e as Error).message}`);
        }
      }
    } else if (recovery.length) {
      this.diag.info("analyze", `skipped ${recovery.length} PAR2/sfv/nfo volume(s) — not needed for names (${this.files.length - recovery.length} file(s) probed)`);
    }
    if (!readable.size) throw new Error(`No file could be read from the provider (${this.diag.stats.lastError ?? "unknown error"})`);
    const skippedCount = all.filter((i) => !readable.has(i) && !failed.has(i)).length;
    if (skippedCount) {
      this.diag.info("analyze", `${skippedCount} recovery volume(s) left un-probed (names did not need PAR2)`);
    }

    // 2. heads + preliminary detection
    const heads = new Map<number, Uint8Array>();
    for (const f of this.files) {
      if (!readable.has(f.file.index)) continue;
      const head = await f.peek(0, 512);
      heads.set(f.file.index, head);
    }

    // 3. PAR2 → real names
    const par2Candidates = this.files.filter((f) => readable.has(f.file.index) && detect(f.yencName ?? f.resolvedName, heads.get(f.file.index) ?? null).ext === "par2");
    if (!this.par2 && par2Candidates.length) {
      const smallest = par2Candidates.reduce((a, b) => (a.size <= b.size ? a : b));
      try {
        this.par2 = await parsePar2(smallest, this.diag);
      } catch (e) {
        this.diag.warn("archive", `PAR2 parse failed: ${(e as Error).message}`);
      }
    }
    const score = (n: string | null | undefined) => {
      if (!n) return -1;
      let s = 0;
      if (/\.[a-z0-9]{2,5}$/i.test(n)) s += 2;
      if (!looksRandom(n)) s += 1;
      if (detect(n, null).kind !== "other") s += 1;
      return s;
    };
    for (const f of this.files) {
      let parName: string | undefined;
      if (this.par2 && readable.has(f.file.index)) {
        const bySize = this.par2.files.filter((p) => p.size === f.size);
        if (bySize.length === 1) parName = bySize[0].name;
        else if (bySize.length > 1) {
          // several candidates with the same size: PAR2 stores the MD5 of the first 16KB
          const first = await f.peek(0, 16384);
          const h = await md5hex(first);
          parName = h ? bySize.find((p) => p.md5_16k === h)?.name : undefined;
          if (parName) this.diag.debug("analyze", `file#${f.file.index} matched PAR2 entry "${parName}" by md5-16k`);
        }
      }
      const candidates = [parName, f.yencName, f.file.subjectName].filter(Boolean) as string[];
      let best = candidates[0] ?? f.resolvedName;
      let bestScore = -2;
      for (const c of candidates) {
        const s = score(c);
        if (s > bestScore) {
          best = c;
          bestScore = s;
        }
      }
      if (best !== f.resolvedName) this.diag.debug("analyze", `file#${f.file.index} name "${f.file.subjectName}" → "${best}" (${parName === best ? "par2" : f.yencName === best ? "yenc" : "subject"})`);
      f.resolvedName = best.replace(/^.*[\\/]/, "");
    }

    // 4. classify
    const items: MediaItem[] = [];
    const rarGroups = new Map<string, Array<{ file: NzbVirtualFile; index: number }>>();
    const zipFiles: NzbVirtualFile[] = [];
    for (const f of this.files) {
      if (!readable.has(f.file.index)) continue;
      const d = detect(f.resolvedName, heads.get(f.file.index) ?? null);
      if (d.ext === "rar") {
        const key = rarVolumeKey(f.resolvedName) ?? rarVolumeKey(f.yencName ?? "") ?? rarVolumeKey(f.file.subjectName);
        const base = key ? key.base : `__vol_${f.file.index}`;
        const arr = rarGroups.get(base) ?? [];
        arr.push({ file: f, index: key ? key.index : f.file.index });
        rarGroups.set(base, arr);
        continue;
      }
      if (d.ext === "zip" || d.ext === "cbz") {
        zipFiles.push(f);
        continue;
      }
      items.push({
        id: "",
        name: f.resolvedName,
        size: f.size,
        kind: d.kind,
        ext: d.ext,
        mime: d.mime,
        browserMime: d.browserMime,
        playable: d.playable,
        container: "direct",
        reason: d.playable ? undefined : d.kind === "par2" ? "PAR2 recovery data (parsed for file names; on-the-fly repair not supported)" : d.ext === "7z" ? "7z archives are compressed and cannot be streamed" : `Browser cannot play .${d.ext || "bin"} natively — download or open the stream URL in VLC`,
        src: { type: "direct", file: f.file.index },
      });
    }

    // merge obfuscated singleton rar groups into one set (posted in order)
    const groups = [...rarGroups.entries()];
    const singletons = groups.filter(([, v]) => v.length === 1);
    if (singletons.length > 1 && singletons.length === groups.length) {
      const merged = singletons.flatMap(([, v]) => v).sort((a, b) => a.file.file.index - b.file.file.index);
      rarGroups.clear();
      rarGroups.set("archive", merged.map((m, i) => ({ ...m, index: i })));
      this.diag.info("archive", `merged ${merged.length} unnamed RAR volumes into one set (NZB order)`);
    }

    // 5. RAR sets
    for (const [base, vols] of rarGroups) {
      vols.sort((a, b) => a.index - b.index);
      const volumes = vols.map((v) => v.file);
      const names = volumes.map((v) => v.resolvedName);
      this.diag.info("archive", `parsing RAR set "${base}" with ${volumes.length} volume(s)`, { volumes: names });
      try {
        const info = await parseRarSet(volumes, this.diag, Math.min(Math.max(1, Math.min(this.providerCfg.connections, 16)), 8));
        for (const e of info.entries) {
          const d = detect(e.name, null);
          const mapped = e.chunks.reduce((n, c) => n + c.length, 0);
          const encrypted = e.encrypted || info.encryptedHeaders;
          const needsDecompress = !e.stored && !encrypted;
          const tooBig = needsDecompress && e.size > maxInflateBytes();
          const streamable = !encrypted && !tooBig && (e.stored || needsDecompress);
          items.push({
            id: "",
            name: e.name.replace(/^.*[\\/]/, ""),
            size: e.size,
            kind: d.kind,
            ext: d.ext,
            mime: d.mime,
            browserMime: d.browserMime,
            playable: streamable && d.playable,
            needsDecompress: needsDecompress && !tooBig,
            packedSize: mapped,
            method: e.method,
            container: "rar",
            containerName: `${names[0]} (+${volumes.length - 1} volumes, ${info.format})`,
            crc: e.crc,
            reason: encrypted
              ? "Encrypted RAR — password-protected archives cannot be streamed"
              : tooBig
                ? `RAR entry is ${e.method} and unpacks to ${(e.size / 1024 / 1024).toFixed(0)} MB — raise MAX_INFLATE_MB (default 512) or use a stored (m0) release`
                : needsDecompress
                  ? d.playable
                    ? `Compressed RAR (${e.method}) — inflated on the fly via 7-Zip WASM`
                    : `Browser cannot play .${d.ext} natively — download or open the stream URL in VLC`
                  : mapped < e.size
                    ? `Only ${Math.round((mapped / e.size) * 100)}% mapped — missing volumes; playback will stop early`
                    : d.playable
                      ? undefined
                      : `Browser cannot play .${d.ext} natively — download or open the stream URL in VLC`,
            src: { type: "chunks", files: volumes.map((v) => v.file.index), chunks: e.chunks },
          });
        }

        if (!info.entries.length) {
          items.push({
            id: "", name: names[0], size: volumes.reduce((n, v) => n + v.size, 0), kind: "archive", ext: "rar", mime: "application/vnd.rar", browserMime: "application/vnd.rar",
            playable: false, container: "direct", reason: info.encryptedHeaders ? "RAR headers are encrypted (password required)" : `No file headers found (${info.warnings.join("; ") || "corrupt?"})`,
            src: { type: "direct", file: volumes[0].file.index },
          });
        }
      } catch (e) {
        this.diag.error("archive", `RAR set "${base}" failed: ${(e as Error).message}`);
      }
    }

    // 6. ZIPs
    for (const z of zipFiles) {
      try {
        const info = await parseZip(z, this.diag);
        for (const e of info.entries) {
          const d = detect(e.name, null);
          const needsDecompress = !e.stored && !e.encrypted;
          const tooBig = needsDecompress && e.size > maxInflateBytes();
          const streamable = !e.encrypted && !tooBig && (e.stored || needsDecompress);
          items.push({
            id: "",
            name: e.name.replace(/^.*[\\/]/, ""),
            size: e.size,
            kind: d.kind,
            ext: d.ext,
            mime: d.mime,
            browserMime: d.browserMime,
            playable: streamable && d.playable,
            needsDecompress: needsDecompress && !tooBig,
            packedSize: e.packedSize,
            method: e.method,
            container: "zip",
            containerName: z.resolvedName,
            crc: e.crc,
            reason: e.encrypted
              ? "Encrypted ZIP entry"
              : tooBig
                ? `ZIP entry is ${e.method} and unpacks to ${(e.size / 1024 / 1024).toFixed(0)} MB — raise MAX_INFLATE_MB`
                : needsDecompress
                  ? d.playable
                    ? `Compressed ZIP (${e.method}) — inflated on the fly`
                    : `Browser cannot play .${d.ext} natively`
                  : d.playable
                    ? undefined
                    : `Browser cannot play .${d.ext} natively`,
            src: { type: "chunks", files: [z.file.index], chunks: e.chunks },
          });
        }
      } catch (e) {
        this.diag.error("archive", `ZIP ${z.resolvedName} failed: ${(e as Error).message}`);
      }
    }

    // 7. order: video > audio > image > subtitle > text > pdf > rest; bigger first
    const rank: Record<MediaKind, number> = { video: 0, audio: 1, image: 2, subtitle: 3, text: 4, pdf: 5, other: 6, archive: 7, par2: 8 };
    items.sort((a, b) => rank[a.kind] - rank[b.kind] || b.size - a.size);
    items.forEach((it, i) => (it.id = `i${i}`));

    // 8. container/codec probe on the media we are actually going to play, so the
    //    UI can warn about things the browser cannot decode (silent AC3/DTS…)
    const probeTargets = items.filter((i) => (i.kind === "video" || i.kind === "audio") && i.playable && !i.needsDecompress).slice(0, 3);
    for (const it of probeTargets) {
      try {
        const info = await probeCodecs(this.reader(it), it.size);
        if (!info) continue;
        it.codecs = info;
        this.diag.info("analyze", `codecs for "${it.name}": container=${info.container} video=[${info.video.join(",")}] audio=[${info.audio.join(",")}] browserVideo=${info.browserVideo} browserAudio=${info.browserAudio}${info.moovAtEnd ? " (moov at end)" : ""}`, {
          item: it.id,
          ...info,
        });
        for (const n of info.notes) this.diag.warn("analyze", `${it.name}: ${n}`);
      } catch (e) {
        this.diag.warn("analyze", `codec probe failed for "${it.name}": ${(e as Error).message}`);
      }
    }
    this.diag.info("analyze", `analysis done in ${Date.now() - t0}ms: ${items.length} item(s), ${items.filter((i) => i.playable).length} playable`, {
      items: items.map((i) => ({ id: i.id, name: i.name, size: i.size, kind: i.kind, playable: i.playable, container: i.container })),
    });
    return items;
  }

  getItem(id: string): MediaItem | undefined {
    return this.items?.find((i) => i.id === id);
  }

  reader(item: MediaItem): RandomReader {
    let r = this.readers.get(item.id);
    if (r) return r;
    if (item.src.type === "direct") r = this.files[item.src.file];
    else {
      const vols = item.src.files.map((i) => this.files[i]);
      const packedSize = item.packedSize ?? item.src.chunks.reduce((n, c) => n + c.length, 0);
      const packed = new ChunkedReader(item.name, item.needsDecompress ? packedSize : item.size, vols, item.src.chunks);
      const compressed = item.needsDecompress || (!!item.method && item.method !== "store" && !/^store$/i.test(item.method));
      if (compressed) {
        r = new InflatingReader(item.name, item.size, packed, {
          method: item.method ?? "compressed",
          format: item.container === "zip" ? "zip" : item.containerName?.includes("rar5") ? "rar5" : "rar4",
          volumes: vols,
          entryName: item.name,
          packedSize,
          diag: this.diag,
        });
      } else r = packed;
    }
    this.readers.set(item.id, r);
    return r;
  }

  async close() {
    this.diag.info("session", "closing session");
    await this.pool.close();
    segmentCache.clearPrefix(`${this.id}:`);
  }
}

/** Re-enable playback on items analysed before compressed inflate existed. */
function hydrateCompressed(it: MediaItem): MediaItem {
  const m = /compressed\(([^)]+)\)/.exec(it.reason ?? "") || /Compressed (?:RAR|ZIP) \(([^)]+)\)/.exec(it.reason ?? "");
  if (!it.needsDecompress && m && it.src.type === "chunks") {
    const tooBig = it.size > maxInflateBytes();
    it.method ||= m[0].startsWith("compressed") ? m[0] : `compressed(${m[1]})`;
    it.needsDecompress = !tooBig;
    it.playable = !tooBig && (it.kind === "video" || it.kind === "audio" || it.kind === "image" || it.kind === "pdf");
    it.reason = tooBig
      ? `${it.method} unpacks to ${(it.size / 1024 / 1024).toFixed(0)} MB — raise MAX_INFLATE_MB`
      : it.playable
        ? `Compressed ${it.container} (${it.method}) — inflated on the fly`
        : it.reason;
  }
  return it;
}

async function md5hex(data: Uint8Array): Promise<string | null> {
  try {
    const { createHash } = await import("node:crypto");
    return createHash("md5").update(data).digest("hex");
  } catch {
    return null; // runtime without node:crypto — fall back to size matching only
  }
}

/** Reader over a list of chunks spanning multiple volumes (RAR/ZIP stored data). */
class ChunkedReader implements RandomReader {
  private offsets: number[] = [];
  constructor(
    readonly name: string,
    readonly size: number,
    private readonly volumes: RandomReader[],
    private readonly chunks: ArchiveChunk[],
  ) {
    let o = 0;
    for (const c of chunks) {
      this.offsets.push(o);
      o += c.length;
    }
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const p of this.stream(offset, offset + length - 1)) {
      parts.push(p);
      n += p.length;
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  async *stream(start: number, end: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    end = Math.min(end, this.size - 1);
    for (let i = 0; i < this.chunks.length && start <= end; i++) {
      const c = this.chunks[i];
      const cStart = this.offsets[i];
      const cEnd = cStart + c.length - 1;
      if (cEnd < start) continue;
      if (cStart > end) break;
      const from = Math.max(start, cStart) - cStart;
      const to = Math.min(end, cEnd) - cStart;
      const vol = this.volumes[c.volume];
      if (!vol) throw new Error(`missing volume ${c.volume}`);
      for await (const p of vol.stream(c.offset + from, c.offset + to, signal)) {
        yield p;
        if (signal?.aborted) return;
      }
      start = cEnd + 1;
    }
  }
}

/* ------------------------------ registry --------------------------------- */

const g = globalThis as typeof globalThis & { __nzbSessions?: Map<string, StreamSession>; __nzbLoading?: Map<string, Promise<StreamSession | null>> };
const registry = (g.__nzbSessions ??= new Map());
const loading = (g.__nzbLoading ??= new Map());

export function providerToConfig(p: Provider): NntpConfig & { id: number | null; name: string } {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    ssl: p.ssl,
    username: p.username,
    password: p.password,
    connections: Math.max(1, Math.min(50, p.connections)),
    timeoutMs: Number(process.env.NNTP_TIMEOUT_MS ?? "30000"),
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of registry) {
    if (now - s.lastAccess > 30 * 60 * 1000 && s.diag.stats.activeStreams === 0) {
      registry.delete(id);
      void s.close();
    }
  }
}

export async function getSession(id: string): Promise<StreamSession | null> {
  sweep();
  const s = registry.get(id);
  if (s) {
    s.touch();
    return s;
  }
  if (loading.has(id)) return loading.get(id)!;
  const p = (async () => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!row) return null;
    let prov: Provider | undefined;
    if (row.providerId != null) [prov] = await db.select().from(providers).where(eq(providers.id, row.providerId)).limit(1);
    if (!prov) [prov] = await db.select().from(providers).limit(1);
    if (!prov) throw new Error("No NNTP provider configured");
    const nzb = parseNzb(row.nzbXml);
    let items: MediaItem[] | null = null;
    if (row.itemsJson) {
      try {
        items = JSON.parse(row.itemsJson) as MediaItem[];
      } catch {
        items = null;
      }
    }
    const sess = new StreamSession(row.id, row.title, nzb, providerToConfig(prov), row.createdAt.getTime(), items);
    registry.set(id, sess);
    return sess;
  })().finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

export async function dropSession(id: string) {
  const s = registry.get(id);
  registry.delete(id);
  if (s) await s.close();
}

export function registerSession(s: StreamSession) {
  registry.set(s.id, s);
}
