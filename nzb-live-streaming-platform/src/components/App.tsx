"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaItem, SessionInfo } from "@/lib/usenet/session";
import type { SearchResult } from "@/lib/indexer";
import { Player, fmtBytes } from "./Player";
import { Diagnostics } from "./Diagnostics";

interface ProviderView {
  id: number;
  name: string;
  host: string;
  port: number;
  ssl: boolean;
  username: string | null;
  password: string;
  hasPassword: boolean;
  connections: number;
}
interface SessionListRow {
  id: string;
  title: string;
  source: string;
  fileCount: number;
  totalBytes: number | null;
  createdAt: string;
  analyzed: boolean;
}
type SessionFull = SessionInfo & { items: MediaItem[] };

const KIND_ICON: Record<string, string> = { video: "🎬", audio: "🎵", image: "🖼️", subtitle: "💬", text: "📄", pdf: "📕", archive: "📦", par2: "🛡️", other: "📎" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export default function App() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [session, setSession] = useState<SessionFull | null>(null);
  const [item, setItem] = useState<MediaItem | null>(null);
  const [diag, setDiag] = useState(false);
  const [browserLog, setBrowserLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadProviders = useCallback(async () => {
    const p = await api<ProviderView[]>("/api/providers");
    setProviders(p);
    setProviderId((cur) => cur ?? p[0]?.id ?? null);
    if (!p.length) setShowProviderForm(true);
  }, []);
  const loadSessions = useCallback(async () => setSessions(await api<SessionListRow[]>("/api/sessions")), []);

  useEffect(() => {
    void (async () => {
      try {
        const p = await api<ProviderView[]>("/api/providers");
        setProviders(p);
        setProviderId((cur) => cur ?? p[0]?.id ?? null);
        if (!p.length) setShowProviderForm(true);
      } catch (e) {
        setError(String((e as Error).message));
      }
      try {
        const s = await api<SessionListRow[]>("/api/sessions");
        setSessions(s);
      } catch {}
      const d = localStorage.getItem("nzb.diag");
      if (d === "1") setDiag(true);
    })();
  }, []);

  useEffect(() => localStorage.setItem("nzb.diag", diag ? "1" : "0"), [diag]);

  // poll session while analyzing
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!session || session.analyzed || session.analyzeError) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api<SessionFull>(`/api/sessions/${session.id}`);
        setSession(s);
        if (s.analyzed || s.analyzeError) {
          if (pollRef.current) clearInterval(pollRef.current);
          loadSessions().catch(() => {});
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [session, loadSessions]);

  const openSession = async (id: string) => {
    setError(null);
    setItem(null);
    setBusy("loading session");
    try {
      const s = await api<SessionFull>(`/api/sessions/${id}`);
      setSession(s);
      window.history.replaceState(null, "", `?s=${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("s");
    if (id) {
      void (async () => {
        setError(null);
        setItem(null);
        setBusy("loading session");
        try {
          const s = await api<SessionFull>(`/api/sessions/${id}`);
          setSession(s);
          window.history.replaceState(null, "", `?s=${id}`);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(null);
        }
      })();
    }
  }, []);

  const createSession = async (body: Record<string, unknown> | FormData) => {
    if (!providerId) {
      setError("Add an NNTP provider first");
      setShowProviderForm(true);
      return;
    }
    setError(null);
    setBusy("fetching NZB");
    try {
      const init: RequestInit =
        body instanceof FormData ? (body.append("providerId", String(providerId)), { method: "POST", body }) : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, providerId }) };
      const s = await api<SessionInfo>("/api/sessions", init);
      setItem(null);
      setSession({ ...s, items: [] });
      window.history.replaceState(null, "", `?s=${s.id}`);
      loadSessions().catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteSession = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (session?.id === id) {
      setSession(null);
      setItem(null);
    }
    loadSessions().catch(() => {});
  };

  const selectedProvider = providers.find((p) => p.id === providerId) ?? null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xl">📡</span>
            <span className="font-bold tracking-tight text-lg">
              nzb<span className="text-emerald-400">.stream</span>
            </span>
            <span className="text-xs text-zinc-500 hidden sm:inline">usenet → browser, live</span>
          </div>
          <div className="grow" />
          <div className="flex items-center gap-2 text-sm">
            <select value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value) || null)} className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 max-w-[200px]">
              {!providers.length && <option value="">no provider</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.host})
                </option>
              ))}
            </select>
            <button onClick={() => setShowProviderForm((v) => !v)} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">
              {showProviderForm ? "close" : "providers"}
            </button>
            <label className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border cursor-pointer select-none ${diag ? "bg-emerald-950/60 border-emerald-700 text-emerald-200" : "bg-zinc-800 border-zinc-700"}`}>
              <input type="checkbox" checked={diag} onChange={(e) => setDiag(e.target.checked)} className="accent-emerald-500" />
              Diagnostics
            </label>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5 flex flex-col gap-5">
        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/40 text-red-200 px-4 py-2 text-sm flex items-center gap-3">
            <span className="grow">{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-white">
              ✕
            </button>
          </div>
        )}
        {busy && <div className="text-sm text-zinc-400 animate-pulse">⏳ {busy}…</div>}

        {showProviderForm && <ProviderPanel providers={providers} onChange={loadProviders} selected={selectedProvider} onSelect={setProviderId} />}

        {session && diag && <Diagnostics sessionId={session.id} extra={browserLog} />}

        {session ? (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-5">
            <section className="flex flex-col gap-3 min-w-0">
              <div className="flex items-start gap-3">
                <button onClick={() => { setSession(null); setItem(null); window.history.replaceState(null, "", "/"); }} className="text-zinc-400 hover:text-white text-sm mt-1">
                  ← back
                </button>
                <div className="min-w-0">
                  <h1 className="font-semibold text-lg leading-tight break-words">{session.title}</h1>
                  <div className="text-xs text-zinc-500">
                    {session.fileCount} files · {fmtBytes(session.totalBytes)} · via {session.provider.name}
                    {session.par2 ? ` · PAR2: ${session.par2.files} protected files` : ""}
                  </div>
                </div>
              </div>
              {item ? (
                <Player sessionId={session.id} item={item} items={session.items} onEvent={(m) => setBrowserLog((l) => [...l.slice(-50), m])} />
              ) : (
                <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-zinc-500 text-sm">
                  {session.analyzed ? "Pick a file on the right to start streaming." : session.analyzeError ? (
                    <div>
                      <div className="text-red-300">Analysis failed: {session.analyzeError}</div>
                      <button onClick={() => api<SessionFull>(`/api/sessions/${session.id}?retry=1`).then(setSession)} className="mt-3 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200">retry</button>
                      <div className="text-xs mt-2">Turn on Diagnostics to see exactly which step failed.</div>
                    </div>
                  ) : (
                    <div className="animate-pulse">Inspecting files on the provider (first segment of each) — resolving names, detecting types, mapping archives…</div>
                  )}
                </div>
              )}
            </section>
            <aside className="flex flex-col gap-2 min-w-0">
              <div className="flex items-center justify-between text-xs text-zinc-500 uppercase tracking-wide">
                <span>Media ({session.items.length})</span>
                <button onClick={() => api<SessionFull>(`/api/sessions/${session.id}?analyze=1`).then(setSession)} className="hover:text-white normal-case">
                  re-analyze
                </button>
              </div>
              <div className="flex flex-col gap-1 max-h-[75vh] overflow-auto pr-1">
                {session.items.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => setItem(it)}
                    className={`text-left rounded-lg px-3 py-2 border transition ${item?.id === it.id ? "bg-emerald-950/50 border-emerald-700" : "bg-zinc-900 border-zinc-800 hover:border-zinc-600"} ${!it.playable ? "opacity-70" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span>{KIND_ICON[it.kind] ?? "📎"}</span>
                      <span className="truncate text-sm grow" title={it.name}>
                        {it.name}
                      </span>
                      <span className="text-[10px] text-zinc-500 shrink-0">{fmtBytes(it.size)}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 flex gap-2 mt-0.5 pl-6">
                      <span>{it.ext.toUpperCase() || "BIN"}</span>
                      {it.container !== "direct" && <span className="text-orange-300">in {it.container}</span>}
                      {it.needsDecompress && <span className="text-amber-300">{it.method ?? "compressed"}</span>}
                      {it.playable ? <span className="text-emerald-400">streamable</span> : <span className="text-zinc-500 truncate" title={it.reason}>{it.reason}</span>}
                    </div>
                  </button>
                ))}
                {!session.items.length && !session.analyzeError && <div className="text-xs text-zinc-600 animate-pulse">analyzing…</div>}
              </div>
              <details className="text-xs text-zinc-500 mt-2">
                <summary className="cursor-pointer hover:text-zinc-300">Raw NZB files ({session.files.length})</summary>
                <ul className="mt-1 flex flex-col gap-0.5 max-h-60 overflow-auto">
                  {session.files.map((f) => (
                    <li key={f.index} className="truncate" title={f.name}>
                      #{f.index} {f.name} · {fmtBytes(f.size)} · {f.segments} seg
                    </li>
                  ))}
                </ul>
              </details>
            </aside>
          </div>
        ) : (
          <>
            <SourcePanel onCreate={createSession} disabled={!!busy} />
            <section>
              <h2 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Recent</h2>
              {!sessions.length && <div className="text-sm text-zinc-600">No streams yet. Search the indexer, paste an NZB URL, or upload an .nzb file.</div>}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {sessions.map((s) => (
                  <div key={s.id} className="rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-600 px-3 py-2 flex items-center gap-2">
                    <button onClick={() => openSession(s.id)} className="text-left grow min-w-0">
                      <div className="truncate text-sm" title={s.title}>
                        {s.title}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {s.fileCount} files · {fmtBytes(s.totalBytes ?? 0)} · {s.source} · {new Date(s.createdAt).toLocaleString()}
                      </div>
                    </button>
                    <button onClick={() => deleteSession(s.id)} className="text-zinc-600 hover:text-red-400" title="delete">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
      <footer className="max-w-7xl mx-auto px-4 py-6 text-[11px] text-zinc-600">
        Streams are assembled on the fly from yEnc segments (NNTP → decode → CRC → RAR/ZIP map → HTTP range). Compressed RAR/ZIP is inflated in WASM / DecompressionStream. Nothing is written to disk; the segment cache is in memory only.
      </footer>
    </div>
  );
}

/* ------------------------------- Providers -------------------------------- */

function ProviderPanel({ providers, onChange, selected, onSelect }: { providers: ProviderView[]; onChange: () => Promise<void>; selected: ProviderView | null; onSelect: (id: number) => void }) {
  const blank = { name: "", host: "", port: 563, ssl: true, username: "", password: "", connections: 8 };
  const [form, setForm] = useState<typeof blank & { id?: number }>(blank);
  const [test, setTest] = useState<{ ok: boolean; ms: number; greeting?: string; error?: string; date?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const edit = (p: ProviderView) => {
    setForm({ id: p.id, name: p.name, host: p.host, port: p.port, ssl: p.ssl, username: p.username ?? "", password: p.password, connections: p.connections });
    setTest(null);
  };
  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await api<ProviderView>(form.id ? `/api/providers/${form.id}` : "/api/providers", {
        method: form.id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      await onChange();
      onSelect(r.id);
      setMsg("saved");
      setForm(blank);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const runTest = async () => {
    setTest(null);
    setSaving(true);
    try {
      setTest(await api("/api/providers/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) }));
    } catch (e) {
      setTest({ ok: false, ms: 0, error: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: number) => {
    await fetch(`/api/providers/${id}`, { method: "DELETE" });
    await onChange();
  };
  const inp = "bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm w-full";
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 grid grid-cols-1 md:grid-cols-[1fr_1.4fr] gap-4">
      <div>
        <h2 className="font-semibold mb-2">NNTP providers</h2>
        <p className="text-xs text-zinc-500 mb-3">Any usenet provider works (Newshosting, Eweka, UsenetServer, Frugal, a local server…). SSL on 563 is typical; plain NNTP on 119.</p>
        <ul className="flex flex-col gap-1">
          {providers.map((p) => (
            <li key={p.id} className={`flex items-center gap-2 rounded-lg px-3 py-2 border text-sm ${selected?.id === p.id ? "border-emerald-700 bg-emerald-950/30" : "border-zinc-800 bg-zinc-900"}`}>
              <button onClick={() => onSelect(p.id)} className="grow text-left min-w-0">
                <div className="truncate">{p.name}</div>
                <div className="text-[10px] text-zinc-500">
                  {p.host}:{p.port} {p.ssl ? "TLS" : "plain"} · {p.connections} conns {p.username ? `· ${p.username}` : ""}
                </div>
              </button>
              <button onClick={() => edit(p)} className="text-zinc-400 hover:text-white text-xs">
                edit
              </button>
              <button onClick={() => remove(p.id)} className="text-zinc-600 hover:text-red-400 text-xs">
                ✕
              </button>
            </li>
          ))}
          {!providers.length && <li className="text-sm text-zinc-500">None yet — add one on the right.</li>}
        </ul>
        <IndexerSettings />
      </div>
      <div className="grid grid-cols-2 gap-2 content-start">
        <div className="col-span-2 font-medium text-sm">{form.id ? `Edit provider #${form.id}` : "Add provider"}</div>
        <input className={inp} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={inp} placeholder="host (news.example.com)" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
        <input className={inp} type="number" placeholder="port" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
        <label className="flex items-center gap-2 text-sm px-1">
          <input type="checkbox" checked={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.checked })} /> SSL/TLS
        </label>
        <input className={inp} placeholder="username (optional)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
        <input className={inp} type="password" placeholder="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        <label className="text-sm flex items-center gap-2">
          connections
          <input className={inp} type="number" min={1} max={50} value={form.connections} onChange={(e) => setForm({ ...form, connections: Number(e.target.value) })} />
        </label>
        <div className="flex gap-2 items-center justify-end">
          <button onClick={runTest} disabled={saving || !form.host} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm disabled:opacity-50">
            test
          </button>
          <button onClick={save} disabled={saving || !form.host} className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm disabled:opacity-50">
            {form.id ? "update" : "save"}
          </button>
          {form.id && (
            <button onClick={() => setForm(blank)} className="text-xs text-zinc-400">
              cancel
            </button>
          )}
        </div>
        {test && (
          <div className={`col-span-2 text-xs rounded-lg px-3 py-2 border ${test.ok ? "border-emerald-800 bg-emerald-950/40 text-emerald-200" : "border-red-900 bg-red-950/40 text-red-200"}`}>
            {test.ok ? `✓ connected in ${test.ms}ms — ${test.greeting}${test.date ? ` · server time ${test.date}` : ""}` : `✗ ${test.error}`}
          </div>
        )}
        {msg && <div className="col-span-2 text-xs text-zinc-400">{msg}</div>}
      </div>
    </section>
  );
}

function IndexerSettings() {
  const [s, setS] = useState<{ indexerUrl: string; hasKey: boolean; keySource: string; keyHint: string } | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  useEffect(() => {
    api<typeof s>("/api/settings").then((v) => {
      setS(v);
      setUrl(v?.indexerUrl ?? "");
    });
  }, []);
  const save = async () => {
    const v = await api<typeof s>("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ indexerUrl: url, apiKey: key || undefined }) });
    setS(v);
    setKey("");
  };
  return (
    <div className="mt-4 text-xs">
      <div className="font-medium text-sm mb-1">Indexer (newznab)</div>
      <div className="text-zinc-500 mb-2">{s ? `${s.indexerUrl} · key ${s.hasKey ? `${s.keyHint} (${s.keySource})` : "missing"}` : "…"}</div>
      <div className="flex gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 grow" placeholder="https://api.nzb.life" />
        <input value={key} onChange={(e) => setKey(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 w-40" placeholder="api key" />
        <button onClick={save} className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700">
          save
        </button>
      </div>
    </div>
  );
}

/* --------------------------------- Source --------------------------------- */

function SourcePanel({ onCreate, disabled }: { onCreate: (b: Record<string, unknown> | FormData) => Promise<void>; disabled: boolean }) {
  const [tab, setTab] = useState<"search" | "url" | "upload" | "paste">("search");
  const [q, setQ] = useState("");
  const [type, setType] = useState<"search" | "tvsearch" | "movie">("search");
  const [cat, setCat] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [xml, setXml] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSearching(true);
    setSearchErr(null);
    try {
      const sp = new URLSearchParams({ q, type });
      if (cat) sp.set("cat", cat);
      const r = await api<{ results: SearchResult[]; total: number }>(`/api/search?${sp}`);
      setResults(r.results);
      setTotal(r.total);
    } catch (e) {
      setSearchErr((e as Error).message);
      setResults(null);
    } finally {
      setSearching(false);
    }
  };
  const tabCls = (t: string) => `px-3 py-1.5 text-sm rounded-lg border ${tab === t ? "bg-zinc-800 border-zinc-600" : "border-transparent text-zinc-400 hover:text-white"}`;
  const inp = "bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm w-full";
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-3">
      <div className="flex gap-1 flex-wrap">
        <button className={tabCls("search")} onClick={() => setTab("search")}>🔎 Search indexer</button>
        <button className={tabCls("url")} onClick={() => setTab("url")}>🔗 NZB URL</button>
        <button className={tabCls("upload")} onClick={() => setTab("upload")}>📁 Upload .nzb</button>
        <button className={tabCls("paste")} onClick={() => setTab("paste")}>📋 Paste XML</button>
      </div>
      {tab === "search" && (
        <form onSubmit={search} className="flex flex-col gap-2">
          <div className="flex gap-2 flex-wrap">
            <input className={`${inp} grow min-w-[200px]`} placeholder="search nzb.life… (e.g. big buck bunny)" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 text-sm">
              <option value="search">all</option>
              <option value="movie">movies</option>
              <option value="tvsearch">tv</option>
            </select>
            <select value={cat} onChange={(e) => setCat(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 text-sm">
              <option value="">any category</option>
              <option value="2000">Movies</option>
              <option value="5000">TV</option>
              <option value="3000">Audio</option>
              <option value="7000">Books</option>
              <option value="8000">Other</option>
            </select>
            <button disabled={searching || !q} className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm disabled:opacity-50">
              {searching ? "searching…" : "search"}
            </button>
          </div>
          {searchErr && <div className="text-xs text-red-300">{searchErr}</div>}
          {results && (
            <div className="flex flex-col gap-1 max-h-[50vh] overflow-auto">
              <div className="text-[10px] text-zinc-500">{results.length} of {total} results</div>
              {results.map((r) => (
                <div key={r.guid} className="flex items-center gap-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-600 px-3 py-2">
                  <div className="grow min-w-0">
                    <div className="text-sm truncate" title={r.title}>{r.title}</div>
                    <div className="text-[10px] text-zinc-500">{fmtBytes(r.size)} · {r.category} · {r.pubDate ? new Date(r.pubDate).toLocaleDateString() : ""}</div>
                  </div>
                  <button disabled={disabled} onClick={() => onCreate({ source: "indexer", guid: r.guid, title: r.title })} className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs shrink-0 disabled:opacity-50">
                    ▶ stream
                  </button>
                </div>
              ))}
              {!results.length && <div className="text-sm text-zinc-500">nothing found</div>}
            </div>
          )}
        </form>
      )}
      {tab === "url" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate({ source: "url", url });
          }}
          className="flex gap-2"
        >
          <input className={inp} placeholder="https://…/something.nzb  (indexer download links work too)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button disabled={disabled || !url} className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm disabled:opacity-50">
            ▶ stream
          </button>
        </form>
      )}
      {tab === "upload" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = fileRef.current?.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append("file", f);
            void onCreate(fd);
          }}
          className="flex gap-2 items-center"
        >
          <input ref={fileRef} type="file" accept=".nzb,application/x-nzb,text/xml" className="text-sm" />
          <button disabled={disabled} className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm disabled:opacity-50">
            ▶ stream
          </button>
        </form>
      )}
      {tab === "paste" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate({ source: "paste", xml });
          }}
          className="flex flex-col gap-2"
        >
          <textarea className={`${inp} h-32 font-mono text-xs`} placeholder="<?xml … <nzb>…</nzb>" value={xml} onChange={(e) => setXml(e.target.value)} />
          <button disabled={disabled || !xml} className="self-end px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm disabled:opacity-50">
            ▶ stream
          </button>
        </form>
      )}
    </section>
  );
}
