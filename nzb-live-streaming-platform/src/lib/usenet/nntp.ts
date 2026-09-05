/**
 * NNTP client + connection pool.
 *
 * Supports any provider (plain or TLS, optional AUTHINFO USER/PASS), fetches
 * article bodies by Message-ID, unstuffs nothing (the yEnc decoder handles
 * dot-stuffing) and reports every step to the session Diag.
 */
import { openSocket, withTimeout, type RawSocket } from "./socket";
import type { Diag } from "./diag";

export interface NntpConfig {
  host: string;
  port: number;
  ssl: boolean;
  username?: string | null;
  password?: string | null;
  connections: number;
  /** per command timeout */
  timeoutMs?: number;
}

export class NntpError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly permanent = false,
  ) {
    super(message);
    this.name = "NntpError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

let connSeq = 0;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export class NntpConnection {
  readonly id = ++connSeq;
  private sock: RawSocket | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  busy = false;
  lastUsed = Date.now();
  currentGroup: string | null = null;
  fetched = 0;
  greeting = "";

  constructor(
    private readonly cfg: NntpConfig,
    private readonly diag: Diag,
  ) {}

  get alive() {
    return !!this.sock && !this.sock.closed;
  }

  private get timeout() {
    return this.cfg.timeoutMs ?? 30000;
  }

  async connect(): Promise<void> {
    const t0 = Date.now();
    this.diag.debug("nntp", `conn#${this.id} connecting ${this.cfg.host}:${this.cfg.port} tls=${this.cfg.ssl}`);
    try {
      this.sock = await openSocket({ host: this.cfg.host, port: this.cfg.port, tls: this.cfg.ssl });
    } catch (e) {
      this.diag.error("nntp", `conn#${this.id} connect failed: ${(e as Error).message}`, {
        host: this.cfg.host,
        port: this.cfg.port,
      });
      throw e;
    }
    const greet = await this.readResponse();
    this.greeting = greet.text;
    if (greet.code !== 200 && greet.code !== 201) {
      this.close();
      throw new NntpError(`Unexpected greeting: ${greet.code} ${greet.text}`, greet.code, true);
    }
    if (this.cfg.username) {
      const u = await this.command(`AUTHINFO USER ${this.cfg.username}`);
      if (u.code === 381) {
        const p = await this.command(`AUTHINFO PASS ${this.cfg.password ?? ""}`);
        if (p.code !== 281) {
          this.close();
          throw new NntpError(`Authentication failed: ${p.code} ${p.text}`, p.code, true);
        }
      } else if (u.code !== 281) {
        this.close();
        throw new NntpError(`Authentication failed: ${u.code} ${u.text}`, u.code, true);
      }
    }
    this.diag.info("nntp", `conn#${this.id} ready in ${Date.now() - t0}ms — "${greet.text}"`, {
      ms: Date.now() - t0,
      greeting: greet.text,
      auth: !!this.cfg.username,
    });
  }

  private async fill(): Promise<boolean> {
    if (!this.sock) throw new Error("not connected");
    const chunk = await withTimeout(this.sock.read(), this.timeout, `conn#${this.id} read`);
    if (!chunk) return false;
    if (this.buf.length === 0) this.buf = chunk;
    else this.buf = concat([this.buf, chunk], this.buf.length + chunk.length);
    return true;
  }

  private takeLine(): string | null {
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i] === 0x0a) {
        const end = i > 0 && this.buf[i - 1] === 0x0d ? i - 1 : i;
        const line = dec.decode(this.buf.subarray(0, end));
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
    }
    return null;
  }

  private async readResponse(): Promise<{ code: number; text: string }> {
    while (true) {
      const line = this.takeLine();
      if (line !== null) {
        const code = parseInt(line.slice(0, 3), 10);
        return { code: isNaN(code) ? 0 : code, text: line.slice(4) };
      }
      if (!(await this.fill())) throw new NntpError("Connection closed by server", 0);
    }
  }

  /** Reads a multi-line block terminated by CRLF.CRLF; returns raw (still dot-stuffed) bytes. */
  private async readMultiline(): Promise<{ body: Uint8Array; wireBytes: number }> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let scanFrom = 0; // logical offset where scanning for the terminator resumes
    while (true) {
      if (this.buf.length > 0) {
        chunks.push(this.buf);
        total += this.buf.length;
        this.buf = new Uint8Array(0);
      }
      const winStart = Math.max(0, scanFrom - 4);
      const win = sliceChunks(chunks, winStart, total);
      let idx = -1;
      let termLen = 0;
      if (winStart === 0 && win.length >= 3 && win[0] === 0x2e && win[1] === 0x0d && win[2] === 0x0a) {
        idx = 0; // empty body: ".\r\n" immediately
        termLen = 3;
      } else {
        const i = findTerminator(win);
        if (i >= 0) {
          idx = winStart + i;
          termLen = 5;
        }
      }
      if (idx >= 0) {
        const body = sliceChunks(chunks, 0, idx);
        this.buf = sliceChunks(chunks, idx + termLen, total);
        return { body, wireBytes: idx + termLen };
      }
      scanFrom = total;
      if (!(await this.fill())) throw new NntpError("Connection closed mid-article", 0);
    }
  }

  async command(line: string): Promise<{ code: number; text: string }> {
    if (!this.sock) throw new Error("not connected");
    await this.sock.write(enc.encode(line + "\r\n"));
    return withTimeout(this.readResponse(), this.timeout, `command ${line.split(" ")[0]}`);
  }

  async group(name: string) {
    const r = await this.command(`GROUP ${name}`);
    if (r.code === 211) this.currentGroup = name;
    return r;
  }

  /** Fetch article body by message-id. Returns raw dot-stuffed body bytes. */
  async body(messageId: string): Promise<{ raw: Uint8Array; wireBytes: number; ms: number }> {
    if (!this.sock) throw new Error("not connected");
    const t0 = Date.now();
    const id = messageId.startsWith("<") ? messageId : `<${messageId}>`;
    await this.sock.write(enc.encode(`BODY ${id}\r\n`));
    const resp = await withTimeout(this.readResponse(), this.timeout, "BODY response");
    if (resp.code !== 222) {
      // 430 no such article, 423/420 etc, 480 auth required, 502 permission, 400 service discontinued
      const permanent = resp.code === 430 || resp.code === 423 || resp.code === 420;
      throw new NntpError(`${resp.code} ${resp.text}`, resp.code, permanent);
    }
    const { body, wireBytes } = await withTimeout(this.readMultiline(), this.timeout * 2, "BODY data");
    this.fetched++;
    this.lastUsed = Date.now();
    return { raw: body, wireBytes, ms: Date.now() - t0 };
  }

  async quit() {
    try {
      if (this.sock && !this.sock.closed) {
        await withTimeout(this.sock.write("QUIT\r\n"), 2000, "QUIT").catch(() => {});
      }
    } finally {
      this.close();
    }
  }

  close() {
    this.sock?.close();
    this.sock = null;
  }
}

/** Copy logical range [start,end) out of a chunk list. */
function sliceChunks(chunks: Uint8Array[], start: number, end: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, end - start));
  let pos = 0;
  let o = 0;
  for (const c of chunks) {
    const cStart = pos;
    const cEnd = pos + c.length;
    pos = cEnd;
    if (cEnd <= start) continue;
    if (cStart >= end) break;
    const from = Math.max(start, cStart) - cStart;
    const to = Math.min(end, cEnd) - cStart;
    out.set(c.subarray(from, to), o);
    o += to - from;
  }
  return out;
}

/** Find the CRLF.CRLF terminator. Returns index of the leading CR or -1. */
function findTerminator(buf: Uint8Array): number {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x2e && buf[i + 3] === 0x0d && buf[i + 4] === 0x0a)
      return i;
  }
  return -1;
}

/* ------------------------------------------------------------------------ */

export class NntpPool {
  private conns: NntpConnection[] = [];
  private waiters: Array<(c: NntpConnection) => void> = [];
  private closed = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly cfg: NntpConfig,
    private readonly diag: Diag,
  ) {
    this.idleTimer = setInterval(() => this.reapIdle(), 30000);
    // don't keep the event loop alive just for reaping
    if (this.idleTimer && typeof (this.idleTimer as { unref?: () => void }).unref === "function")
      (this.idleTimer as unknown as { unref: () => void }).unref();
  }

  get size() {
    return this.conns.length;
  }
  get busy() {
    return this.conns.filter((c) => c.busy).length;
  }

  private reapIdle() {
    const now = Date.now();
    for (const c of [...this.conns]) {
      if (!c.busy && now - c.lastUsed > 90000) {
        this.diag.debug("nntp", `conn#${c.id} idle, closing`);
        void c.quit();
        this.conns.splice(this.conns.indexOf(c), 1);
        this.diag.stats.connectionsOpen = this.conns.length;
      }
    }
  }

  private async acquire(): Promise<NntpConnection> {
    if (this.closed) throw new Error("pool closed");
    const free = this.conns.find((c) => !c.busy && c.alive);
    if (free) {
      free.busy = true;
      this.diag.stats.connectionsBusy = this.busy;
      return free;
    }
    // drop dead ones
    this.conns = this.conns.filter((c) => c.alive || c.busy);
    if (this.conns.length < Math.max(1, this.cfg.connections)) {
      const c = new NntpConnection(this.cfg, this.diag);
      c.busy = true;
      this.conns.push(c);
      this.diag.stats.connectionsOpen = this.conns.length;
      this.diag.stats.connectionsBusy = this.busy;
      try {
        await c.connect();
        this.diag.stats.connectionsOpenedTotal++;
        return c;
      } catch (e) {
        this.conns.splice(this.conns.indexOf(c), 1);
        this.diag.stats.connectionsOpen = this.conns.length;
        this.diag.stats.connectionsBusy = this.busy;
        throw e;
      }
    }
    return withTimeout(
      new Promise<NntpConnection>((res) => this.waiters.push(res)),
      120000,
      "waiting for free NNTP connection",
    );
  }

  private release(c: NntpConnection, broken = false) {
    if (broken || !c.alive) {
      c.close();
      const i = this.conns.indexOf(c);
      if (i >= 0) this.conns.splice(i, 1);
      this.diag.stats.connectionsOpen = this.conns.length;
      c.busy = false;
      // wake a waiter by letting it create a new connection
      const w = this.waiters.shift();
      if (w) void this.acquire().then(w).catch(() => this.waiters.length && this.waiters.shift()?.(c));
      this.diag.stats.connectionsBusy = this.busy;
      return;
    }
    c.lastUsed = Date.now();
    const w = this.waiters.shift();
    if (w) {
      w(c); // stays busy
      return;
    }
    c.busy = false;
    this.diag.stats.connectionsBusy = this.busy;
  }

  /**
   * Fetch a body with retries. Permanent errors (430 missing) are not retried
   * across connections more than once; transient/network errors rotate connections.
   */
  async fetchBody(
    messageId: string,
    opts: { groups?: string[]; attempts?: number; label?: string } = {},
  ): Promise<{ raw: Uint8Array; wireBytes: number; ms: number; connId: number; attempt: number }> {
    const attempts = opts.attempts ?? 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let conn: NntpConnection | null = null;
      try {
        conn = await this.acquire();
        try {
          const r = await conn.body(messageId);
          this.release(conn);
          return { ...r, connId: conn.id, attempt };
        } catch (e) {
          const err = e as NntpError;
          if (err instanceof NntpError && err.code === 430 && opts.groups?.length && !conn.currentGroup) {
            // Some providers need a GROUP selected before serving by Message-ID
            this.diag.debug("nntp", `conn#${conn.id} 430 — selecting group ${opts.groups[0]} and retrying`);
            const g = await conn.group(opts.groups[0]).catch(() => ({ code: 0, text: "" }));
            if (g.code === 211) {
              try {
                const r = await conn.body(messageId);
                this.release(conn);
                return { ...r, connId: conn.id, attempt };
              } catch (e2) {
                this.release(conn, !(e2 instanceof NntpError) || e2.code === 0);
                throw e2;
              }
            }
          }
          this.release(conn, !(err instanceof NntpError) || err.code === 0);
          throw err;
        }
      } catch (e) {
        lastErr = e as Error;
        const permanent = e instanceof NntpError && e.permanent;
        this.diag.warn("nntp", `${opts.label ?? messageId} attempt ${attempt}/${attempts} failed: ${lastErr.message}`, {
          messageId,
          attempt,
          code: e instanceof NntpError ? e.code : undefined,
          permanent,
        });
        if (permanent) break;
        this.diag.stats.segmentsRetried++;
      }
    }
    throw lastErr ?? new Error("fetch failed");
  }

  /** Connection test used by the settings UI. */
  static async test(cfg: NntpConfig, diag: Diag): Promise<{ ok: boolean; greeting?: string; ms: number; error?: string; date?: string }> {
    const t0 = Date.now();
    const c = new NntpConnection({ ...cfg, timeoutMs: 15000 }, diag);
    try {
      await c.connect();
      const d = await c.command("DATE").catch(() => ({ code: 0, text: "" }));
      await c.quit();
      return { ok: true, greeting: c.greeting, ms: Date.now() - t0, date: d.code === 111 ? d.text : undefined };
    } catch (e) {
      c.close();
      return { ok: false, ms: Date.now() - t0, error: (e as Error).message };
    }
  }

  async close() {
    this.closed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    await Promise.all(this.conns.map((c) => c.quit()));
    this.conns = [];
    this.diag.stats.connectionsOpen = 0;
    this.diag.stats.connectionsBusy = 0;
  }
}
