/**
 * Reading `tailscale serve status --json`.
 *
 * Serve publishes a local port on the tailnet over HTTPS at the same port number, with a real
 * certificate. Two places need to know what is published: the Applications page, which offers the
 * switch, and the dashboard sync, which would otherwise link a loopback-only app to an address
 * that only works on the server itself.
 */

/** HTTPS ports proxied to local targets, lowest port first. */
export function parseServeStatus(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  const entries = [];
  for (const [key, config] of Object.entries(parsed?.Web ?? {})) {
    const match = key.match(/^(.+):(\d+)$/);
    if (!match) continue;
    const target = config?.Handlers?.["/"]?.Proxy ?? null;
    entries.push({ dnsName: match[1], port: Number(match[2]), target });
  }
  return entries.sort((a, b) => a.port - b.port);
}
