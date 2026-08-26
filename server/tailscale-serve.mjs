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

/**
 * Tailnet addresses that lead nowhere.
 *
 * Publishing an app on the tailnet records the port it had at the time. Nothing moves that record
 * when the port changes, and "stop publishing" withdraws the app's *current* port — so the moment an
 * app's port changes, its old entry is stranded and the interface can no longer reach it. Pi-hole
 * moving from 8084 to 80 left `https://<host>:8084` proxying to a port nothing answers on, with no
 * way to withdraw it short of the command line.
 *
 * An entry counts as stranded when no installed application publishes the port it forwards to.
 */
export function strandedServes(serves = [], apps = []) {
  const published = new Set();
  for (const app of apps) {
    for (const port of app.ports ?? app.urls ?? []) {
      const value = port.port ?? port.host;
      if (Number.isInteger(value)) published.add(value);
    }
  }
  return serves.filter((serve) => {
    if (!Number.isInteger(serve.port)) return false;
    // The target is what it forwards to; fall back to the published port when it cannot be read.
    const forwarded = Number(String(serve.target ?? "").match(/:(\d+)\s*$/)?.[1] ?? serve.port);
    return !published.has(forwarded) && !published.has(serve.port);
  });
}
