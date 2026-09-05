/**
 * Minimal portable TCP/TLS socket abstraction.
 *
 * - Node / Vercel / Wasmer(WinterJS w/ node compat) / Netlify: node:tls + node:net
 * - Cloudflare Workers (OpenNext + nodejs_compat): falls back to the
 *   `cloudflare:sockets` connect() API when node:tls is unavailable.
 *
 * Only two primitives are needed by the NNTP client: write() and an async
 * byte stream for reading. Everything is timeout guarded so a dead provider
 * can never wedge a request.
 */

export interface RawSocket {
  write(data: Uint8Array | string): Promise<void>;
  /** Pulls the next chunk; resolves null on EOF. Rejects on socket error. */
  read(): Promise<Uint8Array | null>;
  close(): void;
  readonly closed: boolean;
}

export interface SocketOptions {
  host: string;
  port: number;
  tls: boolean;
  connectTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Simple async queue that bridges event-emitter style data into read() pulls. */
class ChunkQueue {
  private chunks: Uint8Array[] = [];
  private waiters: Array<{ res: (v: Uint8Array | null) => void; rej: (e: Error) => void }> = [];
  private ended = false;
  private error: Error | null = null;

  push(c: Uint8Array) {
    const w = this.waiters.shift();
    if (w) w.res(c);
    else this.chunks.push(c);
  }
  end(err?: Error) {
    if (this.ended) return;
    this.ended = true;
    this.error = err ?? null;
    for (const w of this.waiters.splice(0)) (err ? w.rej(err) : w.res(null));
  }
  pull(): Promise<Uint8Array | null> {
    const c = this.chunks.shift();
    if (c) return Promise.resolve(c);
    if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve(null);
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }
}

async function openNodeSocket(opts: SocketOptions): Promise<RawSocket> {
  const net = await import("node:net");
  const tls = await import("node:tls");
  const q = new ChunkQueue();
  let closed = false;

  const sock = await withTimeout(
    new Promise<import("node:net").Socket>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      const s = opts.tls
        ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, () => {
            s.off("error", onErr);
            resolve(s);
          })
        : net.connect({ host: opts.host, port: opts.port }, () => {
            s.off("error", onErr);
            resolve(s);
          });
      s.once("error", onErr);
    }),
    opts.connectTimeoutMs ?? 15000,
    `connect ${opts.host}:${opts.port}`,
  );
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 30000);
  sock.on("data", (d: Buffer) => q.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
  sock.on("error", (e: Error) => {
    closed = true;
    q.end(e);
  });
  sock.on("close", () => {
    closed = true;
    q.end();
  });
  return {
    write: (data) =>
      new Promise<void>((res, rej) => {
        if (closed) return rej(new Error("socket closed"));
        sock.write(data, (err) => (err ? rej(err) : res()));
      }),
    read: () => q.pull(),
    close: () => {
      closed = true;
      sock.destroy();
      q.end();
    },
    get closed() {
      return closed;
    },
  };
}

async function openCloudflareSocket(opts: SocketOptions): Promise<RawSocket> {
  // Hidden from bundlers; only resolvable inside workerd.
  const dynImport = new Function("m", "return import(m)") as (m: string) => Promise<{
    connect: (
      addr: { hostname: string; port: number },
      o?: { secureTransport?: "on" | "off" | "starttls"; allowHalfOpen?: boolean },
    ) => {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      close(): Promise<void>;
      opened: Promise<unknown>;
    };
  }>;
  const mod = await dynImport("cloudflare:sockets");
  const s = mod.connect({ hostname: opts.host, port: opts.port }, { secureTransport: opts.tls ? "on" : "off" });
  await withTimeout(s.opened, opts.connectTimeoutMs ?? 15000, `connect ${opts.host}:${opts.port}`);
  const reader = s.readable.getReader();
  const writer = s.writable.getWriter();
  let closed = false;
  const enc = new TextEncoder();
  return {
    write: async (data) => {
      await writer.write(typeof data === "string" ? enc.encode(data) : data);
    },
    read: async () => {
      const { value, done } = await reader.read();
      if (done) {
        closed = true;
        return null;
      }
      return value;
    },
    close: () => {
      closed = true;
      void s.close().catch(() => {});
    },
    get closed() {
      return closed;
    },
  };
}

export async function openSocket(opts: SocketOptions): Promise<RawSocket> {
  const isWorkerd = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  if (isWorkerd) {
    try {
      return await openCloudflareSocket(opts);
    } catch (e) {
      // nodejs_compat may still provide node:tls; fall through
      if (!(e instanceof Error) || !/cloudflare:sockets/.test(e.message)) throw e;
    }
  }
  return openNodeSocket(opts);
}

export { withTimeout };
