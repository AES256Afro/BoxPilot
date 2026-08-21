import { writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Tailscale node settings (root side, runs in boxpilot-run@ with network): advertise this
 * server as an exit node and/or as a subnet router for its LAN. Both need IP forwarding, so
 * a sysctl drop-in is written first. Advertising only offers the routes; the owner still
 * approves them in the Tailscale admin console, which the result points at.
 */

export const cidrPattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
export const sysctlPath = "/etc/sysctl.d/99-boxpilot-tailscale.conf";
export const adminUrl = "https://login.tailscale.com/admin/machines";

const binaries = {
  tailscale: process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale",
  sysctl: "/usr/sbin/sysctl",
  ip: "/usr/sbin/ip",
};

export function validateRoutes(routes) {
  if (!Array.isArray(routes) || routes.length > 16) return "routes must be a list of up to 16 IPv4 subnets";
  for (const route of routes) {
    const match = typeof route === "string" ? route.match(cidrPattern) : null;
    if (!match) return `${route} is not an IPv4 subnet like 192.168.1.0/24`;
    const octets = match.slice(1, 5).map(Number);
    const prefix = Number(match[5]);
    if (octets.some((octet) => octet > 255) || prefix < 8 || prefix > 30) return `${route} is not a usable subnet (prefix 8-30)`;
    if (route.startsWith("100.64.") || route.startsWith("100.1") || route.startsWith("127.")) return `${route} cannot be advertised`;
  }
  return null;
}

async function lanSubnets(run) {
  const result = await run(binaries.ip, ["-j", "-4", "route", "show"], { timeout: 10_000 });
  if (!result.ok) return [];
  try {
    return [...new Set(JSON.parse(result.stdout)
      .filter((route) => route.scope === "link" && typeof route.dst === "string" && route.dst.includes("/") && !/^(tailscale|docker|br-|virbr|veth|lo)/.test(route.dev ?? ""))
      .map((route) => route.dst))];
  } catch { return []; }
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

export async function tailscaleSet({ exitNode = false, subnetRouter = false, routes = [] } = {}, { run = fixedRun, log = null, files = { writeFile } } = {}) {
  if (typeof exitNode !== "boolean" || typeof subnetRouter !== "boolean") throw new Error("exitNode and subnetRouter must be true or false");
  const problem = validateRoutes(routes);
  if (problem) throw new Error(`Invalid routes: ${problem}`);
  let advertised = subnetRouter ? (routes.length ? routes : await lanSubnets(run)) : [];
  if (subnetRouter && !advertised.length) throw new Error("Could not determine the LAN subnet to share; specify it explicitly");
  advertised = [...new Set(advertised)];
  if (exitNode || advertised.length) {
    await files.writeFile(sysctlPath, "# Managed by BoxPilot: Tailscale exit node / subnet router need forwarding\nnet.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n", { mode: 0o644 });
    const applied = await run(binaries.sysctl, ["-p", sysctlPath], { timeout: 15_000 });
    if (!applied.ok) throw new Error(`Could not enable IP forwarding: ${tail(applied.stderr)}`);
    log?.("IP forwarding enabled (persisted in /etc/sysctl.d/99-boxpilot-tailscale.conf)", "stdout");
  }
  const args = ["set", `--advertise-exit-node=${exitNode ? "true" : "false"}`, `--advertise-routes=${advertised.join(",")}`];
  log?.(`$ tailscale ${args.join(" ")}`, "stdout");
  const result = await run(binaries.tailscale, args, { timeout: 60_000 });
  if (!result.ok) throw new Error(`tailscale set failed: ${tail(result.stderr) || tail(result.stdout)}`);
  const status = await run(binaries.tailscale, ["status", "--json"], { timeout: 15_000 });
  let exitNodeOption = null; let dnsName = null;
  try { const parsed = JSON.parse(status.stdout); exitNodeOption = Boolean(parsed.Self?.ExitNodeOption); dnsName = parsed.Self?.DNSName?.replace(/\.$/, "") ?? null; } catch { /* best effort */ }
  log?.(`${exitNode ? "Exit node offered" : "Exit node withdrawn"}; ${advertised.length ? `routes offered: ${advertised.join(", ")}` : "no routes offered"}. Approve them in the Tailscale admin console.`, "stdout");
  return { exitNode, routes: advertised, exitNodeOption, dnsName, approvalNeeded: exitNode || advertised.length > 0, adminUrl };
}
