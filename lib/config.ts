/** Visitor-supplied proxies let the server connect anywhere, so production deployments must opt in. */
export function clientProxyAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.SHERLOCK_ALLOW_CLIENT_PROXY === "true";
}
