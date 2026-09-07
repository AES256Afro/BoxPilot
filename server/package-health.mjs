import { readFile, stat } from "node:fs/promises";
import { fixedRun } from "./exec.mjs";
import { createRedactor } from "./redaction.mjs";

export const packageLockFiles = Object.freeze(["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"]);

/** Linux dev_t and inode identify the lock, even when a process reports a different path. */
export function lockIdentity(info) {
  const device = BigInt(info.dev);
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return `${major.toString(16)}:${minor.toString(16)}:${info.ino}`;
}

export function parsePackageLocks(content, identities) {
  const locks = [];
  for (const line of String(content).split("\n").filter((line) => line.trim())) {
    if (/^\d+:\s+->/.test(line)) continue; // waiting, not holding
    const match = line.match(/^\d+:\s+\S+\s+\S+\s+(READ|WRITE)\s+(-?\d+)\s+([a-f\d]+):([a-f\d]+):(\d+)\s+/i);
    if (!match) throw new Error("Unrecognized kernel lock data");
    const identity = `${BigInt(`0x${match[3]}`).toString(16)}:${BigInt(`0x${match[4]}`).toString(16)}:${BigInt(match[5])}`;
    const file = identities.get(identity);
    if (file) locks.push({ file, pid: Number(match[2]) > 0 ? Number(match[2]) : null, mode: match[1] });
  }
  return locks;
}

export async function inspectPackageLocks({ read = readFile, statFile = stat } = {}) {
  try {
    const identities = new Map();
    await Promise.all(packageLockFiles.map(async (file) => {
      try { identities.set(lockIdentity(await statFile(file, { bigint: true })), file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }));
    const content = await read("/proc/locks", "utf8");
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("Kernel lock data exceeded the diagnostic limit");
    return { available: true, holders: parsePackageLocks(content, identities) };
  } catch { return { available: false, holders: [] }; }
}

/** Manual-only check: no repository refresh, downloads, database writes or lock deletion. */
export async function inspectPackageHealth({ run = fixedRun, inspectLocks = inspectPackageLocks, now = () => new Date() } = {}) {
  const locks = await inspectLocks();
  if (!locks.available || locks.holders.length) return { checkedAt: now().toISOString(), status: locks.available ? "busy" : "unknown", locks, audit: null, simulation: null, repairAvailable: false };
  const options = { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 };
  const [audit, simulation] = await Promise.all([
    run("/usr/bin/dpkg", ["--audit"], options),
    run("/usr/bin/apt-get", ["--simulate", "--fix-broken", "--no-remove", "install"], options),
  ]);
  const pending = /^(Inst|Conf|Remv)\s/m.test(simulation.stdout ?? "");
  const needsRepair = Boolean(audit.stdout?.trim()) || pending || /dpkg was interrupted|[Uu]nmet dependencies/.test(simulation.stderr ?? "");
  // An interrupted dpkg may prevent the simulation itself. Positive audit evidence still
  // permits configuration repair; APT's execution-time no-remove guard remains authoritative.
  const available = audit.ok && (simulation.ok || needsRepair);
  // Check again: a simulation does not acquire APT's locks, and another updater may have started.
  const afterLocks = await inspectLocks();
  const status = !afterLocks.available ? "unknown" : afterLocks.holders.length ? "busy" : !available ? "unknown" : needsRepair ? "needs-repair" : "healthy";
  const { redact } = createRedactor();
  const project = (result) => ({ ok: result.ok, detail: redact([result.stdout, result.stderr].filter(Boolean).join("\n")).slice(0, 16_384) });
  return { checkedAt: now().toISOString(), status, locks: afterLocks, audit: project(audit), simulation: project(simulation), repairAvailable: status === "needs-repair" };
}
