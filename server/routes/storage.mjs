/**
 * Storage routes (web process): the disk/LVM/share overview, LAN discovery of SMB/NFS hosts,
 * and share listing on a host. All read-only; mounting goes through registry ops.
 *
 * These run here rather than in the helper because the helper's sandbox hides device-mapper
 * nodes (PrivateDevices) and the network (PrivateNetwork). lsblk, findmnt, TCP probes, and
 * smbclient/showmount need no privileges.
 */
import { Router } from "express";
import net from "node:net";
import dns from "node:dns/promises";
import { fixedRun } from "../exec.mjs";
import { collectStorage } from "../storage-inventory.mjs";
import { projectDaysToFull } from "../disk-forecast.mjs";
import { parseNeighbors } from "../network.mjs";
import { credentialPattern, hostPattern } from "../tasks/shares.mjs";

const ipBinary = "/usr/sbin/ip";
const smbclientBinary = "/usr/bin/smbclient";
const showmountBinary = "/usr/sbin/showmount";
const ignoredInterfaces = /^(lo|docker\d*|br-|virbr|veth|tailscale|wg|tun|tap|vnet)/;

/** TCP connect probe; resolves true only when the port accepts a connection within the timeout. */
export function probePort(host, port, { timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** Every host address in an IPv4 subnet of /24 or smaller (larger subnets are not swept). */
export function subnetHosts(address, prefixLength) {
  if (!Number.isInteger(prefixLength) || prefixLength < 24 || prefixLength > 30) return [];
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return [];
  const value = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const size = 2 ** (32 - prefixLength);
  const network = Math.floor(value / size) * size;
  const hosts = [];
  for (let offset = 1; offset < size - 1; offset += 1) {
    const candidate = network + offset;
    if (candidate === value) continue;
    hosts.push([candidate >>> 24, (candidate >>> 16) & 255, (candidate >>> 8) & 255, candidate & 255].join("."));
  }
  return hosts;
}

/** `smbclient -L //host -g` lines: `Disk|Public|Public Share`. Hidden ($) and non-disk shares are dropped. */
export function parseSmbclientList(output) {
  const shares = [];
  for (const line of String(output ?? "").split("\n")) {
    const [type, name, comment = ""] = line.split("|");
    if (type !== "Disk" || !name || name.endsWith("$")) continue;
    shares.push({ name: name.trim(), comment: comment.trim() || null });
  }
  return shares;
}

/** `showmount -e --no-headers host` lines: `/volume1/media 192.168.1.0/24`. */
export function parseShowmount(output) {
  const exports = [];
  for (const line of String(output ?? "").split("\n")) {
    const match = line.trim().match(/^(\/\S*)\s*(.*)$/);
    if (match) exports.push({ name: match[1], comment: match[2] ? `allowed: ${match[2]}` : null });
  }
  return exports;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index], index); }
  });
  await Promise.all(runners);
  return results;
}

export function createStorageRouter({ auth, helper = null, inventory = null, state = null, run = fixedRun, collect = collectStorage, probe = probePort, reverse = (address) => dns.reverse(address), sweepLimit = 254 }) {
  const router = Router();

  router.get("/storage/overview", async (_request, response) => {
    try {
      const overview = await collect();
      const records = state?.getSetting?.("lvmSnapshots", []) ?? [];
      overview.snapshots = (overview.snapshots ?? []).map((snapshot) => ({ ...snapshot, ...(records.find((entry) => entry.path === snapshot.path) ?? {}) }));
      response.json(overview);
    } catch (error) {
      response.status(503).json({ error: error.message, code: "storage_unavailable" });
    }
  });

  // When each filesystem is on track to fill, from the sampled free-space history (M23.1).
  router.get("/storage/forecast", async (_request, response) => {
    const history = state?.getSetting?.("diskUsageHistory", {}) ?? {};
    const now = Date.now();
    const forecasts = [];
    for (const [target, samples] of Object.entries(history)) {
      const days = projectDaysToFull(samples, { now });
      if (days === null) continue;
      const latest = Array.isArray(samples) && samples.length ? samples[samples.length - 1] : null;
      forecasts.push({ target, daysToFull: Math.max(0, Math.round(days)), availableBytes: latest?.availableBytes ?? null, totalBytes: latest?.totalBytes ?? null, samples: Array.isArray(samples) ? samples.length : 0 });
    }
    forecasts.sort((a, b) => a.daysToFull - b.daysToFull);
    response.json({ forecasts, tracking: Object.keys(history).length });
  });

  // Discover LAN hosts offering SMB (445) or NFS (2049): recent neighbours plus a sweep of each /24.
  router.get("/storage/shares/discover", async (_request, response) => {
    const [addresses, neighbours] = await Promise.all([
      run(ipBinary, ["-j", "-4", "address", "show"], { timeout: 10_000 }),
      run(ipBinary, ["-j", "-4", "neigh", "show"], { timeout: 10_000 }),
    ]);
    const known = new Map();
    for (const device of neighbours.ok ? parseNeighbors(neighbours.stdout) : []) known.set(device.address, { address: device.address, mac: device.mac, interface: device.interface });
    let lanInterfaces = [];
    try {
      lanInterfaces = (JSON.parse(addresses.stdout || "[]"))
        .filter((link) => !ignoredInterfaces.test(link.ifname ?? ""))
        .flatMap((link) => (link.addr_info ?? []).filter((info) => info.family === "inet" && info.scope === "global").map((info) => ({ interface: link.ifname, address: info.local, prefix: info.prefixlen })));
    } catch { lanInterfaces = []; }
    const candidates = new Map(known);
    for (const link of lanInterfaces) {
      for (const host of subnetHosts(link.address, link.prefix).slice(0, sweepLimit)) if (!candidates.has(host)) candidates.set(host, { address: host, mac: null, interface: link.interface });
    }
    const probed = await mapLimit([...candidates.values()], 64, async (candidate) => {
      const [smb, nfs] = await Promise.all([probe(candidate.address, 445), probe(candidate.address, 2049)]);
      return { ...candidate, smb, nfs };
    });
    const found = probed.filter((entry) => entry.smb || entry.nfs);
    const named = await mapLimit(found, 16, async (entry) => {
      const names = await Promise.race([reverse(entry.address).catch(() => []), new Promise((resolve) => setTimeout(() => resolve([]), 1500))]);
      return { ...entry, name: names[0] ?? null };
    });
    response.json({ devices: named.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true })), scanned: candidates.size, interfaces: lanInterfaces.map((link) => `${link.interface} ${link.address}/${link.prefix}`) });
  });

  async function clientAddresses() {
    let addresses = { tailscaleDnsName: null, tailscaleAddress: null, lanAddress: null };
    try {
      const snapshot = inventory ? await inventory.inspect() : null;
      const ipv4 = (entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address ?? "");
      addresses = {
        tailscaleDnsName: snapshot?.network?.tailscale?.dnsName ?? null,
        tailscaleAddress: snapshot?.network?.addresses?.find((entry) => ipv4(entry) && String(entry.interface ?? "").startsWith("tailscale"))?.address ?? null,
        lanAddress: snapshot?.network?.addresses?.find((entry) => ipv4(entry) && !String(entry.interface ?? "").startsWith("tailscale") && !/^(lo|docker|br-|virbr|veth)/.test(String(entry.interface ?? "")))?.address ?? null,
      };
    } catch { /* addresses are a convenience */ }
    return addresses;
  }

  // The NFS server this server runs.
  router.get("/storage/nfs", async (_request, response) => {
    let state = { installed: false, running: null, configured: false, config: { managed: false, scope: "tailscale", exports: [] } };
    let error = null;
    try { if (helper) state = await helper.request("nfs.inspect", {}, { timeoutMs: 30_000 }); } catch (requestError) { error = requestError.message; }
    response.json({ ...state, error, ...(await clientAddresses()) });
  });

  // The file server (Samba) this server runs: state from the helper plus the addresses clients should use.
  router.get("/storage/samba", async (_request, response) => {
    let state = { installed: false, running: null, configured: false, config: { managed: false, workgroup: "WORKGROUP", scope: "tailscale", interfaces: [], shares: [] }, users: [] };
    let error = null;
    try { if (helper) state = await helper.request("samba.inspect", {}, { timeoutMs: 30_000 }); } catch (requestError) { error = requestError.message; }
    let addresses = { tailscaleDnsName: null, tailscaleAddress: null, lanAddress: null };
    try {
      const snapshot = inventory ? await inventory.inspect() : null;
      const ipv4 = (entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address ?? "");
      addresses = {
        tailscaleDnsName: snapshot?.network?.tailscale?.dnsName ?? null,
        tailscaleAddress: snapshot?.network?.addresses?.find((entry) => ipv4(entry) && String(entry.interface ?? "").startsWith("tailscale"))?.address ?? null,
        lanAddress: snapshot?.network?.addresses?.find((entry) => ipv4(entry) && !String(entry.interface ?? "").startsWith("tailscale") && !/^(lo|docker|br-|virbr|veth)/.test(String(entry.interface ?? "")))?.address ?? null,
      };
    } catch { /* addresses are a convenience */ }
    response.json({ ...state, error, ...addresses });
  });

  // List shares on one host. SMB passwords go to smbclient on stdin, never as an argument.
  router.post("/storage/shares/list", auth.requireCsrf, async (request, response) => {
    const { kind, host, username = null, password = null, domain = null } = request.body ?? {};
    if (!["smb", "nfs"].includes(kind) || typeof host !== "string" || !hostPattern.test(host)) return response.status(400).json({ error: "kind must be smb or nfs and host a hostname or IP", code: "invalid_request" });
    if (username !== null && (typeof username !== "string" || !credentialPattern.test(username))) return response.status(400).json({ error: "username is invalid", code: "invalid_request" });
    if (domain !== null && (typeof domain !== "string" || !credentialPattern.test(domain))) return response.status(400).json({ error: "domain is invalid", code: "invalid_request" });
    if (kind === "nfs") {
      const result = await run(showmountBinary, ["-e", "--no-headers", host], { timeout: 15_000 });
      if (!result.ok) return response.status(502).json({ error: /ENOENT|not found/i.test(result.stderr) && !result.stdout ? "nfs-common (showmount) is not installed" : result.stderr.split("\n").filter(Boolean).at(-1) ?? "showmount failed", code: "list_failed" });
      return response.json({ shares: parseShowmount(result.stdout) });
    }
    const user = username ? (domain ? `${domain}\\${username}` : username) : null;
    const args = ["-L", `//${host}`, "-g", ...(user ? ["-U", user] : ["-N"])];
    const result = await run(smbclientBinary, args, { timeout: 20_000, ...(user ? { input: `${typeof password === "string" ? password : ""}\n` } : {}) });
    if (!result.ok && !parseSmbclientList(result.stdout).length) {
      const text = `${result.stderr}\n${result.stdout}`;
      const error = /ENOENT/.test(text) ? "smbclient is not installed; install it to list shares, or type the share name"
        : /NT_STATUS_LOGON_FAILURE|NT_STATUS_ACCESS_DENIED/.test(text) ? "The NAS refused these credentials (on a My Cloud Home, enable local network access in the app first)"
          : /NT_STATUS_CONNECTION_REFUSED|NT_STATUS_IO_TIMEOUT|NT_STATUS_HOST_UNREACHABLE|Connection to .* failed/.test(text) ? "The host did not answer on port 445"
            : text.split("\n").filter(Boolean).at(-1) ?? "smbclient failed";
      return response.status(502).json({ error, code: "list_failed" });
    }
    return response.json({ shares: parseSmbclientList(result.stdout) });
  });

  return router;
}
