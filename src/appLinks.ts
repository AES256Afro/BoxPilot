/**
 * Where to send a browser to open an application.
 *
 * This lived in two places and drifted: the Applications page and the Overview each built their
 * own link, and fixing one left the other pointing somewhere unreachable.
 */

/** A serve entry from `app.serve.inspect`: a local port published on the tailnet over HTTPS. */
export interface TailnetServe {
  dnsName: string;
  port: number;
}

/**
 * The host to link to.
 *
 * Whatever address this page was loaded from is, by definition, one that reaches this server from
 * where the browser is sitting — so use it. Preferring the server's LAN address meant every link
 * pointed into the LAN however you had reached BoxPilot, and on a box whose firewall only opens
 * the tailnet, none of them could connect. The LAN address is the better guess only when the page
 * itself came from loopback, where the browser's own host says nothing useful.
 */
export function hostForAppLinks(lanAddress: string | null, browserHost = window.location.hostname): string {
  const loopback = browserHost === "localhost" || browserHost === "127.0.0.1" || browserHost === "::1" || browserHost === "[::1]";
  return loopback ? lanAddress ?? browserHost : browserHost;
}

/**
 * The address of one application's web UI.
 *
 * An application published on the tailnet has Tailscale Serve holding that port for HTTPS, so a
 * plain http:// link to it is answered with 400 — it has to be the HTTPS address.
 */
export function appUrl(
  port: { host: number; exposure: string; path?: string | null },
  { lanAddress = null, serves = [], https = false, browserHost = window.location.hostname }:
  { lanAddress?: string | null; serves?: TailnetServe[]; https?: boolean; browserHost?: string } = {},
): string {
  // Some apps keep their sign-in page off the root — Pi-hole answers at /admin/ — and a link that
  // lands on the right page is the difference between "open" and "open, then hunt".
  const path = port.path && port.path !== "/" ? (port.path.startsWith("/") ? port.path : `/${port.path}`) : "";
  const served = serves.find((serve) => serve.port === port.host);
  if (served) return `https://${served.dnsName}:${served.port}${path}`;
  const host = port.exposure === "loopback" ? "127.0.0.1" : hostForAppLinks(lanAddress, browserHost);
  return `${https ? "https" : "http"}://${host}:${port.host}${path}`;
}
