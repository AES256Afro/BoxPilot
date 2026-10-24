import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { unitFailureMessage } from "./unit-failure.mjs";

const execFile = promisify(execFileCallback);
const connectionUri = "qemu:///system";
const networkName = "default";
const networkBridge = "virbr0";
const networkAddress = "192.168.122.1";
const networkRangeStart = "192.168.122.2";
const networkRangeEnd = "192.168.122.254";
const poolName = "default";
const poolTarget = "/var/lib/libvirt/images";
const defaultApprovalPath = "/run/boxpilot/libvirt-foundation-approval.json";
const defaultSystemctlBinary = "/usr/bin/systemctl";
const foundationUnit = "boxpilot-libvirt-foundation.service";
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const revisionPattern = /^[a-f0-9]{64}$/;

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, {
      timeout,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : error.message,
      code: error.code ?? null,
    };
  }
}

function parseInfo(output) {
  const values = {};
  for (const line of String(output ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    values[key] = line.slice(separator + 1).trim();
  }
  return values;
}

function xmlAttribute(xml, element, attribute) {
  const expression = new RegExp(`<${element}\\b[^>]*\\b${attribute}=(?:'([^']*)'|"([^"]*)")`, "i");
  const match = String(xml ?? "").match(expression);
  return match?.[1] ?? match?.[2] ?? null;
}

function xmlText(xml, element) {
  const match = String(xml ?? "").match(new RegExp(`<${element}\\b[^>]*>([^<]*)<\\/${element}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function canonicalNetworkXml(xml) {
  return xmlAttribute(xml, "forward", "mode") === "nat"
    && xmlAttribute(xml, "bridge", "name") === networkBridge
    && xmlAttribute(xml, "ip", "address") === networkAddress
    && xmlAttribute(xml, "ip", "netmask") === "255.255.255.0"
    && xmlAttribute(xml, "range", "start") === networkRangeStart
    && xmlAttribute(xml, "range", "end") === networkRangeEnd;
}

function canonicalPoolXml(xml) {
  return xmlAttribute(xml, "pool", "type") === "dir" && xmlText(xml, "path") === poolTarget;
}

/**
 * Whether a `/proc/net/{udp,udp6,tcp,tcp6}` table has a socket bound to port 53 on every address: a
 * local address of `00000000:0035` in the IPv4 tables, thirty-two zeros and `:0035` in the IPv6 ones.
 * The state column tells a listener from a client: an unconnected UDP socket shows 07 (TCP_CLOSE), a
 * TCP listener 0A (LISTEN).
 */
const wildcardDnsAddress = /^(?:0{8}|0{32}):0035$/i;
const listeningState = Object.freeze({ udp: "07", tcp: "0A" });

function hasWildcardDnsListener(table, state) {
  return String(table ?? "").split("\n").some((line) => {
    const columns = line.trim().split(/\s+/);
    return wildcardDnsAddress.test(columns[1] ?? "") && (columns[3] ?? "").toUpperCase() === state;
  });
}

function revisionOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function safePathState(statFile, targetPath) {
  try {
    const metadata = await statFile(targetPath);
    return { exists: true, directory: metadata.isDirectory(), symbolicLink: metadata.isSymbolicLink() };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, directory: false, symbolicLink: false };
    return { exists: true, directory: false, symbolicLink: false, unreadable: true };
  }
}

async function clearFile(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function createLibvirtFoundationHelper({
  run = fixedRun,
  statFile = lstat,
  // PID 1's tables: the helper runs under PrivateNetwork, so its own /proc/net shows an empty namespace.
  loadRoutes = () => readFile("/proc/1/net/route", "utf8"),
  loadDevices = () => readFile("/proc/1/net/dev", "utf8"),
  loadUdpSockets = () => readFile("/proc/1/net/udp", "utf8"),
  loadUdp6Sockets = () => readFile("/proc/1/net/udp6", "utf8"),
  loadTcpSockets = () => readFile("/proc/1/net/tcp", "utf8"),
  loadTcp6Sockets = () => readFile("/proc/1/net/tcp6", "utf8"),
  now = () => new Date(),
  approvalPath = defaultApprovalPath,
  systemctlBinary = defaultSystemctlBinary,
  writeApproval = (approval) => writeFile(approvalPath, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  clearApproval = () => clearFile(approvalPath),
} = {}) {
  async function virsh(args, timeout = 15000) {
    return run("/usr/bin/virsh", ["--connect", connectionUri, ...args], { timeout });
  }

  async function inspect() {
    const [uri, networkInfoResult, networkXmlResult, poolInfoResult, poolXmlResult, devices, routes, udp, udp6, tcp, tcp6, target] = await Promise.all([
      virsh(["uri"]),
      virsh(["net-info", networkName]),
      virsh(["net-dumpxml", "--inactive", networkName]),
      virsh(["pool-info", poolName]),
      virsh(["pool-dumpxml", "--inactive", poolName]),
      loadDevices().catch(() => ""),
      loadRoutes().catch(() => ""),
      loadUdpSockets().catch(() => ""),
      loadUdp6Sockets().catch(() => ""),
      loadTcpSockets().catch(() => ""),
      loadTcp6Sockets().catch(() => ""),
      safePathState(statFile, poolTarget),
    ]);
    const connectionReady = uri.ok && uri.stdout === connectionUri;
    const networkInfo = networkInfoResult.ok ? parseInfo(networkInfoResult.stdout) : {};
    const poolInfo = poolInfoResult.ok ? parseInfo(poolInfoResult.stdout) : {};
    const network = {
      name: networkName,
      exists: networkInfoResult.ok,
      active: networkInfo.active === "yes",
      autostart: networkInfo.autostart === "yes",
      persistent: networkInfo.persistent === "yes",
      compatible: networkInfoResult.ok ? networkXmlResult.ok && canonicalNetworkXml(networkXmlResult.stdout) : true,
      bridge: networkInfo.bridge ?? networkBridge,
      forwardMode: networkXmlResult.ok ? xmlAttribute(networkXmlResult.stdout, "forward", "mode") : null,
      address: networkXmlResult.ok ? xmlAttribute(networkXmlResult.stdout, "ip", "address") : null,
      rangeStart: networkXmlResult.ok ? xmlAttribute(networkXmlResult.stdout, "range", "start") : null,
      rangeEnd: networkXmlResult.ok ? xmlAttribute(networkXmlResult.stdout, "range", "end") : null,
      // libvirt's dnsmasq binds the gateway address on port 53 unless the definition says <dns enable='no'/>.
      dnsEnabled: networkXmlResult.ok ? xmlAttribute(networkXmlResult.stdout, "dns", "enable") !== "no" : null,
    };
    const dnsListenerOnEveryAddress = hasWildcardDnsListener(udp, listeningState.udp) || hasWildcardDnsListener(udp6, listeningState.udp)
      || hasWildcardDnsListener(tcp, listeningState.tcp) || hasWildcardDnsListener(tcp6, listeningState.tcp);
    const pool = {
      name: poolName,
      exists: poolInfoResult.ok,
      active: poolInfo.state === "running",
      autostart: poolInfo.autostart === "yes",
      persistent: poolInfo.persistent === "yes",
      compatible: poolInfoResult.ok
        ? poolXmlResult.ok && canonicalPoolXml(poolXmlResult.stdout) && target.exists && target.directory && !target.symbolicLink && !target.unreadable
        : target.exists ? target.directory && !target.symbolicLink && !target.unreadable : true,
      type: poolXmlResult.ok ? xmlAttribute(poolXmlResult.stdout, "pool", "type") : "dir",
      targetPath: poolXmlResult.ok ? xmlText(poolXmlResult.stdout, "path") : poolTarget,
      target,
    };
    const conflicts = [];
    if (network.exists && !network.compatible) conflicts.push("A noncanonical libvirt resource already uses the default network name");
    if (!network.exists && String(devices).split("\n").some((line) => line.split(":", 1)[0].trim() === networkBridge)) conflicts.push("The virbr0 interface exists without the canonical default libvirt network");
    if (!network.exists && String(routes).split("\n").some((line) => line.trim().split(/\s+/)[1] === "007AA8C0")) conflicts.push("The fixed 192.168.122.0/24 subnet already has a host route");
    // A DNS server in host network mode (Pi-hole with its listening mode "all") holds 0.0.0.0:53 and
    // [::]:53, so `net-start default` fails with "failed to create listening socket for 192.168.122.1:
    // Address already in use" after the plan was offered. An active network has already bound the port
    // or done without it, and a definition with DNS off never needs it; otherwise the start would fail.
    if (dnsListenerOnEveryAddress && !network.active && network.dnsEnabled !== false) conflicts.push("Another DNS server listens on every address on port 53, so the default network's dnsmasq cannot start; bind that server to one interface first");
    if (pool.exists && !pool.compatible) conflicts.push("A noncanonical libvirt resource already uses the default pool name");
    if (!pool.exists && target.exists && (!target.directory || target.symbolicLink || target.unreadable)) conflicts.push("The fixed libvirt image target is not a safe existing directory");
    const ready = connectionReady
      && network.exists && network.compatible && network.persistent && network.active && network.autostart
      && pool.exists && pool.compatible && pool.persistent && pool.active && pool.autostart;
    const identity = {
      connectionReady,
      network: { exists: network.exists, active: network.active, autostart: network.autostart, persistent: network.persistent, compatible: network.compatible },
      pool: { exists: pool.exists, active: pool.active, autostart: pool.autostart, persistent: pool.persistent, compatible: pool.compatible, targetExists: target.exists },
      conflicts,
    };
    return {
      connectionUri,
      connectionReady,
      ready,
      revision: revisionOf(identity),
      network,
      pool,
      conflicts,
      dnsListenerOnEveryAddress,
      planAvailable: connectionReady && !ready && conflicts.length === 0,
      changes: ready ? [] : [
        !network.exists ? "Define the fixed default NAT network" : null,
        !network.active ? "Start the fixed default NAT network" : null,
        !network.autostart ? "Enable default network autostart" : null,
        !pool.exists ? "Define the fixed default directory storage pool" : null,
        !pool.active ? "Start the fixed default storage pool" : null,
        !pool.autostart ? "Enable default pool autostart" : null,
      ].filter(Boolean),
      boundary: {
        resourceNamesFixed: true,
        networkCidr: "192.168.122.0/24",
        poolTarget,
        otherNetworksChanged: false,
        otherPoolsChanged: false,
        virtualMachineCreated: false,
        diskCreated: false,
        bridgeModeEnabled: false,
        browserResourceAccepted: false,
        mutationPerformed: false,
      },
    };
  }

  async function initialize({ foundationId, expectedRevision }) {
    if (!uuidPattern.test(String(foundationId ?? "")) || !revisionPattern.test(String(expectedRevision ?? ""))) throw new Error("The libvirt foundation request is invalid");
    const before = await inspect();
    if (before.revision !== expectedRevision) throw new Error("Host state changed: the libvirt foundation revision no longer matches approval");
    if (before.ready) throw new Error("The canonical libvirt foundation is already ready");
    if (!before.planAvailable) throw new Error(before.conflicts[0] ?? "The canonical libvirt foundation cannot be initialized safely");
    await clearApproval();
    await writeApproval({ approvedAt: now().toISOString(), expectedRevision, foundationId });
    let start;
    try {
      start = await run(systemctlBinary, ["start", foundationUnit], { timeout: 5 * 60 * 1000 });
    } finally {
      await clearApproval();
    }
    if (!start.ok) {
      // A non-zero start means the unit failed, not that the script failed: node dumping core in V8's
      // setup under a sandbox directive, or a timeout, leaves no rollback to speak of.
      throw new Error(await unitFailureMessage({
        run, systemctlBinary, unit: foundationUnit,
        subject: "The fixed libvirt foundation service",
        fallback: "The fixed libvirt foundation service failed and requested automatic rollback",
        unchanged: "no libvirt resource was changed",
      }));
    }
    const after = await inspect();
    if (!after.ready) throw new Error("The fixed libvirt foundation did not pass final readiness verification");
    return {
      initialized: true,
      foundationId,
      revisionBefore: before.revision,
      revisionAfter: after.revision,
      network: { name: networkName, created: !before.network.exists, started: !before.network.active, autostartEnabled: !before.network.autostart },
      pool: { name: poolName, targetPath: poolTarget, created: !before.pool.exists, started: !before.pool.active, autostartEnabled: !before.pool.autostart },
      ready: true,
      rollback: { automatic: true, requestedOnFailure: true, limitedToJobChanges: true },
      boundary: { ...after.boundary, mutationPerformed: true },
    };
  }

  return { inspect, initialize };
}

export const libvirtFoundationSpec = {
  connectionUri,
  networkName,
  networkBridge,
  networkAddress,
  networkRangeStart,
  networkRangeEnd,
  poolName,
  poolTarget,
};

export const libvirtFoundationInternals = { canonicalNetworkXml, canonicalPoolXml, parseInfo, revisionOf, revisionPattern, uuidPattern, xmlAttribute, xmlText };
