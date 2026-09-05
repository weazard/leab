/**
 * NzbVirtualFile — random access over a file that lives as yEnc'd segments on
 * usenet. This is what makes "streaming" possible: HTTP range requests map to
 * segment fetches, which are decoded, CRC-checked, cached and served.
 *
 * Offset layout: yEnc parts declare their absolute byte range (=ypart
 * begin/end). We learn the part size from the first segment, *guess* which
 * segment holds a given offset, and verify against the decoded header —
 * correcting the guess if the poster used irregular part sizes.
 *
 * Segments are decoded **progressively**: bytes are handed to the HTTP
 * response as the article trickles off the socket, so time-to-first-byte is a
 * round trip instead of "however long a 300 KB…50 MB part takes". The decoded
 * part is still cached, so a later seek to the same area is instant.
 */
import { decodeYenc, YencStreamDecoder, type YencStreamMeta } from "./yenc";
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

/** bytes of every part kept so a late consumer (analyser) can still read the head */
const HEAD_CAP = 64 * 1024;

interface LiveHandle {
  index: number;
  /** resolves as soon as the yEnc header of the part has been parsed */
  meta: Promise<YencStreamMeta | null>;
  /** resolves once the whole part is decoded (always resolves, never rejects) */
  done: Promise<CachedSegment>;
  /** decoded pieces in order — a consumer joining late replays these */
  pieces: Uint8Array[];
  head: Uint8Array;
  headLen: number;
  /** decoded bytes already handed out — a consumer joining later can't use them */
  emitted: number;
  /**
   * Bumped whenever the fetch restarts: consumers that replayed pieces from an
   * earlier attempt would read the wrong offsets, so they bail out and read
   * the completed part instead.
   */
  gen: number;
  settled: boolean;
  waiters: Array<() => void>;
}

export class NzbVirtualFile implements RandomReader {
  private _size = 0;
  private partSize = 0;
  private initPromise: Promise<void> | null = null;
  private inflight = new Map<number, Promise<CachedSegment>>();
  /** progressive fetches in flight, keyed by segment index */
  private lives = new Map<number, LiveHandle>();
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

  /** Learn the true size and part size. Resolves as soon as the yEnc header
   *  arrives (one round trip) — the rest of segment 0 keeps loading in the
   *  background and lands in the cache. */
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = (async () => {
        let seg: CachedSegment;
        const live = this.ensureLive(0);
        if (live) {
          const meta = await live.meta.catch(() => null);
          if (meta && meta.fileSize && meta.partSize) {
            this._size = meta.fileSize;
            this.partSize = meta.partSize;
            this.encoding = meta.encoding;
            if (meta.header.name && !this.yencName) this.yencName = meta.header.name;
            this.initialized = true;
            this.logLayout();
            return;
          }
          seg = await live.done;
        } else {
          seg = await this.segment(0);
        }
        if (seg.fileSize && seg.fileSize > 0) this._size = seg.fileSize;
        else if (this.file.segments.length === 1) this._size = seg.data.length;
        this.partSize = Math.max(1, seg.data.length);
        this.initialized = true;
        this.logLayout();
      })().catch((e) => {
        this.initPromise = null;
        throw e;
      });
    }
    return this.initPromise;
  }

  private logLayout() {
    this.diag.info("segment", `file#${this.file.index} layout: size=${this._size} partSize=${this.partSize} segments=${this.segmentCount} name="${this.yencName ?? this.resolvedName}"`, {
      file: this.file.index,
      size: this._size,
      partSize: this.partSize,
      segments: this.segmentCount,
      yencName: this.yencName,
      encoding: this.encoding,
    });
  }

  private cacheKey(i: number) {
    return `${this.sessionId}:${this.file.index}:${i}`;
  }

  /** Fetch (or get cached) segment i, decoded. Never rejects for missing articles: returns zero-filled data flagged with error. */
  /** @param prio 1 = actively streaming to a client, -1 = speculative prefetch */
  segment(i: number, prio = 0): Promise<CachedSegment> {
    const key = this.cacheKey(i);
    const cached = segmentCache.get(key);
    if (cached) {
      this.diag.stats.cacheHits++;
      return Promise.resolve(cached);
    }
    const running = this.inflight.get(i);
    if (running) return running;
    this.diag.stats.cacheMisses++;
    const p = this.fetchSegment(i, prio)
      .then((seg) => {
        segmentCache.set(key, seg);
        this.diag.stats.cacheBytes = segmentCache.bytes;
        return seg;
      })
      .finally(() => this.inflight.delete(i));
    this.inflight.set(i, p);
    return p;
  }

  private async fetchSegment(i: number, prio = 0): Promise<CachedSegment> {
    const s = this.file.segments[i];
    this.states[i] = 1;
    const label = `file#${this.file.index} seg ${i + 1}/${this.segmentCount}`;
    try {
      const r = await this.pool.fetchBody(s.messageId, { groups: this.file.groups, label, priority: prio });
      const y = decodeYenc(r.raw);
      this.diag.stats.bytesDownloaded += r.wireBytes;
      this.diag.stats.bytesDecoded += y.data.length;
      const { seg, begin, end } = this.buildSegment(i, y, y.data);
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
      return { ...seg, ok: !crcBad, error: crcBad ? "crc" : undefined };
    } catch (e) {
      return this.zeroFill(i, e as Error);
    }
  }

  /** Shared offset bookkeeping for a decoded part. */
  private buildSegment(i: number, y: { encoding: string; header: { begin?: number; end?: number }; fileSize: number | null; data?: Uint8Array }, data: Uint8Array) {
    let begin = (y as { begin?: number }).begin ?? 0;
    let end = (y as { end?: number }).end ?? 0;
    if (y.encoding !== "yenc" || y.header.begin == null) {
      begin = this.partSize ? i * this.partSize : 0;
      end = begin + data.length - 1;
    }
    return { seg: { data, begin, end, fileSize: y.fileSize } as CachedSegment, begin, end };
  }

  private zeroFill(i: number, e: Error): CachedSegment {
    const s = this.file.segments[i];
    this.states[i] = 3;
    this.diag.stats.segmentsFailed++;
    const msg = e.message;
    this.diag.error("segment", `file#${this.file.index} seg ${i + 1}/${this.segmentCount} FAILED: ${msg} <${s.messageId}>`, {
      file: this.file.index,
      seg: i,
      messageId: s.messageId,
      error: msg,
    });
    // Zero-fill so playback can continue past the hole (like a scratched disc).
    const begin = this.partSize ? i * this.partSize : 0;
    const len = this.partSize ? Math.max(0, Math.min(this.partSize, this._size - begin)) : Math.floor(s.bytes / 1.03);
    if (i === 0 && !this.initialized) throw e; // can't even establish layout
    const seg: CachedSegment = { data: new Uint8Array(len), begin, end: begin + len - 1, fileSize: null, ok: false, error: msg };
    this.ranges.set(i, { begin: seg.begin, end: seg.end });
    return seg;
  }



  /* --------------------------- progressive fetch --------------------------- */

  /**
   * Get (or start) the progressive fetch of segment `i`. Every consumer of a
   * part shares one NNTP fetch: the analyser only needs the head, a stream
   * needs the whole body, and both must not trigger a second download.
   */
  private ensureLive(i: number, prio = 0): LiveHandle | null {
    if (i < 0 || i >= this.segmentCount) return null;
    if (segmentCache.has(this.cacheKey(i))) {
      this.diag.stats.cacheHits++;
      return null;
    }
    const existing = this.lives.get(i);
    if (existing) return existing;
    // a batch fetch (prefetch / random read) is already downloading this part
    if (this.inflight.has(i)) return null;
    this.diag.stats.cacheMisses++;

    let resolveMeta: (m: YencStreamMeta | null) => void = () => {};
    const meta = new Promise<YencStreamMeta | null>((r) => (resolveMeta = r));
    const h: LiveHandle = {
      index: i,
      meta,
      done: null as unknown as Promise<CachedSegment>,
      pieces: [],
      head: new Uint8Array(HEAD_CAP),
      headLen: 0,
      emitted: 0,
      gen: 0,
      settled: false,
      waiters: [],
    };
    const fetch = this.fetchSegmentStreaming(h, (m) => resolveMeta(m), prio);
    h.done = fetch;
    this.lives.set(i, h);
    this.inflight.set(i, fetch);
    void fetch
      .then((seg) => {
        segmentCache.set(this.cacheKey(i), seg);
        this.diag.stats.cacheBytes = segmentCache.bytes;
      })
      .catch(() => {})
      .finally(() => {
        h.settled = true;
        this.wakeLive(h);
        this.lives.delete(i);
        this.inflight.delete(i);
      });
    return h;
  }

  /**
   * Start (or join) the progressive fetch of segment `i`. Consumers read the
   * handle's `pieces` array: bytes that already arrived are replayed, the rest
   * arrive live. Returns null when the part is already cached.
   */
  private startLive(i: number, prio = 1): LiveHandle | null {
    return this.ensureLive(i, prio);
  }

  private wakeLive(h: LiveHandle) {
    const ws = h.waiters.splice(0);
    for (const w of ws) w();
  }

  /**
   * First `n` decoded bytes of a segment, without waiting for the whole part.
   * Used by the analyser (header sniffing, PAR2 md5-16k) so inspecting a
   * release costs one round trip instead of one whole article.
   */
  async peek(i: number, n: number): Promise<Uint8Array> {
    const cached = segmentCache.get(this.cacheKey(i));
    if (cached) return cached.data.subarray(0, Math.min(n, cached.data.length));
    const h = this.ensureLive(i);
    if (!h) {
      const seg = await this.segment(i);
      return seg.data.subarray(0, Math.min(n, seg.data.length));
    }
    const want = Math.min(n, HEAD_CAP);
    while (h.headLen < want && !h.settled) {
      await new Promise<void>((r) => h.waiters.push(r));
    }
    return h.head.subarray(0, Math.min(want, h.headLen));
  }

  private async fetchSegmentStreaming(h: LiveHandle, onMeta: (m: YencStreamMeta | null) => void, prio = 0): Promise<CachedSegment> {
    const i = h.index;
    const s = this.file.segments[i];
    this.states[i] = 1;
    const label = `file#${this.file.index} seg ${i + 1}/${this.segmentCount}`;
    const dec = new YencStreamDecoder();
    let metaSent = false;
    let wireBytes = 0;
    let ms = 0;
    const publishMeta = () => {
      if (metaSent) return;
      metaSent = true;
      onMeta(dec.meta);
      this.encoding = dec.encoding;
      if (dec.meta?.header.name && !this.yencName) this.yencName = dec.meta.header.name;
    };
    try {
      const gen = this.pool.fetchBodyStream(s.messageId, { groups: this.file.groups, label, priority: prio });
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          const r = step.value as { wireBytes: number; ms: number };
          wireBytes = r?.wireBytes ?? 0;
          ms = r?.ms ?? 0;
          break;
        }
        for (const piece of dec.push(step.value as Uint8Array)) {
          publishMeta();
          this.dispatch(h, piece);
        }
        publishMeta();
      }
    } catch (e) {
      publishMeta();
      const seg = this.zeroFill(i, e as Error);
      h.settled = true;
      this.wakeLive(h);
      return seg;
    }
    publishMeta();

    const y = dec.finish();
    const total = h.emitted;
    const data = new Uint8Array(total);
    let o = 0;
    for (const piece of h.pieces) {
      data.set(piece, o);
      o += piece.length;
    }
    this.diag.stats.bytesDownloaded += wireBytes;
    this.diag.stats.bytesDecoded += data.length;
    const { begin, end } = this.buildSegment(i, y, data);
    this.ranges.set(i, { begin, end });
    const crcBad = y.crcOk === false;
    const sizeBad = y.sizeOk === false || data.length !== end - begin + 1;
    if (crcBad) this.diag.stats.crcErrors++;
    this.states[i] = crcBad ? 3 : 2;
    this.diag.stats.segmentsOk++;
    const lvl = crcBad || sizeBad ? "warn" : "debug";
    this.diag.log(lvl, "segment", `${label} ok ${data.length}B in ${ms}ms (streamed)${crcBad ? ` CRC MISMATCH declared=${y.declaredCrc} actual=${y.actualCrc}` : ""}${sizeBad ? " SIZE MISMATCH" : ""}`, {
      file: this.file.index,
      seg: i,
      messageId: s.messageId,
      wireBytes,
      decoded: data.length,
      begin,
      end,
      ms,
      crc: y.actualCrc,
      declaredCrc: y.declaredCrc,
      crcOk: y.crcOk,
      encoding: y.encoding,
    });
    return { data, begin, end, fileSize: y.fileSize, ok: !crcBad, error: crcBad ? "crc" : undefined };
  }

  /** Append a freshly decoded piece and wake every consumer of this part. */
  private dispatch(h: LiveHandle, piece: Uint8Array) {
    if (h.headLen < HEAD_CAP) {
      const take = Math.min(piece.length, HEAD_CAP - h.headLen);
      h.head.set(piece.subarray(0, take), h.headLen);
      h.headLen += take;
    }
    h.emitted += piece.length;
    h.pieces.push(piece);
    this.wakeLive(h);
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
    // Leave room for interactive reads: a seek must never queue behind the
    // speculative look-ahead of the previous request.
    const maxInflight = Math.max(1, this.pool.cfg.connections - 2);
    for (let k = fromIndex; k < Math.min(this.segmentCount, fromIndex + count); k++) {
      if (this.inflight.size >= maxInflight) return;
      if (this.states[k] === 0 || (this.states[k] === 3 && !segmentCache.has(this.cacheKey(k)))) {
        // start it progressively when nothing else is; `segment()` covers the rest
        if (!this.ensureLive(k, -1)) void this.segment(k, -1).catch(() => {});
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
    const n = this.segmentCount;
    let index = Math.min(n - 1, Math.max(0, Math.floor(start / this.partSize)));
    let pos = start;
    let hops = 0;
    let seg: CachedSegment | null = null;

    while (pos <= end) {
      if (signal?.aborted) return;
      this.prefetch(index + 1, prefetchDepth);

      /* --- fast path: the part is already in the cache --- */
      if (!seg) {
        const cached = segmentCache.get(this.cacheKey(index));
        if (cached) {
          seg = cached;
        }
      }

      /* --- live path: stream the part as it arrives --- */
      if (!seg) {
        const live = this.startLive(index);
        if (live && hops <= n + 2) {
          const meta = await live.meta;
          // verify the guess before committing: hop if this part doesn't hold `pos`
          if (meta && meta.encoding === "yenc" && meta.partSize != null && (pos < meta.begin || pos > meta.end)) {
            index = pos < meta.begin ? Math.max(0, index - 1) : Math.min(n - 1, index + 1);
            hops++;
            continue;
          }
          if (!meta || meta.encoding !== "yenc" || meta.partSize == null) {
            // not progressively decodable (uuencode / no =ypart) → wait for the whole part
            seg = await this.segment(index, 1);
          } else {
            const gen = live.gen;
            let segPos = meta.begin; // file offset of the next decoded byte
            let pieceIdx = 0;
            while (true) {
              if (signal?.aborted) return;
              if (live.gen !== gen) {
                // the fetch restarted under us (transient error / connection
                // lost): the pieces we replayed are gone, read the finished part
                seg = await this.segment(index, 1);
                break;
              }
              if (pieceIdx < live.pieces.length) {
                const piece = live.pieces[pieceIdx++];
                const pieceStart = segPos;
                segPos += piece.length;
                const from = pos > pieceStart ? pos - pieceStart : 0;
                // never emit past the end of the requested range — the piece may
                // straddle it (that used to leak a few bytes into the response
                // and shift everything after a container chunk boundary)
                const to = Math.min(piece.length, end + 1 - pieceStart);
                if (to > from) {
                  const slice = piece.subarray(from, to);
                  pos += slice.length;
                  yield slice;
                  if (pos > end) break;
                }
                continue;
              }
              if (live.settled) break;
              await new Promise<void>((r) => live.waiters.push(r));
            }
            index++;
            seg = null;
            continue;
          }
        } else {
          // already cached, or being fetched without a usable stream → wait for the part
          seg = await this.segment(index, 1);
        }
      }

      if (!seg) {
        seg = await this.segment(index, 1);
      }

      // serve the buffered part
      if (pos < seg.begin) {
        const gap = Math.min(seg.begin - pos, end - pos + 1);
        this.diag.warn("segment", `file#${this.file.index} gap ${gap}B before seg ${index} — zero filling`);
        yield new Uint8Array(gap);
        pos += gap;
        seg = null;
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
      seg = null;
    }
  }

  /** compact map for diagnostics UI */
  stateString(): string {
    let s = "";
    for (let i = 0; i < this.states.length; i++) s += this.states[i];
    return s;
  }
}
