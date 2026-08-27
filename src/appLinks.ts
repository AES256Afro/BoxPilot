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
  // All of ts.net sits on the browsers' HSTS preload list, so this name only ever opens over
  // HTTPS through Serve (handled above). For a plain app port, the short MagicDNS name is the
  // form of the same route a browser will actually follow.
  return `${https ? "https" : "http"}://${host.endsWith(".ts.net") ? host.split(".")[0] : host}:${port.host}${path}`;
}

/** One way to reach an app, with enough context to know whether it will work from where you are. */
export interface AppAddress {
  kind: "tailnet-https" | "tailnet" | "lan" | "loopback";
  label: string;
  url: string;
  /** Why this one might not work from the device you are holding. Null when it should just work. */
  caveat: string | null;
  /** True for the address matching how this page was loaded, which is known to reach the server. */
  reachedThisPageBy: boolean;
}

/**
 * Every address an app can be opened on, rather than one guess.
 *
 * `appUrl` picks a single address from however the browser reached BoxPilot, which is a good guess
 * and silently wrong the moment the two differ. Reaching BoxPilot over Tailscale and being handed
 * a tailnet link for an app that is only published on the LAN gives a dead link with nothing to
 * suggest what to try instead; so does the reverse. The failure looks like a broken app.
 *
 * So: list them, say what each one is, and say plainly when one is not going to work from here.
 */
export function appAddresses(
  port: { host: number; exposure: string; path?: string | null },
  { lanAddress = null, tailnetDnsName = null, serves = [], https = false, browserHost = window.location.hostname }:
  { lanAddress?: string | null; tailnetDnsName?: string | null; serves?: TailnetServe[]; https?: boolean; browserHost?: string } = {},
): AppAddress[] {
  const path = port.path && port.path !== "/" ? (port.path.startsWith("/") ? port.path : `/${port.path}`) : "";
  const scheme = https ? "https" : "http";
  const addresses: AppAddress[] = [];

  // Serve holds the port for HTTPS, so a plain http:// link to it is answered with 400.
  const served = serves.find((serve) => serve.port === port.host);
  if (served) {
    addresses.push({ kind: "tailnet-https", label: "Over Tailscale", url: `https://${served.dnsName}:${served.port}${path}`, caveat: "needs Tailscale running on the device you are using", reachedThisPageBy: false });
  }

  if (port.exposure === "loopback") {
    // Offering a LAN address for a port bound to loopback is offering a link that cannot connect.
    addresses.push({ kind: "loopback", label: "On this server only", url: `${scheme}://127.0.0.1:${port.host}${path}`, caveat: "bound to the server itself; not reachable from other devices", reachedThisPageBy: browserHost === "127.0.0.1" || browserHost === "localhost" });
  } else {
    if (lanAddress) addresses.push({ kind: "lan", label: "On your network", url: `${scheme}://${lanAddress}:${port.host}${path}`, caveat: null, reachedThisPageBy: browserHost === lanAddress });
    // Tailscale put all of ts.net on the browsers' built-in HSTS preload list, so a plain http
    // link on the full name can never open: the browser rewrites it to https and nothing answers.
    // A self-signed https on that name is worse, refused with no bypass. The short MagicDNS name
    // is outside the preload and resolves on every tailnet device, so it is the link that works.
    if (tailnetDnsName && !served) {
      const shortName = tailnetDnsName.split(".")[0];
      addresses.push({ kind: "tailnet", label: "Over Tailscale", url: `${scheme}://${shortName}:${port.host}${path}`, caveat: "needs Tailscale running on the device you are using", reachedThisPageBy: browserHost === tailnetDnsName || browserHost === shortName });
    }
  }

  // However this page was reached is, by definition, a route that works; keep it even if it is
  // neither the LAN address nor the tailnet name (a hostname, an mDNS name, a reverse proxy).
  // Except the full ts.net name: this page arrived on it over HTTPS through Serve, and the HSTS
  // preload above means the same name on a plain app port opens nothing. The short-name entry
  // already covers that device.
  const known = new Set(addresses.map((address) => address.url));
  const fromHere = `${scheme}://${browserHost}:${port.host}${path}`;
  if (browserHost.endsWith(".ts.net")) {
    return addresses;
  }
  // Loopback is the exception: reaching BoxPilot on 127.0.0.1 means sitting at the server, which
  // says nothing about how anything else on the network gets there. Offering it first would put
  // the one address that only works in one place at the top of a list about reaching the app.
  const atTheServer = browserHost === "localhost" || browserHost === "127.0.0.1" || browserHost === "::1" || browserHost === "[::1]";
  if (port.exposure !== "loopback" && browserHost && !atTheServer && !known.has(fromHere) && !addresses.some((address) => address.reachedThisPageBy)) {
    addresses.unshift({ kind: "lan", label: "The way you reached this page", url: fromHere, caveat: null, reachedThisPageBy: true });
  }
  return addresses;
}
