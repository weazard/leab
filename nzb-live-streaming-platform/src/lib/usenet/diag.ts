/**
 * Per-session diagnostics: a ring buffer of structured events plus live
 * subscribers (SSE). Everything the engine does — connection lifecycle,
 * every segment fetch, CRC results, retries, range requests, archive parsing —
 * is reported here so the UI can show exactly what is happening.
 */

export type DiagLevel = "debug" | "info" | "warn" | "error";
export type DiagCategory =
  | "session"
  | "nntp"
  | "segment"
  | "range"
  | "archive"
  | "cache"
  | "analyze"
  | "indexer";

export interface DiagEvent {
  seq: number;
  t: number; // epoch ms
  level: DiagLevel;
  cat: DiagCategory;
  msg: string;
  data?: Record<string, unknown>;
}

export interface DiagStats {
  connectionsOpen: number;
  connectionsBusy: number;
  connectionsOpenedTotal: number;
  segmentsOk: number;
  segmentsFailed: number;
  segmentsRetried: number;
  crcErrors: number;
  bytesDownloaded: number; // raw encoded bytes off the wire
  bytesDecoded: number;
  bytesServed: number;
  cacheHits: number;
  cacheMisses: number;
  cacheBytes: number;
  activeStreams: number;
  startedAt: number;
  lastActivity: number;
  lastError?: string;
}

export class Diag {
  private events: DiagEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: DiagEvent) => void>();
  readonly stats: DiagStats = {
    connectionsOpen: 0,
    connectionsBusy: 0,
    connectionsOpenedTotal: 0,
    segmentsOk: 0,
    segmentsFailed: 0,
    segmentsRetried: 0,
    crcErrors: 0,
    bytesDownloaded: 0,
    bytesDecoded: 0,
    bytesServed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBytes: 0,
    activeStreams: 0,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };

  constructor(private readonly capacity = 3000) {}

  log(level: DiagLevel, cat: DiagCategory, msg: string, data?: Record<string, unknown>): DiagEvent {
    const e: DiagEvent = { seq: ++this.seq, t: Date.now(), level, cat, msg, data };
    this.events.push(e);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.stats.lastActivity = e.t;
    if (level === "error") this.stats.lastError = msg;
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* ignore */
      }
    }
    return e;
  }
  debug(cat: DiagCategory, msg: string, data?: Record<string, unknown>) {
    return this.log("debug", cat, msg, data);
  }
  info(cat: DiagCategory, msg: string, data?: Record<string, unknown>) {
    return this.log("info", cat, msg, data);
  }
  warn(cat: DiagCategory, msg: string, data?: Record<string, unknown>) {
    return this.log("warn", cat, msg, data);
  }
  error(cat: DiagCategory, msg: string, data?: Record<string, unknown>) {
    return this.log("error", cat, msg, data);
  }

  since(seq: number, limit = 500): DiagEvent[] {
    const out: DiagEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.events[i].seq <= seq) break;
      out.push(this.events[i]);
    }
    return out.reverse();
  }

  get lastSeq() {
    return this.seq;
  }

  subscribe(fn: (e: DiagEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** A no-op diag used when no session context is available. */
export const nullDiag = new Diag(1);
