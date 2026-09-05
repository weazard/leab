/**
 * NzbVirtualFile — random access over a file that lives as yEnc'd segments on
 * usenet. This is what makes "streaming" possible: HTTP range requests map to
 * segment fetches, which are decoded, CRC-checked, cached and served.
 *
 * Offset layout: yEnc parts declare their absolute byte range (=ypart
 * begin/end). We learn the part size from the first segment, *guess* which
 * segment holds a given offset, and verify against the decoded header —
 * correcting the guess if the poster used irregular part sizes.
 */
import { decodeYenc } from "./yenc";
import type { NzbFile } from "./nzb";
import type { NntpPool } from "./nntp";
import type { Diag } from "./diag";
import { segmentCache, type CachedSegment } from "./cache";

export interface RandomReader {
  readonly name: string;
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Sequential stream of [start, end] inclusive. */
  stream(start: number, end: number, signal?: AbortSignal): AsyncGenerator<Uint8Array>;
}

export type SegState = 0 | 1 | 2 | 3; // none | inflight | ok | error

export class NzbVirtualFile implements RandomReader {
  private _size = 0;
  private partSize = 0;
  private initPromise: Promise<void> | null = null;
  private inflight = new Map<number, Promise<CachedSegment>>();
  /** learned [begin,end] per segment index */
  private ranges = new Map<number, { begin: number; end: number }>();
  readonly states: Uint8Array;
  yencName: string | null = null;
  /** name resolved from par2 / yenc / subject; set by analyzer */
  resolvedName: string;
  initialized = false;
  encoding: string = "?";

  constructor(
    readonly sessionId: string,
    readonly file: NzbFile,
    private readonly pool: NntpPool,
    private readonly diag: Diag,
  ) {
    this.states = new Uint8Array(file.segments.length);
    this.resolvedName = file.subjectName;
    // rough estimate until we decode the first segment (yEnc overhead ~2-3%)
    this._size = Math.floor(file.encodedBytes / 1.03);
  }

  get name() {
    return this.resolvedName;
  }
  get size() {
    return this._size;
  }
  get segmentCount() {
    return this.file.segments.length;
  }
  get estimatedPartSize() {
    return this.partSize;
  }

  /** Fetch + decode the first segment to learn the true size and part size. */
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const seg = await this.segment(0);
        if (seg.fileSize && seg.fileSize > 0) this._size = seg.fileSize;
        else if (this.file.segments.length === 1) this._size = seg.data.length;
        this.partSize = Math.max(1, seg.data.length);
        this.initialized = true;
        this.diag.info("segment", `file#${this.file.index} layout: size=${this._size} partSize=${this.partSize} segments=${this.segmentCount} name="${this.yencName ?? this.resolvedName}"`, {
          file: this.file.index,
          size: this._size,
          partSize: this.partSize,
          segments: this.segmentCount,
          yencName: this.yencName,
          encoding: this.encoding,
        });
      })().catch((e) => {
        this.initPromise = null;
        throw e;
      });
    }
    return this.initPromise;
  }

  private cacheKey(i: number) {
    return `${this.sessionId}:${this.file.index}:${i}`;
  }

  /** Fetch (or get cached) segment i, decoded. Never rejects for missing articles: returns zero-filled data flagged with error. */
  segment(i: number): Promise<CachedSegment> {
    const key = this.cacheKey(i);
    const cached = segmentCache.get(key);
    if (cached) {
      this.diag.stats.cacheHits++;
      return Promise.resolve(cached);
    }
    const running = this.inflight.get(i);
    if (running) return running;
    this.diag.stats.cacheMisses++;
    const p = this.fetchSegment(i)
      .then((seg) => {
        segmentCache.set(key, seg);
        this.diag.stats.cacheBytes = segmentCache.bytes;
        return seg;
      })
      .finally(() => this.inflight.delete(i));
    this.inflight.set(i, p);
    return p;
  }

  private async fetchSegment(i: number): Promise<CachedSegment> {
    const s = this.file.segments[i];
    this.states[i] = 1;
    const label = `file#${this.file.index} seg ${i + 1}/${this.segmentCount}`;
    try {
      const r = await this.pool.fetchBody(s.messageId, { groups: this.file.groups, label });
      const y = decodeYenc(r.raw);
      this.encoding = y.encoding;
      if (y.header.name && !this.yencName) this.yencName = y.header.name;
      this.diag.stats.bytesDownloaded += r.wireBytes;
      this.diag.stats.bytesDecoded += y.data.length;
      let begin = y.begin;
      let end = y.end;
      if (y.encoding !== "yenc" || y.header.begin == null) {
        // no part header: infer position
        begin = this.partSize ? i * this.partSize : 0;
        end = begin + y.data.length - 1;
      }
      this.ranges.set(i, { begin, end });
      const crcBad = y.crcOk === false;
      const sizeBad = y.sizeOk === false || y.data.length !== end - begin + 1;
      if (crcBad) this.diag.stats.crcErrors++;
      this.states[i] = crcBad ? 3 : 2;
      this.diag.stats.segmentsOk++;
      const lvl = crcBad || sizeBad ? "warn" : "debug";
      this.diag.log(lvl, "segment", `${label} ok ${y.data.length}B in ${r.ms}ms via conn#${r.connId}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}${crcBad ? ` CRC MISMATCH declared=${y.declaredCrc} actual=${y.actualCrc}` : ""}${sizeBad ? " SIZE MISMATCH" : ""}`, {
        file: this.file.index,
        seg: i,
        messageId: s.messageId,
        wireBytes: r.wireBytes,
        decoded: y.data.length,
        begin,
        end,
        ms: r.ms,
        conn: r.connId,
        attempt: r.attempt,
        crc: y.actualCrc,
        declaredCrc: y.declaredCrc,
        crcOk: y.crcOk,
        encoding: y.encoding,
      });
      return { data: y.data, begin, end, fileSize: y.fileSize, ok: !crcBad, error: crcBad ? "crc" : undefined };
    } catch (e) {
      this.states[i] = 3;
      this.diag.stats.segmentsFailed++;
      const msg = (e as Error).message;
      this.diag.error("segment", `${label} FAILED: ${msg} <${s.messageId}>`, {
        file: this.file.index,
        seg: i,
        messageId: s.messageId,
        error: msg,
      });
      // Zero-fill so playback can continue past the hole (like a scratched disc).
      const begin = this.partSize ? i * this.partSize : 0;
      const len = this.partSize
        ? Math.max(0, Math.min(this.partSize, this._size - begin))
        : Math.floor(s.bytes / 1.03);
      if (i === 0 && !this.initialized) throw e; // can't even establish layout
      const seg: CachedSegment = { data: new Uint8Array(len), begin, end: begin + len - 1, fileSize: null, ok: false, error: msg };
      this.ranges.set(i, { begin: seg.begin, end: seg.end });
      return seg;
    }
  }

  /** Find the segment index containing `offset` — guess by part size, verify with decoded headers. */
  private async locate(offset: number): Promise<{ index: number; seg: CachedSegment }> {
    await this.init();
    const n = this.segmentCount;
    let i = Math.min(n - 1, Math.max(0, Math.floor(offset / this.partSize)));
    for (let hops = 0; hops < n + 2; hops++) {
      const seg = await this.segment(i);
      if (offset >= seg.begin && offset <= seg.end) return { index: i, seg };
      if (offset < seg.begin) {
        if (i === 0) return { index: i, seg };
        i--;
      } else {
        if (i === n - 1) return { index: i, seg };
        i++;
      }
      this.diag.debug("segment", `file#${this.file.index} offset ${offset} not in seg ${i} [${seg.begin}-${seg.end}], hopping`);
    }
    throw new Error(`Could not locate offset ${offset} in file#${this.file.index}`);
  }

  prefetch(fromIndex: number, count: number) {
    for (let k = fromIndex; k < Math.min(this.segmentCount, fromIndex + count); k++) {
      if (this.states[k] === 0 || (this.states[k] === 3 && !segmentCache.has(this.cacheKey(k)))) {
        void this.segment(k).catch(() => {});
      }
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const out: Uint8Array[] = [];
    let got = 0;
    for await (const chunk of this.stream(offset, offset + length - 1)) {
      out.push(chunk);
      got += chunk.length;
    }
    const res = new Uint8Array(got);
    let o = 0;
    for (const c of out) {
      res.set(c, o);
      o += c.length;
    }
    return res;
  }

  async *stream(start: number, end: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    await this.init();
    end = Math.min(end, this._size - 1);
    if (start > end) return;
    const prefetchDepth = Math.max(2, Math.min(this.pool.cfg.connections, 12));
    let { index, seg } = await this.locate(start);
    let pos = start;
    while (pos <= end) {
      if (signal?.aborted) return;
      this.prefetch(index + 1, prefetchDepth);
      if (pos < seg.begin) {
        // gap (missing/irregular part) — zero-fill to keep the stream aligned
        const gap = Math.min(seg.begin - pos, end - pos + 1);
        this.diag.warn("segment", `file#${this.file.index} gap ${gap}B before seg ${index} — zero filling`);
        yield new Uint8Array(gap);
        pos += gap;
        continue;
      }
      const from = pos - seg.begin;
      const to = Math.min(seg.data.length, end - seg.begin + 1);
      if (to > from) {
        const slice = seg.data.subarray(from, to);
        pos += slice.length;
        yield slice;
      }
      if (pos > end) break;
      index++;
      if (index >= this.segmentCount) {
        if (pos <= end) {
          this.diag.warn("segment", `file#${this.file.index} ran out of segments at ${pos}, expected ${end + 1}; zero filling`);
          yield new Uint8Array(end - pos + 1);
        }
        return;
      }
      seg = await this.segment(index);
      if (seg.end < pos) {
        // decoded segment lies entirely before pos (overlap) — advance past it
        continue;
      }
    }
  }

  /** compact map for diagnostics UI */
  stateString(): string {
    let s = "";
    for (let i = 0; i < this.states.length; i++) s += this.states[i];
    return s;
  }
}
