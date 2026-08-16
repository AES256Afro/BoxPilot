import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system";
if (connectionUri !== "qemu:///system") {
  throw new Error("BOXPILOT_LIBVIRT_URI must remain qemu:///system in this release");
}
const qemuSystemBinary = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
const domainPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const snapshotPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

async function defaultRunCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: options.timeout ?? 8000,
      windowsHide: true,
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : error.message,
      code: error.code,
    };
  }
}

function parseKeyValueOutput(output) {
  const values = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    values[key] = line.slice(separator + 1).trim();
  }
  return values;
}

function parseAddresses(output) {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4 && (parts[2] === "ipv4" || parts[2] === "ipv6"))
    .map((parts) => ({ interface: parts[0], protocol: parts[2], address: parts[3] }));
}

function mergeAddresses(...groups) {
  const addresses = new Map();
  for (const address of groups.flat()) addresses.set(`${address.interface}\n${address.protocol}\n${address.address}`, address);
  return [...addresses.values()];
}

function parseAgentReturn(output) {
  try {
    const parsed = JSON.parse(output);
    return Object.hasOwn(parsed, "return") ? parsed.return : null;
  } catch {
    return null;
  }
}

function tableBody(output) {
  const lines = output.split("\n");
  const separator = lines.findIndex((line) => /^\s*-{3,}/.test(line));
  return (separator === -1 ? [] : lines.slice(separator + 1)).map((line) => line.trim()).filter(Boolean);
}

function parseBlockDevices(output) {
  return tableBody(output).map((line) => line.split(/\s+/)).filter((parts) => parts.length >= 4).map((parts) => ({
    type: parts[0],
    device: parts[1],
    target: parts[2],
    source: parts.slice(3).join(" "),
  }));
}

function parseInterfaces(output) {
  return tableBody(output).map((line) => line.split(/\s+/)).filter((parts) => parts.length >= 5).map((parts) => ({
    interface: parts[0],
    type: parts[1],
    source: parts[2],
    model: parts[3] === "-" ? null : parts[3],
    mac: parts[4],
  }));
}

function normalizeState(state = "unknown") {
  if (state === "shut off" || state === "shutoff") return "stopped";
  if (state === "in shutdown") return "stopping";
  if (state === "pmsuspended") return "suspended";
  return state;
}

function parseStorageBytes(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s+(bytes|KiB|MiB|GiB|TiB)$/i);
  if (!match) return null;
  const multipliers = { bytes: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  return Math.round(Number.parseFloat(match[1]) * multipliers[match[2].toLowerCase()]);
}

export function getSetupPlan() {
  return {
    title: "Manual recovery path for QEMU/KVM and libvirt",
    destructive: false,
    requiresConsoleApproval: true,
    commands: [
      "sudo apt update",
      "sudo apt install -y qemu-system-x86 libvirt-daemon-system libvirt-clients virtinst ovmf",
      "sudo systemctl enable --now libvirtd.service",
      "sudo install -d -m 0755 /var/lib/libvirt/boot",
      "virsh --connect qemu:///system list --all",
    ],
    notes: [
      "Use Repair Center for package installation and Default VM foundation for the network and pool whenever those guarded workflows are available.",
      "The platform uses the system libvirt URI through its restricted helper, so it does not add an interactive user to libvirt or kvm groups.",
      "Use the fixed default NAT network first. Bridging is a separate high-risk network change and remains unavailable.",
      "Do not create production VMs until their storage pool has backup coverage.",
    ],
  };
}

export function validateDomainName(name) {
  return typeof name === "string" && domainPattern.test(name);
}

export function validateSnapshotName(name) {
  return typeof name === "string" && snapshotPattern.test(name);
}

export function createLibvirtService({ runCommand = defaultRunCommand, checkKvmAccess } = {}) {
  const hasKvmAccess = checkKvmAccess ?? (async () => {
    try {
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  });

  async function inspectResource(resource, name) {
    const result = await runCommand("virsh", ["--connect", connectionUri, `${resource}-info`, name]);
    if (!result.ok) return { exists: false, active: false, detail: result.stderr };
    const info = parseKeyValueOutput(result.stdout);
    return {
      exists: true,
      active: info.active === "yes" || info.state === "running",
      autostart: info.autostart === "yes",
      detail: info,
    };
  }

  async function getTailscale() {
    const status = await runCommand("tailscale", ["status", "--json"]);
    if (!status.ok) return { installed: false, connected: false, dnsName: null, serveUrls: [] };
    try {
      const parsed = JSON.parse(status.stdout);
      const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "") ?? null;
      const serveStatus = await runCommand("tailscale", ["serve", "status"]);
      const serveUrls = serveStatus.ok
        ? Array.from(new Set(serveStatus.stdout.match(/https:\/\/[^\s|]+/g) ?? []))
        : [];
      return {
        installed: true,
        connected: parsed.BackendState === "Running",
        dnsName,
        serveUrls,
      };
    } catch {
      return { installed: true, connected: false, dnsName: null, serveUrls: [] };
    }
  }

  async function getStatus() {
    const linux = process.platform === "linux";
    const [kvmAccess, virshVersion, qemuVersion, virtInstallVersion, uri, network, pool, tailscale] =
      await Promise.all([
        linux ? hasKvmAccess() : false,
        runCommand("virsh", ["--version"]),
        runCommand(qemuSystemBinary, ["--version"]),
        runCommand("virt-install", ["--version"]),
        runCommand("virsh", ["--connect", connectionUri, "uri"]),
        inspectResource("net", "default"),
        inspectResource("pool", "default"),
        getTailscale(),
      ]);

    const checks = [
      { id: "linux", label: "Ubuntu or Linux host", ok: linux, detail: linux ? `${os.type()} ${os.release()}` : `${os.type()} is preview-only` },
      { id: "kvm", label: "KVM acceleration through libvirt", ok: kvmAccess, detail: kvmAccess ? "qemu:///system reports KVM domain support" : "Enable hardware virtualization and repair the libvirt KVM configuration" },
      { id: "qemu", label: "QEMU installed", ok: qemuVersion.ok, detail: qemuVersion.ok ? qemuVersion.stdout.split("\n")[0] : `${qemuSystemBinary} not found` },
      { id: "virsh", label: "libvirt client installed", ok: virshVersion.ok, detail: virshVersion.ok ? `virsh ${virshVersion.stdout}` : "virsh not found" },
      { id: "connection", label: "System libvirt connection", ok: uri.ok, detail: uri.ok ? uri.stdout : "Cannot connect to qemu:///system" },
      { id: "helper", label: "Restricted helper libvirt access", ok: uri.ok, detail: uri.ok ? "The Unix-socket helper can inspect qemu:///system" : "The helper cannot inspect qemu:///system" },
      { id: "network", label: "Default NAT network", ok: network.exists && network.active, detail: network.exists ? (network.active ? "Active" : "Defined but inactive") : "Not defined" },
      { id: "pool", label: "Default storage pool", ok: pool.exists && pool.active, detail: pool.exists ? (pool.active ? "Active" : "Defined but inactive") : "Not defined" },
      { id: "virt-install", label: "VM creation tools", ok: virtInstallVersion.ok, detail: virtInstallVersion.ok ? `virt-install ${virtInstallVersion.stdout}` : "virt-install not found" },
    ];

    return {
      platform: process.platform,
      architecture: process.arch,
      connectionUri,
      ready: checks.every((check) => check.ok),
      checks,
      resources: { network, pool },
      tailscale,
      setupPlan: getSetupPlan(),
    };
  }

  async function getDomain(name) {
    if (!validateDomainName(name)) return null;
    const infoResult = await runCommand("virsh", ["--connect", connectionUri, "dominfo", name]);
    if (!infoResult.ok) return null;
    const info = parseKeyValueOutput(infoResult.stdout);
    const running = normalizeState(info.state) === "running";
    const [leaseAddressResult, agentAddressResult, blockResult, interfaceResult, snapshotResult, agentPingResult, freezeResult] = await Promise.all([
      runCommand("virsh", ["--connect", connectionUri, "domifaddr", name, "--source", "lease"]),
      running ? runCommand("virsh", ["--connect", connectionUri, "domifaddr", name, "--source", "agent"]) : Promise.resolve({ ok: false, stdout: "", stderr: "Guest is not running" }),
      runCommand("virsh", ["--connect", connectionUri, "domblklist", name, "--details"]),
      runCommand("virsh", ["--connect", connectionUri, "domiflist", name]),
      runCommand("virsh", ["--connect", connectionUri, "snapshot-list", name, "--name"]),
      running ? runCommand("virsh", ["--connect", connectionUri, "qemu-agent-command", name, '{"execute":"guest-ping"}']) : Promise.resolve({ ok: false, stdout: "", stderr: "Guest is not running" }),
      running ? runCommand("virsh", ["--connect", connectionUri, "qemu-agent-command", name, '{"execute":"guest-fsfreeze-status"}']) : Promise.resolve({ ok: false, stdout: "", stderr: "Guest is not running" }),
    ]);
    const snapshotNames = snapshotResult.ok ? snapshotResult.stdout.split("\n").map((snapshot) => snapshot.trim()).filter(Boolean) : [];
    const snapshots = await Promise.all(snapshotNames.map(async (snapshotName) => {
      if (!validateSnapshotName(snapshotName)) return { name: snapshotName.slice(0, 128), manageable: false, current: null, state: null, location: null, parent: null, createdAt: null };
      const result = await runCommand("virsh", ["--connect", connectionUri, "snapshot-info", name, snapshotName]);
      const snapshotInfo = result.ok ? parseKeyValueOutput(result.stdout) : {};
      return {
        name: snapshotName,
        manageable: true,
        current: snapshotInfo.current === "yes",
        state: normalizeState(snapshotInfo.state),
        location: snapshotInfo.location ?? null,
        parent: snapshotInfo.parent && snapshotInfo.parent !== "-" ? snapshotInfo.parent : null,
        createdAt: snapshotInfo.creation_time ?? null,
      };
    }));
    const agentReturn = agentPingResult.ok ? parseAgentReturn(agentPingResult.stdout) : null;
    const freezeState = freezeResult.ok ? parseAgentReturn(freezeResult.stdout) : null;
    return {
      name: info.name ?? name,
      uuid: info.uuid ?? null,
      state: normalizeState(info.state),
      vcpus: Number.parseInt(info.cpu_s ?? "0", 10),
      memoryKiB: Number.parseInt(info.max_memory?.replace(/\s*KiB$/i, "") ?? "0", 10),
      persistent: info.persistent === "yes",
      autostart: info.autostart === "enable" || info.autostart === "yes",
      managed: validateDomainName(info.name ?? name),
      addresses: mergeAddresses(
        leaseAddressResult.ok ? parseAddresses(leaseAddressResult.stdout) : [],
        agentAddressResult.ok ? parseAddresses(agentAddressResult.stdout) : [],
      ),
      disks: blockResult.ok ? parseBlockDevices(blockResult.stdout) : [],
      interfaces: interfaceResult.ok ? parseInterfaces(interfaceResult.stdout) : [],
      snapshotCount: snapshotResult.ok ? snapshotNames.length : null,
      snapshots,
      guestAgent: {
        available: agentPingResult.ok && agentReturn !== null,
        filesystemState: typeof freezeState === "string" ? freezeState : null,
        addressDiscovery: agentAddressResult.ok,
      },
    };
  }

  async function listDomains() {
    const result = await runCommand("virsh", ["--connect", connectionUri, "list", "--all", "--name"]);
    if (!result.ok) {
      return { connected: false, domains: [], error: result.stderr || "Unable to query libvirt" };
    }
    const names = result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
    const domains = (await Promise.all(names.map(getDomain))).filter(Boolean);
    return { connected: true, domains, error: null };
  }

  async function listResources() {
    const [networkList, poolList] = await Promise.all([
      runCommand("virsh", ["--connect", connectionUri, "net-list", "--all", "--name"]),
      runCommand("virsh", ["--connect", connectionUri, "pool-list", "--all", "--name"]),
    ]);
    const networkNames = networkList.ok ? networkList.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : [];
    const poolNames = poolList.ok ? poolList.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : [];
    const [networks, pools] = await Promise.all([
      Promise.all(networkNames.filter(validateDomainName).map(async (name) => {
        const resource = await inspectResource("net", name);
        return {
          name,
          active: resource.active,
          autostart: resource.autostart ?? false,
          persistent: resource.detail?.persistent === "yes",
          bridge: resource.detail?.bridge ?? null,
        };
      })),
      Promise.all(poolNames.filter(validateDomainName).map(async (name) => {
        const resource = await inspectResource("pool", name);
        return {
          name,
          active: resource.active,
          autostart: resource.autostart ?? false,
          persistent: resource.detail?.persistent === "yes",
          type: resource.detail?.type ?? null,
          targetPath: resource.detail?.target_path ?? null,
          capacity: resource.detail?.capacity ?? null,
          allocation: resource.detail?.allocation ?? null,
          available: resource.detail?.available ?? null,
          availableBytes: parseStorageBytes(resource.detail?.available),
        };
      })),
    ]);
    return {
      connected: networkList.ok || poolList.ok,
      networks,
      pools,
      errors: [networkList.ok ? null : networkList.stderr, poolList.ok ? null : poolList.stderr].filter(Boolean),
    };
  }

  return { getStatus, listDomains, listResources, getDomain };
}
