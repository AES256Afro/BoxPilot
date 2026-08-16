#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const approvalPath = "/run/boxpilot/virtualization-approval.json";
const packageNames = ["qemu-system-x86", "libvirt-daemon-system", "libvirt-clients", "virtinst", "ovmf"];
const versionPattern = /^[0-9A-Za-z.+:~_-]{1,64}$/;
const fixedEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" };

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 512 * 1024, encoding: "utf8", env: fixedEnvironment });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "" };
  }
}

function cleanVersion(value) {
  const candidate = String(value ?? "").trim();
  return versionPattern.test(candidate) && candidate !== "(none)" ? candidate : null;
}

function installedVersion(output) {
  const [status, version] = String(output ?? "").split("\t", 2);
  return status === "install ok installed" ? cleanVersion(version) : null;
}

function candidateVersion(output) {
  return cleanVersion(String(output ?? "").match(/^\s*Candidate:\s*(\S+)\s*$/m)?.[1]);
}

function exactPackageVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...packageNames].sort().join(",")) return null;
  const packages = {};
  for (const name of packageNames) {
    const version = cleanVersion(value[name]);
    if (!version) return null;
    packages[name] = version;
  }
  return packages;
}

function parseApproval(raw, now) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The virtualization approval marker is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "approvedAt,packages" || typeof value.approvedAt !== "string") {
    throw new Error("The virtualization approval marker has unexpected fields");
  }
  const packages = exactPackageVersions(value.packages);
  if (!packages) throw new Error("The approved virtualization package set is invalid");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The virtualization approval marker is stale");
  return { approvedAt: value.approvedAt, packages };
}

export async function installApprovedVirtualization({
  run = fixedRun,
  loadApproval = () => readFile(approvalPath, "utf8"),
  now = () => new Date(),
} = {}) {
  const approval = parseApproval(await loadApproval(), now());
  const kvmDevice = await run("/usr/bin/test", ["-c", "/dev/kvm"], { timeout: 10000 });
  if (!kvmDevice.ok) throw new Error("Hardware virtualization is unavailable at /dev/kvm; no package was installed");
  for (const path of ["/usr/bin/virsh", "/usr/bin/qemu-system-x86_64"]) {
    const present = await run("/usr/bin/test", ["-e", path], { timeout: 10000 });
    if (present.ok) throw new Error("A virtualization provider became present after approval; no provider was replaced");
  }
  for (const name of packageNames) {
    const installed = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", name], { timeout: 10000 });
    if (installed.ok && installedVersion(installed.stdout)) throw new Error("A virtualization package became installed after approval; no package was changed");
    const policy = await run("/usr/bin/apt-cache", ["policy", name], { timeout: 10000 });
    if (!policy.ok || candidateVersion(policy.stdout) !== approval.packages[name]) throw new Error("APT metadata changed after approval; no package was installed");
  }
  const packageArguments = packageNames.map((name) => `${name}=${approval.packages[name]}`);
  const installation = await run("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", ...packageArguments], { timeout: 20 * 60 * 1000 });
  if (!installation.ok) throw new Error("The exact approved virtualization package installation failed");
  for (const name of packageNames) {
    const installed = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", name], { timeout: 10000 });
    if (!installed.ok || installedVersion(installed.stdout) !== approval.packages[name]) throw new Error(`The installed ${name} version does not match approval`);
  }
  const enabled = await run("/usr/bin/systemctl", ["enable", "libvirtd.service"], { timeout: 30000 });
  if (!enabled.ok) throw new Error("The virtualization packages were installed but libvirtd.service could not be enabled");
  const started = await run("/usr/bin/systemctl", ["start", "libvirtd.service"], { timeout: 120000 });
  if (!started.ok) throw new Error("The virtualization packages were installed but libvirtd.service could not be started");
  const active = await run("/usr/bin/systemctl", ["is-active", "--quiet", "libvirtd.service"], { timeout: 10000 });
  const uri = await run("/usr/bin/virsh", ["--connect", "qemu:///system", "uri"], { timeout: 15000 });
  const qemu = await run("/usr/bin/qemu-system-x86_64", ["--version"], { timeout: 10000 });
  if (!active.ok || uri.stdout !== "qemu:///system" || !/^QEMU emulator version\s+\S+/i.test(qemu.stdout)) throw new Error("The virtualization stack did not pass its service, system-URI, and QEMU probes");
  return { installed: true, packages: approval.packages, serviceActive: true, connectionUri: uri.stdout, qemuVerified: true, kvmDeviceVerified: true };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed virtualization installer accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await installApprovedVirtualization();
      console.log(`Installed the fixed virtualization package set and verified ${result.connectionUri}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const virtualizationInstallInternals = { candidateVersion, cleanVersion, exactPackageVersions, installedVersion, packageNames, parseApproval, versionPattern };
