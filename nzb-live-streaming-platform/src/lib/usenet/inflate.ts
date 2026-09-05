/**
 * On-the-fly inflation of compressed archive entries so they can be served
 * as HTTP ranges (VLC/mpv/download) and played in the browser.
 *
 * Edge-safe:
 *   - ZIP deflate  → Web `DecompressionStream` (CF / Wasmer / Node / browsers)
 *   - RAR m1–m5    → 7-Zip WASM (no native binary, no stdout). Volumes are
 *                    assembled in MEMFS and extracted under a mutex + timeout.
 *
 * Compressed codecs are sequential: we inflate once, keep the result on the
 * session reader, then serve any byte range from that buffer. Memory is
 * capped by MAX_INFLATE_MB (default 512).
 */
import type { SevenZipModule } from "7z-wasm";
import { withTimeout } from "./socket";
import { rarVolumeKey } from "./rar";
import type { RandomReader } from "./virtualfile";
import type { Diag } from "./diag";

export function maxInflateBytes(): number {
  const mb = Number(process.env.MAX_INFLATE_MB ?? "512");
  return Math.max(32, mb) * 1024 * 1024;
}

export interface InflateOpts {
  method: string;
  format: "rar4" | "rar5" | "zip" | "unknown";
  volumes: RandomReader[];
  entryName: string;
  packedSize: number;
  diag: Diag;
}

export class InflatingReader implements RandomReader {
  private inflated: Uint8Array | null = null;
  private inflight: Promise<Uint8Array> | null = null;

  constructor(
    readonly name: string,
    readonly size: number,
    private readonly packed: RandomReader,
    private readonly opts: InflateOpts,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const data = await this.ensure();
    const start = Math.max(0, Math.min(offset, data.length));
    const end = Math.max(start, Math.min(offset + length, data.length));
    return data.subarray(start, end);
  }

  async *stream(start: number, end: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const data = await this.ensure();
    if (signal?.aborted) return;
    end = Math.min(end, data.length - 1);
    if (start > end) return;
    const slice = data.subarray(start, end + 1);
    const chunk = 256 * 1024;
    for (let i = 0; i < slice.length; i += chunk) {
      if (signal?.aborted) return;
      yield slice.subarray(i, Math.min(slice.length, i + chunk));
    }
  }

  private ensure(): Promise<Uint8Array> {
    if (this.inflated) return Promise.resolve(this.inflated);
    if (!this.inflight) {
      this.inflight = this.inflate()
        .then((d) => {
          this.inflated = d;
          return d;
        })
        .catch((e) => {
          this.inflight = null;
          throw e;
        });
    }
    return this.inflight;
  }

  private async inflate(): Promise<Uint8Array> {
    const { method, format, diag, packedSize, entryName } = this.opts;
    const cap = maxInflateBytes();
    if (this.size > cap) {
      throw new Error(
        `${entryName} unpacks to ${fmt(this.size)} which exceeds MAX_INFLATE_MB=${Math.round(cap / 1048576)} — raise it on a fat host, or use a stored (m0) release`,
      );
    }
    const t0 = Date.now();
    diag.info("archive", `inflating "${entryName}" (${method}, ${format}) packed=${fmt(packedSize)} unpacked=${fmt(this.size)}`);
    let out: Uint8Array;
    if (format === "zip" || method === "compressed(deflate)" || method === "deflate") {
      out = await inflateZip(this.packed, packedSize, diag);
    } else {
      out = await inflateRar(this.opts);
    }
    if (this.size > 0 && out.length !== this.size) {
      diag.warn("archive", `inflated size ${out.length} != header size ${this.size} for ${entryName}`);
    }
    diag.info("archive", `inflated "${entryName}" → ${fmt(out.length)} in ${Date.now() - t0}ms`);
    return out;
  }
}

async function inflateZip(packed: RandomReader, packedSize: number, diag: Diag): Promise<Uint8Array> {
  const src = await packed.read(0, packedSize || packed.size);
  diag.debug("archive", `zip packed payload ${src.length}B, running DecompressionStream(deflate-raw)`);
  const tryCodec = async (codec: string) => {
    const DS = (globalThis as unknown as { DecompressionStream: typeof DecompressionStream }).DecompressionStream;
    if (typeof DS !== "function") throw new Error("DecompressionStream is not available in this runtime");
    const copy = new Uint8Array(src.byteLength);
    copy.set(src);
    const stream = new Blob([copy]).stream().pipeThrough(new DS(codec as "deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await tryCodec("deflate-raw");
  } catch (e) {
    diag.warn("archive", `deflate-raw failed (${(e as Error).message}); retrying zlib deflate wrapper`);
    return await tryCodec("deflate");
  }
}

/* --------------------------------- RAR / 7z -------------------------------- */

let szMod: Promise<SevenZipModule> | null = null;
let szLock: Promise<void> = Promise.resolve();

const EXTRACT_MS = Number(process.env.RAR_EXTRACT_TIMEOUT_MS ?? "180000");

async function loadSevenZip(diag: Diag): Promise<SevenZipModule> {
  if (!szMod) {
    szMod = (async () => {
      const SevenZip = (await import("7z-wasm")).default;
      const opts: {
        print: (s: string) => void;
        printErr: (s: string) => void;
        stdin: () => number;
        wasmBinary?: ArrayBuffer;
        noExitRuntime: boolean;
      } = {
        // 7z must never touch real stdout/stdin — that wedges serverless runtimes.
        print: (s) => diag.debug("archive", `7z: ${s}`),
        printErr: (s) => diag.debug("archive", `7z: ${s}`),
        stdin: () => null as unknown as number,
        noExitRuntime: true,
      };
      try {
        const { readFile } = await import("node:fs/promises");
        const { createRequire } = await import("node:module");
        const { dirname, join } = await import("node:path");
        const req = createRequire(import.meta.url);
        // Resolve the package's JS entrypoint, then find the sibling WASM file.
        // Passing the .wasm subpath directly to require.resolve makes Turbopack
        // treat it as an imported WASM module and synthesize imports from the
        // module's `env`/WASI namespaces, which are not JavaScript packages.
        const packageEntry = req.resolve("7z-wasm");
        const wasmPath = join(dirname(packageEntry), "7zz.wasm");
        const buf = await readFile(wasmPath);
        opts.wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        diag.debug("archive", `loaded 7zz.wasm (${fmt(buf.length)}) from ${wasmPath}`);
      } catch (e) {
        diag.debug("archive", `7zz.wasm disk load skipped: ${(e as Error).message}`);
      }
      return SevenZip(opts);
    })().catch((e) => {
      szMod = null;
      throw e;
    });
  }
  return szMod;
}

function withSevenZip<T>(diag: Diag, fn: (sz: SevenZipModule) => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const acquired = new Promise<void>((res) => {
    szLock = szLock.then(
      () =>
        new Promise<void>((r) => {
          release = r;
          res();
        }),
    );
  });
  return acquired
    .then(async () => {
      const sz = await loadSevenZip(diag);
      return fn(sz);
    })
    .finally(() => release());
}

async function inflateRar(opts: InflateOpts): Promise<Uint8Array> {
  const { volumes, entryName, diag } = opts;
  if (!volumes.length) throw new Error("no RAR volumes");
  return withSevenZip(diag, (sz) =>
    withTimeout(
      (async () => {
        const job = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const inDir = `/${job}/in`;
        const outDir = `/${job}/out`;
        mkdirp(sz, `/${job}`);
        mkdirp(sz, inDir);
        mkdirp(sz, outDir);
        try {
          const names: string[] = [];
          for (let i = 0; i < volumes.length; i++) {
            const vol = volumes[i];
            const fname = volumeWriteName(vol.name, i, volumes.length);
            names.push(fname);
            diag.info("archive", `reading RAR volume ${i + 1}/${volumes.length} "${vol.name}" → ${fname} (${fmt(vol.size)})`);
            const data = await vol.read(0, vol.size);
            sz.FS.writeFile(`${inDir}/${fname}`, data);
          }
          const archive = `${inDir}/${names[0]}`;
          const args = ["x", "-y", "-mmt=1", "-bso0", "-bsp0", `-o${outDir}`, archive];
          const base = entryName.replace(/^.*[\\/]/, "");
          if (base) args.push(base);
          diag.info("archive", `7z ${args.join(" ")}`);
          let status = 0;
          try {
            const ret = sz.callMain(args) as unknown;
            if (typeof ret === "number") status = ret;
          } catch (e) {
            const st = (e as { status?: number; message?: string })?.status;
            if (typeof st === "number") status = st;
            else if (!/ExitStatus|exit\(/i.test(String((e as Error).message ?? e))) throw e;
          }
          const found = findExtracted(sz, outDir, base);
          if (!found) {
            const listing = listFiles(sz, outDir).join(", ") || "(empty)";
            throw new Error(`7z extract failed (status ${status}); out dir: ${listing}`);
          }
          const data = sz.FS.readFile(found);
          diag.debug("archive", `7z extracted ${found} (${fmt(data.length)})`);
          return data;
        } finally {
          rmrf(sz, `/${job}`);
        }
      })(),
      EXTRACT_MS,
      `RAR extract ${entryName}`,
    ),
  );
}

function volumeWriteName(name: string, index: number, total: number): string {
  const base = name.replace(/^.*[\\/]/, "") || `vol${index}.rar`;
  if (total === 1) return /\.rar$/i.test(base) ? base : `${base}.rar`;
  if (rarVolumeKey(base)) return base;
  return `archive.part${index + 1}.rar`;
}

function mkdirp(sz: SevenZipModule, path: string) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += `/${p}`;
    try {
      sz.FS.mkdir(cur);
    } catch {
      /* exists */
    }
  }
}

function rmrf(sz: SevenZipModule, path: string) {
  try {
    const st = sz.FS.stat(path);
    if (sz.FS.isDir(st.mode)) {
      for (const n of sz.FS.readdir(path)) {
        if (n === "." || n === "..") continue;
        rmrf(sz, `${path}/${n}`);
      }
      try {
        sz.FS.rmdir(path);
      } catch {
        /* ignore */
      }
    } else {
      sz.FS.unlink(path);
    }
  } catch {
    /* gone */
  }
}

function listFiles(sz: SevenZipModule, dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let names: string[] = [];
    try {
      names = sz.FS.readdir(p);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "." || n === "..") continue;
      const fp = `${p}/${n}`;
      try {
        const st = sz.FS.stat(fp);
        if (sz.FS.isDir(st.mode)) walk(fp);
        else out.push(fp);
      } catch {
        /* skip */
      }
    }
  };
  walk(dir);
  return out;
}

function findExtracted(sz: SevenZipModule, outDir: string, base: string): string | null {
  const files = listFiles(sz, outDir);
  if (!files.length) return null;
  const lower = base.toLowerCase();
  const exact = files.find((f) => f.replace(/^.*\//, "").toLowerCase() === lower);
  if (exact) return exact;
  if (files.length === 1) return files[0];
  let largest = files[0];
  let largestSize = 0;
  for (const f of files) {
    try {
      const n = sz.FS.stat(f).size;
      if (n > largestSize) {
        largest = f;
        largestSize = n;
      }
    } catch {
      /* skip */
    }
  }
  return largest;
}

function fmt(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
