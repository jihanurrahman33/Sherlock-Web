# Sherlock Web

Next.js web interface for [Sherlock](https://github.com/sherlock-project/sherlock). It searches for a username across 400+ social networks.

```bash
npm install
npm run dev      # http://localhost:3000
```

## How it works

- `lib/sherlock.ts`: TypeScript port of Sherlock's detection logic (`message`, `status_code` and `response_url` checks, WAF fingerprints, `regexCheck`, `{?}` expansion).
- Site list: the live manifest (`data.sherlockproject.xyz`) with upstream false-positive exclusions, the same source the CLI uses. It falls back to the bundled snapshot in `data/sites.json`. The list is cached in memory for 1 hour.
- `POST /api/search`: streams results as NDJSON while sites respond.
  Body: `{ usernames: string[], sites?: string[], nsfw?: boolean, local?: boolean, timeout?: number, proxy?: string }`
- `GET /api/sites`: the list of supported sites, plus the proxy settings.

### Differences from the CLI

- HTTP 403/429 responses are reported as **Blocked** instead of "not found". No site in the manifest uses those codes to mean "no such user".
- Requests send a full browser header set instead of only a User-Agent.
- Dropped connections are retried once, and sites that refuse a HEAD request are re-checked with GET. "Retry failed" re-checks only blocked or errored sites, using the current proxy setting.
- 50 checks run at once (the CLI uses 20), all usernames share one worker pool, and at most 2 MB of each page is read. The default timeout is 15s (the CLI uses 60s).

## Proxy / Tor

Many sites block requests by IP or network fingerprint (about 1 in 5 from a typical connection). Sending requests through a proxy or Tor can get past this.

- **Per search:** Options → Proxy, e.g. `socks5://127.0.0.1:9050` (Tor) or `http://user:pass@host:8080`.
- **Server-wide default:** `SHERLOCK_PROXY=socks5://127.0.0.1:9050 npm run dev`

The proxy is checked before a search starts, so a dead proxy fails immediately.

A visitor-supplied proxy lets the server open connections to any host. So in production (`next start`), the Proxy field is disabled unless you set `SHERLOCK_ALLOW_CLIENT_PROXY=true`. Only set it when the app isn't publicly reachable.

## CLI flag equivalents

| CLI | Web |
| --- | --- |
| `--site` | Options → Limit to sites |
| `--nsfw` | Options → Include NSFW sites |
| `--local` | Options → Use local data.json (`data/sites.json`) |
| `--timeout` | Options → Timeout slider |
| `--proxy` | Options → Proxy, or `SHERLOCK_PROXY` |
| `--print-all` | "Checked" tab |
| `--csv` / `--txt` | CSV / TXT / JSON export buttons |
