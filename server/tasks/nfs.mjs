import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side NFS server tasks executed by scripts/boxpilot-run.mjs.
 *
 * Exports live in /etc/exports.d/boxpilot.exports (one file BoxPilot owns; /etc/exports is
 * left alone). NFSv4 only, so a single port (2049) is enough and the firewall's "NFS" preset
 * covers it. By default exports are offered to the Tailscale range (100.64.0.0/10) only;
 * "lan" scope adds the directly connected IPv4 subnets. Clients are squashed to the folder
 * owner so writes just work, the same rule the Samba file server uses.
 */

export const exportsPath = "/etc/exports.d/boxpilot.exports";
export const nfsConfPath = "/etc/nfs.conf.d/boxpilot.conf";
export const managedMarker = "# Managed by BoxPilot";
export const tailscaleRange = "100.64.0.0/10";
export const scopes = Object.freeze(["tailscale", "lan"]);
export const exportPathDenyPrefixes = Object.freeze(["/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/run", "/var/run", "/opt", "/snap", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/libvirt", "/var/lib/docker", "/var/lib/boxpilot", "/var/lib/boxpilot-managed", "/var/lib/docker", "/var/lib/nfs"]);
export const maxExports = 32;

const binaries = {
  exportfs: "/usr/sbin/exportfs",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  ip: "/usr/sbin/ip",
  ss: "/usr/bin/ss",
};

function cleanPath(value) {
  if (typeof value !== "string" || !/^\/[^\0\r\n\s"]*$/.test(value) || value.includes("/../") || value.endsWith("/..") || value.length > 512) return null;
  const normalized = value.replace(/\/+$/, "") || "/";
  if (normalized === "/" || exportPathDenyPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return null;
  return normalized;
}

export function validateNfsConfig({ scope = "tailscale", exports = [] } = {}) {
  if (!scopes.includes(scope)) return "scope must be tailscale or lan";
  if (!Array.isArray(exports)) return "exports must be a list";
  if (exports.length > maxExports) return `at most ${maxExports} exports`;
  const seen = new Set();
  for (const entry of exports) {
    if (!entry || typeof entry !== "object") return "each export must be an object";
    const path = cleanPath(entry.path);
    if (path === null) return `export "${entry.path}": path must be an absolute folder outside system locations`;
    if (seen.has(path)) return `folder ${path} is exported twice`;
    seen.add(path);
    if (entry.readOnly !== undefined && typeof entry.readOnly !== "boolean") return `export ${path}: readOnly must be true or false`;
  }
  return null;
}

/** Render the exports file. Pure; `owners` maps path → { uid, gid } for squashing. */
export function renderExports({ scope = "tailscale", lanSubnets = [], exports = [], owners = {} } = {}) {
  const clients = [tailscaleRange, ...(scope === "lan" ? lanSubnets : [])];
  const lines = [managedMarker, "# Edit from the BoxPilot Storage page; manual changes here are overwritten on Apply.", ""];
  for (const entry of exports) {
    const path = cleanPath(entry.path) ?? entry.path;
    // A root-owned folder must squash to nobody: anonuid=0 would make every client root inside the export.
    const recorded = owners[path];
    const owner = recorded && recorded.uid !== 0 && recorded.gid !== 0 ? recorded : { uid: 65534, gid: 65534 };
    const options = [entry.readOnly ? "ro" : "rw", "sync", "no_subtree_check", "all_squash", `anonuid=${owner.uid}`, `anongid=${owner.gid}`].join(",");
    lines.push(`"${path}" ${clients.map((client) => `${client}(${options})`).join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Parse an exports file back into { managed, exports: [{ path, readOnly, clients }] }. */
export function parseExports(content) {
  const text = String(content ?? "");
  const exports = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^"([^"]+)"\s+(.*)$|^(\S+)\s+(.*)$/);
    if (!match) continue;
    const path = match[1] ?? match[3];
    const rest = match[2] ?? match[4] ?? "";
    const clients = [...rest.matchAll(/(\S+?)\(([^)]*)\)/g)].map((hit) => ({ spec: hit[1], options: hit[2].split(",") }));
    exports.push({ path, readOnly: clients.length > 0 && clients.every((client) => client.options.includes("ro")), clients: clients.map((client) => client.spec) });
  }
  return { managed: text.startsWith(managedMarker), exports };
}

async function lanSubnetsFrom(run) {
  const result = await run(binaries.ip, ["-j", "-4", "route", "show"], { timeout: 10_000 });
  if (!result.ok) return [];
  try {
    return [...new Set(JSON.parse(result.stdout)
      .filter((route) => route.scope === "link" && typeof route.dst === "string" && route.dst.includes("/") && !/^(tailscale|docker|br-|virbr|veth|lo)/.test(route.dev ?? ""))
      .map((route) => route.dst))];
  } catch { return []; }
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

/** Write exports, validate with exportfs, start the server, verify it listens. */
export async function nfsApply({ scope = "tailscale", exports = [] } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, rename, mkdir, stat, access } } = {}) {
  const problem = validateNfsConfig({ scope, exports });
  if (problem) throw new Error(`Invalid configuration: ${problem}`);
  const installed = await files.access(binaries.exportfs).then(() => true, () => false);
  if (!installed) throw new Error("The NFS server is not installed; install nfs-kernel-server from the Storage page first");
  const owners = {};
  for (const entry of exports) {
    const path = cleanPath(entry.path);
    const info = await files.stat(path);
    if (!info.isDirectory()) throw new Error(`${path} is not a folder`);
    if (info.uid !== 0) owners[path] = { uid: info.uid, gid: info.gid };
    else log?.(`${path} is owned by root, so clients are mapped to nobody there; give the folder to a normal user to allow writes`, "stderr");
  }
  const lanSubnets = scope === "lan" ? await lanSubnetsFrom(run) : [];
  if (scope === "lan" && !lanSubnets.length) throw new Error("Could not determine the LAN subnet (no link route)");
  const previous = await files.readFile(exportsPath, "utf8").catch(() => null);
  await files.mkdir("/etc/exports.d", { recursive: true, mode: 0o755 });
  await files.mkdir("/etc/nfs.conf.d", { recursive: true, mode: 0o755 });
  await files.writeFile(nfsConfPath, `${managedMarker}\n[nfsd]\nvers3=n\nvers4=y\n`, { mode: 0o644 });
  const rendered = renderExports({ scope, lanSubnets, exports, owners });
  await files.writeFile(`${exportsPath}.tmp`, rendered, { mode: 0o644 });
  await files.rename(`${exportsPath}.tmp`, exportsPath);
  const enable = await run(binaries.systemctl, ["enable", "--now", "nfs-server"], { timeout: 60_000 });
  if (!enable.ok) throw new Error(`Could not start the NFS server: ${tail(enable.stderr)}`);
  const reexport = await run(binaries.exportfs, ["-ra"], { timeout: 30_000 });
  if (!reexport.ok || /exportfs:.*(error|failed|does not exist|invalid)/i.test(`${reexport.stderr}${reexport.stdout}`)) {
    if (previous !== null) { await files.writeFile(exportsPath, previous, { mode: 0o644 }); await run(binaries.exportfs, ["-ra"], { timeout: 30_000 }).catch(() => {}); }
    throw new Error(`exportfs rejected the exports (restored the previous file): ${tail(reexport.stderr) || tail(reexport.stdout)}`);
  }
  log?.(`Wrote ${exportsPath}: ${exports.length} export(s) for ${[tailscaleRange, ...lanSubnets].join(", ")}`, "stdout");
  const listing = await run(binaries.exportfs, ["-v"], { timeout: 15_000 });
  const listening = await run(binaries.ss, ["-H", "-l", "-n", "-t"], { timeout: 10_000 });
  const bound = listening.ok ? listening.stdout.split("\n").filter((line) => /:2049\s/.test(line)).map((line) => line.trim().split(/\s+/)[3]).filter(Boolean) : [];
  return { applied: true, scope, exports: exports.map((entry) => cleanPath(entry.path)), clients: [tailscaleRange, ...lanSubnets], listening: bound, exported: listing.ok ? listing.stdout.split("\n").filter(Boolean) : [], owners };
}
