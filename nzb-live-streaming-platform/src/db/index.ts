import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS providers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 563,
    ssl BOOLEAN NOT NULL DEFAULT TRUE,
    username TEXT,
    password TEXT,
    connections INTEGER NOT NULL DEFAULT 8,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT,
    provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    nzb_xml TEXT NOT NULL,
    items_json TEXT,
    total_bytes INTEGER,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_played_at TIMESTAMP WITH TIME ZONE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const globalForDb = globalThis as typeof globalThis & {
  __arenaDbPromise?: Promise<NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>>;
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaPgliteClient?: PGlite;
};

function checkTcpPort(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, host);
  });
}

function initPgliteDatabase(): PgliteDatabase<typeof schema> {
  if (!globalForDb.__arenaPgliteClient) {
    const dataDir = path.join(process.cwd(), ".data", "db");
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {}
    globalForDb.__arenaPgliteClient = new PGlite(dataDir);
  }
  const client = globalForDb.__arenaPgliteClient;
  return drizzlePglite({ client, schema });
}

async function initDatabase(): Promise<NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl && !databaseUrl.startsWith("pglite:") && !databaseUrl.startsWith("memory:") && !databaseUrl.startsWith("file:")) {
    try {
      const u = new URL(databaseUrl);
      const host = u.hostname || "127.0.0.1";
      const port = Number(u.port || 5432);
      const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";

      let isAvailable = true;
      if (isLocal) {
        isAvailable = await checkTcpPort(host, port, 300);
      }

      if (isAvailable) {
        const poolInstance =
          globalForDb.__arenaNextJsPostgresqlPool ??
          new Pool({
            connectionString: databaseUrl,
            connectionTimeoutMillis: 3000,
          });

        if (process.env.NODE_ENV !== "production") {
          globalForDb.__arenaNextJsPostgresqlPool = poolInstance;
        }

        await poolInstance.query(SCHEMA_DDL);
        return drizzlePg({ client: poolInstance, schema });
      } else {
        console.warn(`[db] PostgreSQL at ${host}:${port} is not reachable. Using embedded PGlite database at .data/db.`);
      }
    } catch (e) {
      console.warn(`[db] Failed connecting to PostgreSQL, falling back to embedded PGlite: ${(e as Error).message}`);
    }
  }

  const pgliteDb = initPgliteDatabase();
  if (globalForDb.__arenaPgliteClient) {
    await globalForDb.__arenaPgliteClient.exec(SCHEMA_DDL);
  }
  return pgliteDb;
}

export function getDb(): Promise<NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>> {
  if (!globalForDb.__arenaDbPromise) {
    globalForDb.__arenaDbPromise = initDatabase();
  }
  return globalForDb.__arenaDbPromise;
}

function createQueryChain(initialCall: (inst: any) => any) {
  const operations: Array<{ method: string; args: any[] }> = [];

  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "then") {
        return (resolve: (val: any) => any, reject?: (err: any) => any) => {
          return getDb()
            .then((inst: any) => {
              let current = initialCall(inst);
              for (const op of operations) {
                current = current[op.method](...op.args);
              }
              return current;
            })
            .then(resolve, reject);
        };
      }
      if (prop === "catch") {
        return (reject: (err: any) => any) => handler.get!(target, "then", target)(undefined, reject);
      }
      return (...args: any[]) => {
        operations.push({ method: prop as string, args });
        return proxy;
      };
    },
  };

  const proxy: any = new Proxy({}, handler);
  return proxy;
}

export const db: NodePgDatabase<typeof schema> = {
  select: ((...args: any[]) => createQueryChain((inst) => inst.select(...args))) as any,
  insert: ((...args: any[]) => createQueryChain((inst) => inst.insert(...args))) as any,
  update: ((...args: any[]) => createQueryChain((inst) => inst.update(...args))) as any,
  delete: ((...args: any[]) => createQueryChain((inst) => inst.delete(...args))) as any,
  execute: ((...args: any[]) => (getDb() as Promise<any>).then((inst: any) => inst.execute(...args))) as any,
  transaction: ((...args: any[]) => (getDb() as Promise<any>).then((inst: any) => inst.transaction(...args))) as any,
  query: new Proxy({} as any, {
    get(_t, table) {
      return new Proxy({} as any, {
        get(_t2, op) {
          return (...args: any[]) => (getDb() as Promise<any>).then((inst: any) => inst.query[table][op](...args));
        },
      });
    },
  }),
} as unknown as NodePgDatabase<typeof schema>;

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith("pglite:")
    ? new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 })
    : (null as unknown as Pool));

if (process.env.NODE_ENV !== "production" && pool) {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}
