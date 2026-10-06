"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { QueryResult, QueryStatus } from "@/lib/sherlock";

type Site = { name: string; urlMain: string; nsfw: boolean };
type Filter = "found" | "all" | "issues";
// Sites to check per username; progress is the number of results received against the sum
type Progress = Record<string, number>;

const resultKey = (r: QueryResult) => `${r.username}:${r.site}`;
const isFailed = (r: QueryResult) => r.status === "Unknown" || r.status === "WAF";

const STATUS_STYLE: Record<QueryStatus, { label: string; cls: string }> = {
  Claimed: { label: "Found", cls: "bg-accent-soft text-accent" },
  Available: { label: "Not found", cls: "bg-border/60 text-muted" },
  Unknown: { label: "Error", cls: "bg-danger/10 text-danger" },
  Illegal: { label: "Invalid format", cls: "bg-warn/10 text-warn" },
  WAF: { label: "Blocked", cls: "bg-warn/10 text-warn" },
};

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export default function SherlockApp() {
  const [input, setInput] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [local, setLocal] = useState(false);
  const [timeout, setTimeoutSec] = useState(15);
  const [showOptions, setShowOptions] = useState(false);
  const [proxy, setProxy] = useState("");
  const [proxyConfig, setProxyConfig] = useState({ clientAllowed: false, serverDefault: false });

  const [sites, setSites] = useState<Site[]>([]);
  const [siteSource, setSiteSource] = useState<string>("");
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set());
  const [siteQuery, setSiteQuery] = useState("");

  const [results, setResults] = useState<QueryResult[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [running, setRunning] = useState(false);
  const [retrying, setRetrying] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("found");
  const [textFilter, setTextFilter] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/sites")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setSites(d.sites);
        setSiteSource(d.source);
        setProxyConfig(d.proxy);
      })
      .catch((e) => setError(e.message));
  }, []);

  const usernames = useMemo(
    () => input.split(/[,\s]+/).map((u) => u.trim()).filter(Boolean),
    [input],
  );

  // Streams one /api/search request; results replace any earlier result for the same username + site.
  async function stream(job: { usernames: string[]; sites: string[] }, signal: AbortSignal, isRetry: boolean) {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...job, nsfw, local, timeout, proxy: proxy.trim() || undefined }),
      signal,
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? `Request failed (${res.status})`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const batch = new Map<string, QueryResult>();
      for (const raw of lines) {
        if (!raw) continue;
        const msg = JSON.parse(raw);
        if (msg.type === "start") {
          if (!isRetry) setProgress((p) => ({ ...p, [msg.username]: msg.total }));
        } else if (msg.type === "result") {
          batch.set(resultKey(msg.result), msg.result);
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      }
      if (batch.size) {
        setResults((prev) => [...prev.filter((r) => !batch.has(resultKey(r))), ...batch.values()]);
        if (isRetry) setRetrying((n) => Math.max(0, n - batch.size));
      }
    }
  }

  async function run(jobs: { usernames: string[]; sites: string[] }[], isRetry: boolean) {
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setRunning(true);
    try {
      for (const job of jobs) await stream(job, controller.signal, isRetry);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
      setRetrying(0);
      abortRef.current = null;
    }
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    if (!usernames.length || running) return;
    setResults([]);
    setProgress({});
    void run([{ usernames, sites: [...selectedSites] }], false);
  }

  // Re-checks only the blocked/errored sites, one request per username (each has its own failed set).
  function retryFailed() {
    if (running) return;
    const failed = new Map<string, string[]>();
    for (const r of results) {
      if (isFailed(r)) failed.set(r.username, [...(failed.get(r.username) ?? []), r.site]);
    }
    if (!failed.size) return;
    setRetrying([...failed.values()].reduce((n, s) => n + s.length, 0));
    void run([...failed].map(([username, sites]) => ({ usernames: [username], sites })), true);
  }

  const counts = useMemo(() => {
    const c = { found: 0, notFound: 0, issues: 0 };
    for (const r of results) {
      if (r.status === "Claimed") c.found++;
      else if (r.status === "Available") c.notFound++;
      else c.issues++;
    }
    return c;
  }, [results]);

  const visible = useMemo(() => {
    const q = textFilter.toLowerCase();
    return results
      .filter((r) =>
        filter === "found" ? r.status === "Claimed"
        : filter === "issues" ? !["Claimed", "Available"].includes(r.status)
        : true,
      )
      .filter((r) => !q || r.site.toLowerCase().includes(q))
      .sort((a, b) => a.username.localeCompare(b.username) || a.site.localeCompare(b.site, undefined, { sensitivity: "base" }));
  }, [results, filter, textFilter]);

  const failedCount = useMemo(() => results.filter(isFailed).length, [results]);
  const totals = { total: Object.values(progress).reduce((a, n) => a + n, 0), done: results.length };
  const pct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;

  const filteredSites = useMemo(() => {
    const q = siteQuery.toLowerCase();
    return sites.filter((s) => (nsfw || !s.nsfw || selectedSites.has(s.name)) && (!q || s.name.toLowerCase().includes(q)));
  }, [sites, siteQuery, nsfw, selectedSites]);

  const stamp = () => (usernames.length === 1 ? usernames[0] : "sherlock") + "-" + new Date().toISOString().slice(0, 10);

  function exportCsv() {
    const header = ["username", "name", "url_main", "url_user", "exists", "http_status", "response_time_s"];
    const rows = visible.map((r) =>
      [r.username, r.site, r.urlMain, r.urlUser, r.status, r.httpStatus ?? "", r.queryTimeMs == null ? "" : r.queryTimeMs / 1000]
        .map(csvCell).join(","),
    );
    download(`${stamp()}.csv`, [header.join(","), ...rows].join("\n"), "text/csv");
  }

  function exportTxt() {
    const found = visible.filter((r) => r.status === "Claimed");
    download(`${stamp()}.txt`, [...found.map((r) => r.urlUser), `Total Websites Username Detected On : ${found.length}`].join("\n"), "text/plain");
  }

  function exportJson() {
    download(`${stamp()}.json`, JSON.stringify(visible, null, 2), "application/json");
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:py-16">
      <header className="mb-10 text-center">
        <h1 className="font-mono text-4xl font-bold tracking-tight sm:text-5xl">
          <span className="text-accent">$</span> sherlock
        </h1>
        <p className="mt-3 text-muted">
          Hunt down social media accounts by username across{" "}
          <span className="font-semibold text-foreground">{sites.length || "400+"}</span> social networks.
        </p>
      </header>

      <form onSubmit={search} className="rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-muted">@</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="username, another_user, john{?}doe"
              aria-label="Usernames"
              className="w-full rounded-lg border border-border bg-background py-3 pl-8 pr-3 font-mono outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
              autoFocus
            />
          </div>
          {running ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-danger px-6 py-3 font-medium text-danger hover:bg-danger/10"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!usernames.length}
              className="rounded-lg bg-accent px-6 py-3 font-medium text-black hover:opacity-90 disabled:opacity-40"
            >
              Search
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <span>
            Separate multiple usernames with commas. <code className="font-mono">{"{?}"}</code> tries <code className="font-mono">_ - .</code> variants.
          </span>
          <button type="button" onClick={() => setShowOptions((s) => !s)} className="hover:text-foreground">
            {showOptions ? "Hide options ▲" : "Options ▼"}
          </button>
        </div>

        {showOptions && (
          <div className="mt-4 grid gap-6 border-t border-border pt-4 md:grid-cols-[220px_1fr]">
            <div className="space-y-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} className="accent-[var(--accent)]" />
                Include NSFW sites
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} className="accent-[var(--accent)]" />
                Use local data.json
              </label>
              <label className="block">
                <span className="mb-1 block">Timeout: {timeout}s</span>
                <input
                  type="range" min={5} max={120} step={5} value={timeout}
                  onChange={(e) => setTimeoutSec(Number(e.target.value))}
                  className="w-full accent-[var(--accent)]"
                />
              </label>
              {proxyConfig.clientAllowed && (
                <label className="block">
                  <span className="mb-1 block">Proxy</span>
                  <input
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    placeholder={proxyConfig.serverDefault ? "Server default" : "socks5://127.0.0.1:9050"}
                    spellCheck={false}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                  />
                  <span className="mt-1 block text-xs text-muted">http(s) or socks5. Tor: socks5://127.0.0.1:9050</span>
                </label>
              )}
              {!proxyConfig.clientAllowed && proxyConfig.serverDefault && (
                <p className="text-xs text-muted">Requests go through the server&apos;s proxy.</p>
              )}
              {siteSource && <p className="text-xs text-muted">Site list:{siteSource === "remote" ? "live manifest" : "local data.json"}</p>}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between gap-2 text-sm">
                <span>
                  Limit to sites{" "}
                  <span className="text-muted">({selectedSites.size ? `${selectedSites.size} selected` : "all"})</span>
                </span>
                {selectedSites.size > 0 && (
                  <button type="button" onClick={() => setSelectedSites(new Set())} className="text-muted hover:text-foreground">
                    Clear
                  </button>
                )}
              </div>
              <input
                value={siteQuery}
                onChange={(e) => setSiteQuery(e.target.value)}
                placeholder="Filter sites…"
                className="mb-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                {filteredSites.map((s) => {
                  const on = selectedSites.has(s.name);
                  return (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() =>
                        setSelectedSites((prev) => {
                          const next = new Set(prev);
                          if (on) next.delete(s.name);
                          else next.add(s.name);
                          return next;
                        })
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${
                        on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </form>

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {(running || results.length > 0) && (
        <section className="mt-8">
          <div className="mb-4">
            <div className="mb-1.5 flex justify-between text-sm text-muted">
              <span>
                {running ? "Checking" : "Checked"} {Object.keys(progress).map((u) => `@${u}`).join(", ")}
              </span>
              <span className="font-mono">
                {totals.done}/{totals.total} · {pct}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
              <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="mb-4 grid grid-cols-3 gap-3">
            {[
              { k: "found" as const, label: "Found", n: counts.found, cls: "text-accent" },
              { k: "all" as const, label: "Checked", n: results.length, cls: "text-foreground" },
              { k: "issues" as const, label: "Errors / blocked", n: counts.issues, cls: "text-warn" },
            ].map((s) => (
              <button
                key={s.k}
                onClick={() => setFilter(s.k)}
                className={`rounded-xl border bg-surface p-4 text-left transition ${filter === s.k ? "border-accent" : "border-border hover:border-muted"}`}
              >
                <div className={`font-mono text-2xl font-bold ${s.cls}`}>{s.n}</div>
                <div className="text-sm text-muted">{s.label}</div>
              </button>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              placeholder="Filter results…"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            {failedCount > 0 && (
              <button
                disabled={running}
                onClick={retryFailed}
                title="Re-check blocked and errored sites. Set a proxy in Options to route the retry differently."
                className="rounded-md border border-warn/50 bg-surface px-3 py-2 text-xs text-warn hover:bg-warn/10 disabled:opacity-40"
              >
                {retrying > 0 ? `Retrying ${retrying}…` : `Retry ${failedCount} failed`}
              </button>
            )}
            {(["csv", "txt", "json"] as const).map((f) => (
              <button
                key={f}
                disabled={!visible.length}
                onClick={f === "csv" ? exportCsv : f === "txt" ? exportTxt : exportJson}
                className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs uppercase text-muted hover:text-foreground disabled:opacity-40"
              >
                {f}
              </button>
            ))}
          </div>

          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {visible.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted">{running ? "Searching…" : "No results match this view."}</li>
            )}
            {visible.map((r) => {
              const st = STATUS_STYLE[r.status];
              return (
                <li key={`${r.username}:${r.site}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <a href={r.urlMain} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                        {r.site}
                      </a>
                      {Object.keys(progress).length > 1 && <span className="font-mono text-xs text-muted">@{r.username}</span>}
                    </div>
                    {r.status === "Claimed" ? (
                      <a
                        href={r.urlUser}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-mono text-sm text-accent hover:underline"
                      >
                        {r.urlUser}
                      </a>
                    ) : (
                      r.context && <div className="truncate text-sm text-muted">{r.context}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 font-mono text-xs text-muted">
                    {r.queryTimeMs != null && <span>{r.queryTimeMs}ms</span>}
                    {r.httpStatus != null && <span>HTTP {r.httpStatus}</span>}
                    <span className={`rounded-full px-2 py-0.5 font-sans font-medium ${st.cls}`}>{st.label}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="mt-16 text-center text-xs text-muted">
        Web interface for the{" "}
        <a href="https://sherlockproject.xyz" className="underline hover:text-foreground" target="_blank" rel="noopener noreferrer">
          Sherlock Project
        </a>
        . Results may include false positives — verify before relying on them.
      </footer>
    </main>
  );
}
