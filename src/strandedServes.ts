/**
 * Tailnet addresses that lead nowhere.
 *
 * Publishing an app on the tailnet records the port it had at the time, and nothing moves that
 * record when the port changes. "Stop publishing" withdraws the port the app has *now* — so the
 * moment a port changes, the old entry is stranded and cannot be reached from the interface at all.
 * Pi-hole moving from 8084 to 80 left `https://<host>:8084` forwarding to a dead port with no way
 * to withdraw it short of the command line.
 *
 * Mirrored in `server/tailscale-serve.mjs`; `strandedServes.test.ts` runs both over the same cases,
 * because the browser must not import server code and two copies drift the moment nothing checks.
 */
export interface Serve { dnsName: string; port: number; target: string | null }
export interface PortBearing { ports?: Array<{ port?: number }>; urls?: Array<{ host?: number }> }

export function strandedServes(serves: Serve[] = [], apps: PortBearing[] = []): Serve[] {
  const published = new Set<number>();
  for (const app of apps) {
    for (const port of app.ports ?? app.urls ?? []) {
      const value = (port as { port?: number; host?: number }).port ?? (port as { host?: number }).host;
      if (Number.isInteger(value)) published.add(value as number);
    }
  }
  return serves.filter((serve) => {
    if (!Number.isInteger(serve.port)) return false;
    const forwarded = Number(String(serve.target ?? "").match(/:(\d+)\s*$/)?.[1] ?? serve.port);
    return !published.has(forwarded) && !published.has(serve.port);
  });
}
