import type { Dispatcher } from "undici";
import { clientProxyAllowed } from "@/lib/config";
import { checkProxy, createProxyDispatcher, expandUsername, loadSites, sherlock, type SiteData } from "@/lib/sherlock";

// Letters/digits from any script plus the separators sherlock commonly probes
const USERNAME_RE = /^[\p{L}\p{N}_.\- ]{1,64}$/u;
const MAX_USERNAMES = 10;

interface SearchBody {
  usernames?: unknown;
  sites?: unknown;
  nsfw?: unknown;
  timeout?: unknown;
  local?: unknown;
  proxy?: unknown;
}

function bad(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  let body: SearchBody;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body");
  }

  if (!Array.isArray(body.usernames) || body.usernames.some((u) => typeof u !== "string")) {
    return bad("usernames must be an array of strings");
  }
  const usernames = [...new Set((body.usernames as string[]).map((u) => u.trim()).filter(Boolean).flatMap(expandUsername))];
  if (usernames.length === 0) return bad("Enter at least one username");
  if (usernames.length > MAX_USERNAMES) return bad(`At most ${MAX_USERNAMES} usernames per search`);
  const invalid = usernames.find((u) => !USERNAME_RE.test(u));
  if (invalid !== undefined) return bad(`Invalid username: "${invalid}"`);

  const timeout = body.timeout === undefined ? 60 : Number(body.timeout);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) return bad("timeout must be between 1 and 120 seconds");

  const siteFilter = Array.isArray(body.sites) ? body.sites.filter((s): s is string => typeof s === "string") : [];

  const clientProxy = typeof body.proxy === "string" ? body.proxy.trim() : "";
  if (clientProxy && !clientProxyAllowed()) return bad("Custom proxies are disabled on this server");
  const proxyUrl = clientProxy || process.env.SHERLOCK_PROXY?.trim() || "";

  let all: SiteData;
  try {
    all = (await loadSites(body.local === true)).data;
  } catch (err) {
    return Response.json({ error: `Could not load site data: ${(err as Error).message}` }, { status: 500 });
  }

  let sites: SiteData;
  if (siteFilter.length) {
    const wanted = new Set(siteFilter.map((s) => s.toLowerCase()));
    sites = Object.fromEntries(Object.entries(all).filter(([name]) => wanted.has(name.toLowerCase())));
    if (!Object.keys(sites).length) return bad("None of the selected sites were found");
  } else {
    sites = body.nsfw === true ? all : Object.fromEntries(Object.entries(all).filter(([, i]) => !i.isNSFW));
  }

  // Created last so no early return can leak the proxy's connection pool
  let dispatcher: Dispatcher | undefined;
  if (proxyUrl) {
    try {
      dispatcher = createProxyDispatcher(proxyUrl);
      await checkProxy(dispatcher);
    } catch (err) {
      await dispatcher?.close().catch(() => {});
      return bad((err as Error).message);
    }
  }

  const total = Object.keys(sites).length;
  const encoder = new TextEncoder();
  const line = (obj: unknown) => encoder.encode(JSON.stringify(obj) + "\n");

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const username of usernames) controller.enqueue(line({ type: "start", username, total }));
        for await (const result of sherlock(usernames, sites, { timeoutMs: timeout * 1000, signal: request.signal, dispatcher })) {
          controller.enqueue(line({ type: "result", result }));
        }
        controller.enqueue(line({ type: "done" }));
      } catch (err) {
        controller.enqueue(line({ type: "error", message: (err as Error).message }));
      } finally {
        await dispatcher?.close().catch(() => {});
        try {
          controller.close();
        } catch {
          // client already disconnected
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
