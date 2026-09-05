import type { providers } from "@/db/schema";

export function sanitize(p: typeof providers.$inferSelect) {
  return { ...p, password: p.password ? "••••••" : "", hasPassword: !!p.password };
}

export function parseProviderBody(b: Record<string, unknown>) {
  const host = String(b.host ?? "").trim();
  if (!host) throw new Error("host is required");
  const port = Number(b.port ?? 563);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return {
    name: String(b.name ?? host).trim() || host,
    host,
    port,
    ssl: b.ssl === undefined ? port === 563 || port === 443 : !!b.ssl,
    username: b.username ? String(b.username) : null,
    password: b.password ? String(b.password) : null,
    connections: Math.max(1, Math.min(50, Number(b.connections ?? 8) || 8)),
  };
}
