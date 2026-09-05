/**
 * Process-wide LRU byte cache for decoded segments. On serverless each
 * instance gets its own cache (ephemeral, which is fine — it's a stream
 * buffer, not a download).
 */
export interface CachedSegment {
  data: Uint8Array;
  begin: number;
  end: number;
  fileSize: number | null;
  ok: boolean;
  error?: string;
}

class SegmentCache {
  private map = new Map<string, CachedSegment>();
  bytes = 0;
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): CachedSegment | undefined {
    const v = this.map.get(key);
    if (v) {
      // refresh LRU position
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  has(key: string) {
    return this.map.has(key);
  }
  set(key: string, v: CachedSegment) {
    if (this.map.has(key)) this.bytes -= this.map.get(key)!.data.length;
    this.map.set(key, v);
    this.bytes += v.data.length;
    this.evict();
  }
  private evict() {
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      const v = this.map.get(first)!;
      this.map.delete(first);
      this.bytes -= v.data.length;
    }
  }
  clearPrefix(prefix: string) {
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.bytes -= v.data.length;
      }
    }
  }
  get size() {
    return this.map.size;
  }
}

const g = globalThis as typeof globalThis & { __nzbSegmentCache?: SegmentCache };
const maxMb = Number(process.env.SEGMENT_CACHE_MB ?? "256");
export const segmentCache = (g.__nzbSegmentCache ??= new SegmentCache(Math.max(16, maxMb) * 1024 * 1024));
