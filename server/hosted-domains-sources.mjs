/**
 * Where public names are routed on this server, read from files (M42.2): a cloudflared config file
 * for a tunnel the owner set up by hand (its `ingress:` rules, one hostname to one service), and
 * Nginx Proxy Manager's generated site files (one `server_name` to one upstream). Both live under
 * root-owned directories, so the helper reads them (internal-reads.mjs, hosted-domains.sources);
 * only hostnames and the local addresses they go to leave it, never a token or a certificate.
 *
 * Parsing is pure and tolerant: a file that is not what it looks like yields nothing, not an error.
 */
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { hostnamePattern } from "./cloudflare-tunnel.mjs";

const catalogRoot = () => process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog";

/** Where a hand-made cloudflared keeps its config, and where the catalog's app would mount one. */
export const cloudflaredConfigCandidates = () => [
  "/etc/cloudflared/config.yml", "/etc/cloudflared/config.yaml",
  path.join(catalogRoot(), "cloudflared", "config.yml"), path.join(catalogRoot(), "cloudflared", "config.yaml"),
  path.join(catalogRoot(), "cloudflared", "data", "config.yml"), path.join(catalogRoot(), "cloudflared", "data", "config.yaml"),
];
/** Nginx Proxy Manager writes one file per proxy host here. */
export const proxyHostDirectories = () => [path.join(catalogRoot(), "nginx-proxy-manager", "data", "nginx", "proxy_host")];

/**
 * What one file may contribute (M53.2). The file count was capped at 200 and the contents of a file
 * were not, so one `server_name` with 200,000 names parsed to 4.3 MB of JSON and 50,000 `ingress`
 * rules to 4.1 MB. The helper reply is capped at 32 MiB, so a configuration big enough took the
 * whole read with it and the page lost every file-derived name to a message about bytes. A cut list
 * says it was cut.
 */
export const maxNamesPerFile = 500;
export const maxRulesPerFile = 500;
/** And how much of a file is read at all: these are config files of kilobytes. Parsing 50,000
 * ingress rules cost 454 ms of the event loop before the rule cap could apply, because the YAML is
 * parsed whole. */
export const maxSourceBytes = 2 * 1024 * 1024;

const text = (value, limit = 253) => (typeof value === "string" && value.trim() && value.length <= limit ? value.trim() : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lower = (value) => String(value).toLowerCase().replace(/\.$/, "");

/**
 * The ingress rules of a cloudflared config: `{ hostname, service }` for every rule that names a
 * hostname, in order; the catch-all and `http_status:` services are not names. A wildcard rule
 * (`*.example.com`) is kept as it is written: the page says it cannot check a wildcard.
 */
export function parseCloudflaredConfig(source) {
  if (String(source ?? "").length > maxSourceBytes) return { tunnel: null, ingress: [], cut: true };
  let parsed;
  try { parsed = parseYaml(String(source ?? "")); } catch { return { tunnel: null, ingress: [], cut: false }; }
  if (!isObject(parsed)) return { tunnel: null, ingress: [], cut: false };
  const ingress = [];
  let cut = false;
  for (const rule of Array.isArray(parsed.ingress) ? parsed.ingress : []) {
    if (!isObject(rule)) continue;
    const hostname = text(rule.hostname);
    const service = text(rule.service, 300);
    if (!hostname || !service) continue;
    const wildcard = hostname.startsWith("*.");
    const bare = wildcard ? hostname.slice(2) : hostname;
    if (!hostnamePattern.test(lower(bare))) continue;
    if (/^http_status:/.test(service)) continue;
    if (ingress.length >= maxRulesPerFile) { cut = true; break; }
    ingress.push({ hostname: lower(hostname), service, wildcard });
  }
  return { tunnel: text(parsed.tunnel, 64), ingress, cut };
}

/**
 * One of Nginx Proxy Manager's generated site files: the names it answers (`server_name`) and the
 * upstream it forwards to (`set $forward_scheme`, `set $server`, `set $port`). A redirection or
 * 404 host has no upstream and is left out.
 */
export function parseProxyHostConfig(source) {
  const body = String(source ?? "");
  if (body.length > maxSourceBytes) return { hostnames: [], target: null, cut: true };
  const names = new Set();
  let cut = false;
  for (const match of body.matchAll(/^\s*server_name\s+([^;]+);/gm)) {
    for (const name of match[1].split(/\s+/)) {
      const clean = lower(name.trim());
      if (!clean || !hostnamePattern.test(clean.startsWith("*.") ? clean.slice(2) : clean)) continue;
      if (names.size >= maxNamesPerFile && !names.has(clean)) { cut = true; break; }
      names.add(clean);
    }
    if (cut) break;
  }
  const setting = (name) => { const match = new RegExp(`^\\s*set\\s+\\$${name}\\s+"?([^";\\s]+)"?\\s*;`, "m").exec(body); return match ? match[1] : null; };
  const scheme = setting("forward_scheme") ?? "http";
  const server = setting("server");
  const port = setting("port");
  const target = server && port && /^\d{1,5}$/.test(port) && ["http", "https"].includes(scheme) ? `${scheme}://${server}:${port}` : null;
  return { hostnames: [...names], target, cut };
}

/**
 * Every routed name the files on this server know of. Missing files and directories are the normal
 * case (no hand-made tunnel, no proxy manager) and are simply absent from the answer.
 * @param {{ cloudflaredFiles?: string[], proxyDirectories?: string[], files?: { readFile: typeof fsReadFile, readdir: typeof fsReaddir } }} [options]
 */
export async function readHostedSources({ cloudflaredFiles = cloudflaredConfigCandidates(), proxyDirectories = proxyHostDirectories(), files = { readFile: fsReadFile, readdir: fsReaddir } } = {}) {
  const cloudflared = [];
  for (const file of cloudflaredFiles) {
    let source;
    try { source = await files.readFile(file, "utf8"); } catch { continue; }
    const parsed = parseCloudflaredConfig(source);
    if (parsed.ingress.length) cloudflared.push({ file, tunnel: parsed.tunnel, ingress: parsed.ingress, cut: parsed.cut });
  }
  const proxyHosts = [];
  for (const directory of proxyDirectories) {
    let entries;
    try { entries = await files.readdir(directory); } catch { continue; }
    for (const name of entries.filter((entry) => /^[\w.-]+\.conf$/.test(entry)).sort().slice(0, 200)) {
      const file = path.join(directory, name);
      let source;
      try { source = await files.readFile(file, "utf8"); } catch { continue; }
      const parsed = parseProxyHostConfig(source);
      if (parsed.hostnames.length) proxyHosts.push({ file, hostnames: parsed.hostnames, target: parsed.target, cut: parsed.cut });
    }
  }
  return { cloudflared, proxyHosts };
}
