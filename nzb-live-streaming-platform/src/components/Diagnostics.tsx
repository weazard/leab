"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiagEvent, DiagStats } from "@/lib/usenet/diag";
import { fmtBytes } from "./Player";

interface FileMap {
  index: number;
  name: string;
  segments: number;
  states: string;
  partSize: number;
  size: number;
}
interface Snapshot {
  stats: DiagStats & { poolSize: number; poolBusy: number };
  lastSeq: number;
  files: FileMap[];
}

const LEVEL_CLS: Record<string, string> = {
  debug: "text-zinc-500",
  info: "text-zinc-200",
  warn: "text-amber-300",
  error: "text-red-400",
};
const CAT_CLS: Record<string, string> = {
  nntp: "bg-sky-900/60 text-sky-200",
  segment: "bg-emerald-900/60 text-emerald-200",
  range: "bg-violet-900/60 text-violet-200",
  archive: "bg-orange-900/60 text-orange-200",
  analyze: "bg-teal-900/60 text-teal-200",
  session: "bg-zinc-700 text-zinc-200",
  cache: "bg-pink-900/60 text-pink-200",
  indexer: "bg-yellow-900/60 text-yellow-200",
};

export function Diagnostics({ sessionId, extra }: { sessionId: string; extra: string[] }) {
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [minLevel, setMinLevel] = useState<"debug" | "info" | "warn" | "error">("debug");
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    setEvents([]);
    lastSeq.current = 0;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const push = (e: DiagEvent) => {
      if (e.seq <= lastSeq.current) return;
      lastSeq.current = e.seq;
      setEvents((prev) => {
        const next = prev.length > 2500 ? prev.slice(-2000) : prev.slice();
        next.push(e);
        return next;
      });
    };
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/sessions/${sessionId}/diag?snapshot=1&since=${lastSeq.current}`);
          if (!r.ok) return;
          const j = (await r.json()) as Snapshot & { events: DiagEvent[] };
          setSnap(j);
          j.events.forEach(push);
          setConnected(true);
        } catch {
          setConnected(false);
        }
      }, 1500);
    };
    try {
      es = new EventSource(`/api/sessions/${sessionId}/diag?since=0`);
      es.addEventListener("snapshot", (ev) => {
        setSnap(JSON.parse((ev as MessageEvent).data));
        setConnected(true);
      });
      es.addEventListener("log", (ev) => push(JSON.parse((ev as MessageEvent).data)));
      es.onerror = () => {
        setConnected(false);
        // platforms that buffer streaming responses: fall back to polling
        if (es && es.readyState === EventSource.CLOSED) startPolling();
      };
    } catch {
      startPolling();
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [sessionId]);

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, autoScroll]);

  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const visible = useMemo(() => {
    const f = filter.toLowerCase();
    return events.filter((e) => order[e.level] >= order[minLevel] && (!f || e.msg.toLowerCase().includes(f) || e.cat.includes(f)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, minLevel, filter]);

  const st = snap?.stats;
  const errors = events.filter((e) => e.level === "error").length;
  const warns = events.filter((e) => e.level === "warn").length;
  const activeFiles = (snap?.files ?? []).filter((f) => /[123]/.test(f.states));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-200 text-xs flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-500"}`} />
        <span className="font-semibold text-sm">Diagnostics</span>
        <span className="text-zinc-500">{connected ? "live" : "reconnecting…"}</span>
        <div className="grow" />
        <span className="px-2 py-0.5 rounded bg-red-950 text-red-300">{errors} errors</span>
        <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-300">{warns} warnings</span>
      </div>

      {st && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <Stat label="connections" value={`${st.poolBusy}/${st.poolSize} busy`} sub={`${st.connectionsOpenedTotal} opened`} />
          <Stat label="segments ok" value={String(st.segmentsOk)} sub={`${st.segmentsRetried} retries`} />
          <Stat label="segments failed" value={String(st.segmentsFailed)} sub={`${st.crcErrors} crc errors`} bad={st.segmentsFailed > 0 || st.crcErrors > 0} />
          <Stat label="downloaded" value={fmtBytes(st.bytesDownloaded)} sub={`${fmtBytes(st.bytesDecoded)} decoded`} />
          <Stat label="served" value={fmtBytes(st.bytesServed)} sub={`${st.activeStreams} active stream(s)`} />
          <Stat label="cache" value={fmtBytes(st.cacheBytes)} sub={`${st.cacheHits} hit / ${st.cacheMisses} miss`} />
          <Stat label="uptime" value={`${Math.round((Date.now() - st.startedAt) / 1000)}s`} sub={`idle ${Math.round((Date.now() - st.lastActivity) / 1000)}s`} />
          <Stat label="last error" value={st.lastError ? "yes" : "none"} sub={st.lastError?.slice(0, 40) ?? ""} bad={!!st.lastError} />
        </div>
      )}

      {activeFiles.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-zinc-400 uppercase tracking-wide text-[10px]">Segment map (■ fetched · ■ in flight · ■ failed · ■ not requested)</div>
          {activeFiles.map((f) => (
            <SegmentMap key={f.index} f={f} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select value={minLevel} onChange={(e) => setMinLevel(e.target.value as typeof minLevel)} className="bg-zinc-800 rounded px-2 py-1">
          <option value="debug">debug+</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">errors</option>
        </select>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter (nntp, segment, range, archive, crc, 430…)" className="bg-zinc-800 rounded px-2 py-1 grow min-w-[200px]" />
        <label className="flex items-center gap-1 text-zinc-400">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> autoscroll
        </label>
        <button onClick={() => setEvents([])} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">
          clear
        </button>
        <span className="text-zinc-500">{visible.length} / {events.length}</span>
      </div>

      <div ref={logRef} className="h-72 overflow-auto rounded bg-black/60 border border-zinc-800 font-mono p-2 leading-5">
        {extra.map((m, i) => (
          <div key={`x${i}`} className="text-fuchsia-300">
            <span className="text-zinc-600">[browser]</span> {m}
          </div>
        ))}
        {visible.map((e) => (
          <div key={e.seq} className={`${LEVEL_CLS[e.level]} break-all cursor-pointer hover:bg-zinc-900/60`} onClick={() => setExpanded(expanded === e.seq ? null : e.seq)}>
            <span className="text-zinc-600">{new Date(e.t).toLocaleTimeString([], { hour12: false })}.{String(e.t % 1000).padStart(3, "0")}</span>{" "}
            <span className={`px-1 rounded ${CAT_CLS[e.cat] ?? "bg-zinc-800"}`}>{e.cat}</span> <span>{e.msg}</span>
            {expanded === e.seq && e.data && <pre className="text-zinc-400 whitespace-pre-wrap pl-4">{JSON.stringify(e.data, null, 1)}</pre>}
          </div>
        ))}
        {!visible.length && <div className="text-zinc-600">waiting for events…</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1.5 border ${bad ? "border-red-900 bg-red-950/30" : "border-zinc-800 bg-zinc-900/60"}`}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500 truncate">{sub}</div>}
    </div>
  );
}

function SegmentMap({ f }: { f: FileMap }) {
  const n = f.states.length;
  const maxCells = 600;
  const cells: number[] = [];
  if (n <= maxCells) for (let i = 0; i < n; i++) cells.push(Number(f.states[i]));
  else {
    // aggregate: worst state in the bucket (error > inflight > ok > none)
    const per = n / maxCells;
    for (let c = 0; c < maxCells; c++) {
      let worst = 0;
      for (let i = Math.floor(c * per); i < Math.min(n, Math.floor((c + 1) * per)); i++) {
        const s = Number(f.states[i]);
        const rank = s === 3 ? 3 : s === 1 ? 2 : s === 2 ? 1 : 0;
        if (rank > worst) worst = rank;
      }
      cells.push(worst === 3 ? 3 : worst === 2 ? 1 : worst === 1 ? 2 : 0);
    }
  }
  const done = [...f.states].filter((c) => c === "2").length;
  const failed = [...f.states].filter((c) => c === "3").length;
  const color = ["bg-zinc-800", "bg-sky-400", "bg-emerald-500", "bg-red-500"];
  return (
    <div>
      <div className="flex justify-between text-zinc-400">
        <span className="truncate max-w-[70%]">{f.name}</span>
        <span>
          {done}/{n} segs{failed ? ` · ${failed} failed` : ""} · {fmtBytes(f.size)}
        </span>
      </div>
      <div className="flex flex-wrap gap-px mt-1">
        {cells.map((s, i) => (
          <span key={i} className={`inline-block w-1.5 h-2 ${color[s]}`} />
        ))}
      </div>
    </div>
  );
}
