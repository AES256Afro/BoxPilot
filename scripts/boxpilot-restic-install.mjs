#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const approvalPath = "/run/boxpilot/restic-approval.json";
const versionPattern = /^[0-9A-Za-z.+:~_-]{1,64}$/;
const fixedEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" };

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: fixedEnvironment });
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

function parseApproval(raw, now) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The restic approval marker is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "approvedAt,expectedVersion" || typeof value.approvedAt !== "string") throw new Error("The restic approval marker has unexpected fields");
  if (!versionPattern.test(String(value.expectedVersion ?? ""))) throw new Error("The approved restic version is invalid");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The restic approval marker is stale");
  return value;
}

export async function installApprovedRestic({
  run = fixedRun,
  loadApproval = () => readFile(approvalPath, "utf8"),
  now = () => new Date(),
} = {}) {
  const approval = parseApproval(await loadApproval(), now());
  const policy = await run("/usr/bin/apt-cache", ["policy", "restic"], { timeout: 10000 });
  const candidate = policy.ok ? candidateVersion(policy.stdout) : null;
  if (!candidate || candidate !== approval.expectedVersion) throw new Error("APT metadata changed after approval; no package was installed");
  const beforeResult = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", "restic"], { timeout: 10000 });
  const before = beforeResult.ok ? installedVersion(beforeResult.stdout) : null;
  if (before && before !== approval.expectedVersion) throw new Error("A different restic version is already installed; no package was changed");
  if (!before) {
    const installation = await run("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", `restic=${approval.expectedVersion}`], { timeout: 14 * 60 * 1000 });
    if (!installation.ok) throw new Error("The exact approved restic installation failed");
  }
  const afterResult = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", "restic"], { timeout: 10000 });
  if (!afterResult.ok || installedVersion(afterResult.stdout) !== approval.expectedVersion) throw new Error("The installed restic version does not match approval");
  const binary = await run("/usr/bin/restic", ["version"], { timeout: 10000 });
  if (!binary.ok || !/^restic\s+\S+/i.test(binary.stdout)) throw new Error("The installed restic binary did not pass its fixed version probe");
  return { installed: true, version: approval.expectedVersion, packageChanged: before === null, binaryVerified: true };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed restic installer accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await installApprovedRestic();
      console.log(`Installed and verified fixed restic package version ${result.version}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
