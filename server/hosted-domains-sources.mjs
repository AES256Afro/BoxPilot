/**
 * Where public names are routed on this server, read from files (M42.2): a cloudflared config file
 * for a tunnel the owner set up by hand (its `ingress:` rules, one hostname to one service), and
 * Nginx Proxy Manager's generated site files (one `server_name` to one upstream). Both live under
 * root-owned directories, so the helper reads them (internal-reads.mjs, hosted-domains.sources);
 * only hostnames and the local addresses they go to leave it, never a token or a certificate.
 *
 * Parsing is pure and tolerant: a file that is not what it looks like yields nothing, not an error.
 *
 * The proxy manager's files and the catalog's cloudflared folder are an app's data: a container
 * writes them, and root reads them here. So nothing in them is trusted to be a small text file.
 * Only a regular file is opened, never through a link, never one that could block the read or has
 * no end; a file over the size limit is passed over; and the files read, the names taken from each
 * and the names in all are counted and capped.
 */
import { constants as fsConstants } from "node:fs";
import { lstat as fsLstat, open as fsOpen, opendir as fsOpendir, realpath as fsRealpath } from "node:fs/promises";
import { isIP } from "node:net";
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

/** What one read will take: a config or site file's size, the site files in a folder (and the entries looked through to find them), and the names kept. */
export const sourceLimits = Object.freeze({ fileBytes: 256 * 1024, proxyFiles: 500, directoryEntries: 5000, namesPerFile: 32, names: 200 });
/** An upstream as the proxy manager writes one: a bare host name (a container's, or a dotted one), no port, path or anything else inside it. */
const upstreamNamePattern = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/i;

const text = (value, limit = 253) => (typeof value === "string" && value.trim() && value.length <= limit ? value.trim() : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lower = (value) => String(value).toLowerCase().replace(/\.$/, "");

/** A service address cut back to scheme, host and port: a path, a query or a name and password in one never leaves the helper. Null for what is not an address (a socket, `hello_world`). */
function serviceOrigin(service) {
  try {
    const url = new URL(service);
    return url.host ? `${url.protocol}//${url.host}` : null;
  } catch { return null; }
}

/**
 * The ingress rules of a cloudflared config: `{ hostname, service }` for every rule that names a
 * hostname, in order; the catch-all and `http_status:` services are not names. A wildcard rule
 * (`*.example.com`) is kept as it is written: the page says it cannot check a wildcard. A rule's
 * service is kept as scheme, host and port; one that is not an address still names its hostname.
 */
export function parseCloudflaredConfig(source) {
  let parsed;
  try { parsed = parseYaml(String(source ?? "")); } catch { return { tunnel: null, ingress: [] }; }
  if (!isObject(parsed)) return { tunnel: null, ingress: [] };
  const ingress = [];
  for (const rule of Array.isArray(parsed.ingress) ? parsed.ingress : []) {
    if (!isObject(rule)) continue;
    const hostname = text(rule.hostname);
    const service = text(rule.service, 300);
    if (!hostname || !service) continue;
    const wildcard = hostname.startsWith("*.");
    const bare = wildcard ? hostname.slice(2) : hostname;
    if (!hostnamePattern.test(lower(bare))) continue;
    if (/^http_status:/.test(service)) continue;
    ingress.push({ hostname: lower(hostname), service: serviceOrigin(service), wildcard });
    if (ingress.length >= sourceLimits.namesPerFile) break;
  }
  return { tunnel: text(parsed.tunnel, 64), ingress };
}

/**
 * One of Nginx Proxy Manager's generated site files: the names it answers (`server_name`) and the
 * upstream it forwards to (`set $forward_scheme`, `set $server`, `set $port`). A redirection or
 * 404 host has no upstream and is left out, and so is an upstream that is not a bare address or
 * host name with a port: the target is built from the three and holds nothing else.
 */
export function parseProxyHostConfig(source) {
  const body = String(source ?? "");
  const names = new Set();
  // Each pattern is anchored to a line and bounded in what it takes, so a file made of blank lines
  // or of one endless directive costs a pass over it and no more.
  scan: for (const match of body.matchAll(/^[ \t]*server_name\s+([^;\s][^;]{0,4095});/gm)) {
    for (const name of match[1].split(/\s+/)) {
      const clean = lower(name.trim());
      if (clean && hostnamePattern.test(clean.startsWith("*.") ? clean.slice(2) : clean)) names.add(clean);
      if (names.size >= sourceLimits.namesPerFile) break scan;
    }
  }
  const setting = (name) => { const match = new RegExp(`^[ \\t]*set[ \\t]+\\$${name}[ \\t]+"?([^";\\s]{1,300})"?[ \\t]*;`, "m").exec(body); return match ? match[1] : null; };
  const scheme = setting("forward_scheme") ?? "http";
  const server = setting("server");
  const port = setting("port");
  const host = !server ? null : isIP(server) === 4 ? server : isIP(server) === 6 ? `[${server}]` : upstreamNamePattern.test(server) ? server.toLowerCase() : null;
  const target = host && port && /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 && ["http", "https"].includes(scheme) ? `${scheme}://${host}:${port}` : null;
  return { hostnames: [...names], target };
}

/**
 * One small text file, read as root from a place an app can write: null unless it is a regular
 * file, reached without following a link, no bigger than the limit. It is looked at before it is
 * opened (a pipe or a device is never opened at all), opened so that a link put there in between
 * is refused and nothing can make the open wait, looked at again through the open handle, and read
 * to the limit and no further.
 */
export async function readSmallFile(file, { limit = sourceLimits.fileBytes } = {}) {
  let handle = null;
  try {
    const seen = await fsLstat(file);
    if (!seen.isFile() || seen.size > limit) return null;
    handle = await fsOpen(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const held = await handle.stat();
    if (!held.isFile() || held.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    // It grew past the limit while it was being read: not the small file it said it was.
    return length > limit ? null : buffer.toString("utf8", 0, length);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** A folder's entries by name, looked through one at a time and no further than the limit: a folder an app filled with a million files is not listed whole. */
async function listSomeEntries(directory, { limit = sourceLimits.directoryEntries } = {}) {
  const names = [];
  const open = await fsOpendir(directory);
  try {
    for (let entry = await open.read(); entry && names.length < limit; entry = await open.read()) names.push(entry.name);
  } finally {
    await open.close().catch(() => {});
  }
  return names;
}

/** Whether a path, with every link in it followed, is the root or inside it. */
async function staysUnder(target, root, files) {
  try {
    const [real, realRoot] = await Promise.all([files.realpath(target), files.realpath(root)]);
    return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`) ? real : null;
  } catch { return null; }
}

/**
 * Every routed name the files on this server know of. Missing files and directories are the normal
 * case (no hand-made tunnel, no proxy manager) and are simply absent from the answer. Anything
 * under the catalog's root must really be under it: a folder there that is a link to somewhere
 * else on the server is not read. At most `sourceLimits.names` names leave, the first found.
 * @param {{ cloudflaredFiles?: string[], proxyDirectories?: string[], root?: string, files?: { readFile: (file: string) => Promise<string | null>, readdir: (directory: string) => Promise<string[]>, realpath: (target: string) => Promise<string> } }} [options]
 */
export async function readHostedSources({ cloudflaredFiles = cloudflaredConfigCandidates(), proxyDirectories = proxyHostDirectories(), root = catalogRoot(), files = { readFile: readSmallFile, readdir: listSomeEntries, realpath: fsRealpath } } = {}) {
  let room = sourceLimits.names;
  const lexicallyUnder = (target) => { const relative = path.relative(root, target); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
  const cloudflared = [];
  for (const file of cloudflaredFiles) {
    if (room <= 0) break;
    let target = file;
    if (lexicallyUnder(file)) {
      const folder = await staysUnder(path.dirname(file), root, files);
      if (!folder) continue;
      target = path.join(folder, path.basename(file));
    }
    let source;
    try { source = await files.readFile(target); } catch { continue; }
    if (typeof source !== "string") continue;
    const parsed = parseCloudflaredConfig(source);
    const ingress = parsed.ingress.slice(0, room);
    room -= ingress.length;
    if (ingress.length) cloudflared.push({ file, tunnel: parsed.tunnel, ingress });
  }
  const proxyHosts = [];
  for (const directory of proxyDirectories) {
    if (room <= 0) break;
    const folder = await staysUnder(directory, root, files);
    if (!folder) continue;
    let entries;
    try { entries = await files.readdir(folder); } catch { continue; }
    for (const name of (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry === "string" && /^[\w.-]+\.conf$/.test(entry)).sort().slice(0, sourceLimits.proxyFiles)) {
      if (room <= 0) break;
      let source;
      try { source = await files.readFile(path.join(folder, name)); } catch { continue; }
      if (typeof source !== "string") continue;
      const parsed = parseProxyHostConfig(source);
      const hostnames = parsed.hostnames.slice(0, room);
      room -= hostnames.length;
      if (hostnames.length) proxyHosts.push({ file: path.join(directory, name), hostnames, target: parsed.target });
    }
  }
  return { cloudflared, proxyHosts };
}
