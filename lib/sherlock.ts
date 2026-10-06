// TypeScript port of the detection logic in sherlock_project/sherlock.py
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";

export type QueryStatus = "Claimed" | "Available" | "Unknown" | "Illegal" | "WAF";

export interface SiteInfo {
  url: string;
  urlMain: string;
  urlProbe?: string;
  username_claimed: string;
  errorType: string | string[];
  errorMsg?: string | string[];
  errorCode?: number | number[];
  regexCheck?: string;
  request_method?: "GET" | "HEAD" | "POST" | "PUT";
  request_payload?: unknown;
  headers?: Record<string, string>;
  isNSFW?: boolean;
}

export type SiteData = Record<string, SiteInfo>;

export interface QueryResult {
  username: string;
  site: string;
  urlMain: string;
  urlUser: string;
  status: QueryStatus;
  httpStatus: number | null;
  queryTimeMs: number | null;
  context: string | null;
}

// Same sources as sherlock_project/sites.py
const MANIFEST_URL = "https://data.sherlockproject.xyz";
const EXCLUSIONS_URL =
  "https://raw.githubusercontent.com/sherlock-project/sherlock/refs/heads/exclusions/false_positive_exclusions.txt";
// Bundled snapshot of the manifest, used when the live one is unreachable
const LOCAL_MANIFEST = path.join(process.cwd(), "data", "sites.json");

// Full browser-like header set; Node's fetch defaults (e.g. sec-fetch-mode: cors) look like a bot
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
// The CLI uses 20 threads; async I/O handles more, and every request goes to a different host
const MAX_WORKERS = 50;
// Error messages and WAF fingerprints sit near the top of a page; no need to download huge bodies
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

// WAF fingerprints copied from sherlock.py
const WAF_HIT_MSGS = [
  ".loading-spinner{visibility:hidden}body.no-js .challenge-running{display:none}body.dark{background-color:#222;color:#d9d9d9}body.dark a{color:#fff}body.dark a:hover{color:#ee730a;text-decoration:underline}body.dark .lds-ring div{border-color:#999 transparent transparent}body.dark .font-red{color:#b20f03}body.dark",
  '<span id="challenge-error-text">',
  "AwsWafIntegration.forceRefreshToken",
  '{return l.onPageView}}),Object.defineProperty(r,"perimeterxIdentifiers",{enumerable:',
];

type CacheEntry = { data: SiteData; source: "remote" | "local"; at: number };
const cache: Record<"default" | "local", CacheEntry | null> = { default: null, local: null };

async function fetchRemoteSites(): Promise<SiteData> {
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Bad response from manifest: ${res.status}`);
  const data = (await res.json()) as SiteData & { $schema?: unknown };
  delete data.$schema;

  try {
    const ex = await fetch(EXCLUSIONS_URL, { signal: AbortSignal.timeout(10_000) });
    if (ex.ok) {
      for (const name of (await ex.text()).split("\n").map((s) => s.trim())) delete data[name];
    }
  } catch {
    // Matches CLI behaviour: continue without exclusions
  }
  return data;
}

async function readLocalSites(): Promise<SiteData> {
  const data = JSON.parse(await readFile(LOCAL_MANIFEST, "utf-8")) as SiteData & { $schema?: unknown };
  delete data.$schema;
  return data;
}

/** Live manifest (with false-positive exclusions), falling back to the repo's data.json. */
export async function loadSites(preferLocal = false): Promise<{ data: SiteData; source: "remote" | "local" }> {
  const key = preferLocal ? "local" : "default";
  const hit = cache[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  let data: SiteData;
  let source: "remote" | "local" = "local";
  if (preferLocal) {
    data = await readLocalSites();
  } else {
    try {
      data = await fetchRemoteSites();
      source = "remote";
    } catch {
      data = await readLocalSites();
    }
  }
  const entry = { data, source, at: Date.now() };
  cache[key] = entry;
  return entry;
}

function interpolate<T>(input: T, username: string): T {
  if (typeof input === "string") return input.replaceAll("{}", username) as T;
  if (Array.isArray(input)) return input.map((i) => interpolate(i, username)) as T;
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, interpolate(v, username)])) as T;
  }
  return input;
}

/** Expand `{?}` into `_`, `-`, `.` variants, like the CLI. */
export function expandUsername(username: string): string[] {
  return username.includes("{?}") ? ["_", "-", "."].map((s) => username.replaceAll("{?}", s)) : [username];
}

/**
 * Builds a dispatcher for an http(s):// or socks5(h):// proxy URL, like the CLI's --proxy.
 * Throws with a user-facing message if the URL is invalid.
 */
export function createProxyDispatcher(raw: string): Dispatcher {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Proxy must be a URL, e.g. socks5://127.0.0.1:9050 or http://host:8080");
  }
  if (!url.hostname || (url.protocol.startsWith("socks") && !url.port)) {
    throw new Error("Proxy URL needs a host and port");
  }
  switch (url.protocol) {
    case "http:":
    case "https:":
      return new ProxyAgent(url.href);
    case "socks5:":
    case "socks5h:":
      return new Socks5ProxyAgent(`socks5://${url.host}`, {
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      });
    default:
      throw new Error(`Unsupported proxy protocol "${url.protocol}" (use http, https or socks5)`);
  }
}

/** Fetches through the proxy dispatcher when one is given, otherwise uses the global fetch. */
function request(url: string, init: RequestInit, dispatcher?: Dispatcher): Promise<FetchResult> {
  if (!dispatcher) return fetch(url, { ...init, cache: "no-store" });
  return undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as Promise<FetchResult>;
}

type FetchResult = { status: number; body: ReadableStream<Uint8Array> | null };

/** Reads at most MAX_BODY_BYTES of the body, then drops the connection instead of downloading the rest. */
async function readBody(res: FetchResult): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (bytes < MAX_BODY_BYTES) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

/** Confirms the proxy can reach the internet, so a dead proxy fails fast instead of erroring on every site. */
export async function checkProxy(dispatcher: Dispatcher): Promise<void> {
  try {
    await request("https://example.com", { method: "HEAD", signal: AbortSignal.timeout(10_000) }, dispatcher);
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new Error(`Proxy is unreachable${cause ? `: ${cause}` : ""}`);
  }
}

const causeCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

function errorContext(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || causeCode(err) === "UND_ERR_CONNECT_TIMEOUT") return "Timeout Error";
    if (err.name === "AbortError") return "Aborted";
    if (causeCode(err) === "ENOTFOUND") return "Site not found (DNS)";
    if (causeCode(err) === "ECONNREFUSED") return "Connection refused";
    return "Error Connecting";
  }
  return "Unknown Error";
}

/** Dropped connections are worth one retry; timeouts and dead hosts (DNS failure, refused) are not. */
function isTransient(err: unknown): boolean {
  return (
    err instanceof Error &&
    !["TimeoutError", "AbortError"].includes(err.name) &&
    !["UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND", "ECONNREFUSED"].includes(causeCode(err) ?? "")
  );
}

async function checkSite(
  username: string,
  site: string,
  info: SiteInfo,
  timeoutMs: number,
  signal: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<QueryResult> {
  const url = interpolate(info.url, username.replaceAll(" ", "%20"));
  const base = { username, site, urlMain: info.urlMain, urlUser: url };

  if (info.regexCheck && !new RegExp(info.regexCheck).test(username)) {
    return { ...base, urlUser: "", status: "Illegal", httpStatus: null, queryTimeMs: null, context: null };
  }

  const errorTypes = Array.isArray(info.errorType) ? info.errorType : [info.errorType];
  const method = info.request_method ?? (errorTypes.includes("status_code") && errorTypes.length === 1 ? "HEAD" : "GET");
  const probe = info.urlProbe ? interpolate(info.urlProbe, username) : url;
  const payload = info.request_payload != null ? interpolate(info.request_payload, username) : undefined;

  const headers: Record<string, string> = { ...BROWSER_HEADERS, ...info.headers };
  if (payload !== undefined) headers["Content-Type"] = "application/json";

  const attempt = async (m: string) => {
    const r = await request(
      probe,
      {
        method: m,
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        redirect: errorTypes.includes("response_url") ? "manual" : "follow",
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
      },
      dispatcher,
    );
    return { status: r.status, text: m === "HEAD" ? "" : await readBody(r) };
  };

  const start = performance.now();
  let res: { status: number; text: string };
  try {
    try {
      res = await attempt(method);
    } catch (err) {
      if (!isTransient(err) || signal.aborted) throw err;
      res = await attempt(method);
    }
    // Some sites refuse HEAD but answer a normal GET
    if (method === "HEAD" && (res.status === 403 || res.status === 405)) {
      const head = res;
      res = await attempt("GET").catch(() => head);
    }
  } catch (err) {
    return { ...base, status: "Unknown", httpStatus: null, queryTimeMs: null, context: errorContext(err) };
  }
  const { text } = res;
  const queryTimeMs = Math.round(performance.now() - start);
  const code = res.status;
  const done = (status: QueryStatus, context: string | null = null): QueryResult => ({
    ...base,
    status,
    httpStatus: code,
    queryTimeMs,
    context,
  });

  if (WAF_HIT_MSGS.some((m) => text.includes(m))) return done("WAF");

  // No manifest entry uses 403/429 to mean "user not found"; they signal bot blocking or rate limiting.
  // Unlike the CLI (which reports these as Available), surface them so results aren't silently wrong.
  const codes = info.errorCode == null ? null : Array.isArray(info.errorCode) ? info.errorCode : [info.errorCode];
  if ((code === 403 || code === 429) && !codes?.includes(code)) {
    return done("WAF", code === 429 ? "Rate limited (HTTP 429)" : "Access denied (HTTP 403)");
  }

  if (errorTypes.some((t) => !["message", "status_code", "response_url"].includes(t))) {
    return done("Unknown", `Unknown error type '${errorTypes}' for ${site}`);
  }

  let status: QueryStatus = "Unknown";
  if (errorTypes.includes("message")) {
    const msgs = info.errorMsg == null ? [] : Array.isArray(info.errorMsg) ? info.errorMsg : [info.errorMsg];
    status = msgs.some((m) => text.includes(m)) ? "Available" : "Claimed";
  }
  if (errorTypes.includes("status_code") && status !== "Available") {
    status = (codes && codes.includes(code)) || code >= 300 || code < 200 ? "Available" : "Claimed";
  }
  if (errorTypes.includes("response_url") && status !== "Available") {
    status = code >= 200 && code < 300 ? "Claimed" : "Available";
  }
  return done(status);
}

/**
 * Runs every username × site check through one worker pool, yielding results as they complete.
 * Sharing the pool means one username's slow sites don't hold up the next username.
 * Tasks are ordered username by username, so the same site is never hit in a burst.
 */
export async function* sherlock(
  usernames: string[],
  sites: SiteData,
  opts: { timeoutMs: number; signal: AbortSignal; dispatcher?: Dispatcher },
): AsyncGenerator<QueryResult> {
  const entries = Object.entries(sites);
  const total = usernames.length * entries.length;
  const queue: QueryResult[] = [];
  let wake: (() => void) | null = null;
  let next = 0;
  let finished = 0;

  const worker = async () => {
    while (next < total && !opts.signal.aborted) {
      const task = next++;
      const username = usernames[Math.floor(task / entries.length)];
      const [site, info] = entries[task % entries.length];
      let result: QueryResult;
      try {
        result = await checkSite(username, site, info, opts.timeoutMs, opts.signal, opts.dispatcher);
      } catch (err) {
        // e.g. invalid regexCheck in manifest
        result = {
          username, site, urlMain: info.urlMain, urlUser: "", status: "Unknown",
          httpStatus: null, queryTimeMs: null, context: err instanceof Error ? err.message : "Unknown Error",
        };
      }
      queue.push(result);
      wake?.();
    }
    finished++;
    wake?.();
  };

  const workers = Math.min(MAX_WORKERS, total);
  for (let i = 0; i < workers; i++) void worker();

  while (true) {
    while (queue.length) yield queue.shift()!;
    if (finished === workers || opts.signal.aborted) return;
    await new Promise<void>((r) => (wake = r));
    wake = null;
  }
}
