#!/usr/local/bin/node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const approvalPath = "/run/boxpilot/apt-refresh-approval.json";
const aptListsPath = "/var/lib/apt/lists";
const dpkgStatusPath = "/var/lib/dpkg/status";
const dpkgUpdatesPath = "/var/lib/dpkg/updates";
const fixedEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" };

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    await execFile(binary, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", env: fixedEnvironment });
    return { ok: true };
  } catch { return { ok: false }; }
}

function parseApproval(raw, now) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The APT refresh approval marker is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "approvedAt,expectedUpdatedAt" || typeof value.approvedAt !== "string" || !(value.expectedUpdatedAt === null || typeof value.expectedUpdatedAt === "string")) throw new Error("The APT refresh approval marker has unexpected fields");
  if (value.expectedUpdatedAt !== null && !Number.isFinite(Date.parse(value.expectedUpdatedAt))) throw new Error("The approved APT metadata timestamp is invalid");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The APT refresh approval marker is stale");
  return value;
}

function digest(contents) { return createHash("sha256").update(contents).digest("hex"); }

export async function refreshApprovedAptMetadata({
  run = fixedRun,
  loadApproval = () => readFile(approvalPath, "utf8"),
  loadDpkgStatus = () => readFile(dpkgStatusPath),
  readDpkgUpdates = () => readdir(dpkgUpdatesPath),
  getAptListsStat = () => stat(aptListsPath),
  now = () => new Date(),
} = {}) {
  const approval = parseApproval(await loadApproval(), now());
  const beforeStat = await getAptListsStat().catch(() => null);
  const beforeUpdatedAt = beforeStat?.mtime instanceof Date ? beforeStat.mtime.toISOString() : null;
  if (beforeUpdatedAt !== approval.expectedUpdatedAt) throw new Error("APT metadata changed after approval; no refresh was started");
  const beforeFragments = (await readDpkgUpdates()).filter((entry) => /^\d{4}$/.test(entry));
  if (beforeFragments.length > 0) throw new Error("dpkg has pending update fragments; no APT refresh was started");
  const beforeStatusDigest = digest(await loadDpkgStatus());
  const refresh = await run("/usr/bin/apt-get", ["update", "--error-on=any"], { timeout: 14 * 60 * 1000 });
  if (!refresh.ok) throw new Error("The fixed APT metadata refresh failed");
  const afterFragments = (await readDpkgUpdates()).filter((entry) => /^\d{4}$/.test(entry));
  if (afterFragments.length > 0) throw new Error("dpkg state changed during the APT metadata refresh");
  const afterStatusDigest = digest(await loadDpkgStatus());
  if (afterStatusDigest !== beforeStatusDigest) throw new Error("The installed package database changed during the APT metadata refresh");
  const afterStat = await getAptListsStat();
  if (!(afterStat?.mtime instanceof Date)) throw new Error("APT metadata timestamp is unavailable after refresh");
  const updatedAt = afterStat.mtime.toISOString();
  const age = now().getTime() - afterStat.mtime.getTime();
  if (age < -5 * 60 * 1000 || age > 5 * 60 * 1000) throw new Error("APT metadata did not become current after refresh");
  return { refreshed: true, updatedAt, packageDatabaseUnchanged: true };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed APT metadata refresher accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await refreshApprovedAptMetadata();
      console.log(`Refreshed fixed APT metadata at ${result.updatedAt}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
