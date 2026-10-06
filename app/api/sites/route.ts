import { clientProxyAllowed } from "@/lib/config";
import { loadSites } from "@/lib/sherlock";

export async function GET() {
  try {
    const { data, source } = await loadSites();
    const sites = Object.entries(data)
      .map(([name, info]) => ({ name, urlMain: info.urlMain, nsfw: info.isNSFW === true }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return Response.json({
      source,
      sites,
      proxy: { clientAllowed: clientProxyAllowed(), serverDefault: Boolean(process.env.SHERLOCK_PROXY?.trim()) },
    });
  } catch (err) {
    return Response.json({ error: `Could not load site data: ${(err as Error).message}` }, { status: 500 });
  }
}
