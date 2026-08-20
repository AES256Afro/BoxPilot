import { access, readFile, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side system tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service.
 * The helper runs with ProtectSystem=strict and PrivateNetwork=true, so anything that writes
 * under /etc or talks to hostnamed/timedated lands here. Each task re-validates its parameters.
 */

export const hostnamePattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const timezonePattern = /^[A-Za-z_][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const hostsPath = "/etc/hosts";
const sysctlDropInPath = "/etc/sysctl.d/99-boxpilot.conf";

/**
 * Schedule a reboot a few seconds out so the runner can still write its result file and the
 * helper can report success before the machine goes down.
 */
export async function systemReboot({ delaySeconds = 5 } = {}, { run = fixedRun, log = null } = {}) {
  log?.(`Scheduling reboot in ${delaySeconds}s`, "stdout");
  const delay = Number.isInteger(delaySeconds) && delaySeconds >= 2 && delaySeconds <= 300 ? delaySeconds : 5;
  const result = await run("/usr/bin/systemd-run", ["--quiet", "--on-active", String(delay), "--unit", "boxpilot-reboot", "/usr/bin/systemctl", "reboot"], { timeout: 30_000 });
  if (!result.ok) throw new Error(`Could not schedule the reboot: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { scheduled: true, inSeconds: delay };
}

/** Replace the 127.0.1.1 line Ubuntu uses for the host's own name; append one if missing. */
export function rewriteHostsFile(content, hostname) {
  const lines = String(content ?? "").split("\n");
  const index = lines.findIndex((line) => /^127\.0\.1\.1\s/.test(line));
  const entry = `127.0.1.1\t${hostname}`;
  if (index === -1) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push(entry, "");
  } else {
    lines[index] = entry;
  }
  return lines.join("\n");
}

export async function setHostname({ hostname } = {}, { run = fixedRun, log = null, files = { readFile, writeFile } } = {}) {
  if (typeof hostname !== "string" || hostname.length > 253 || !hostnamePattern.test(hostname)) throw new Error("Hostname must be lower-case letters, digits, and hyphens (dot-separated labels allowed)");
  const previous = (await files.readFile("/etc/hostname", "utf8").catch(() => "")).trim() || null;
  log?.(`$ hostnamectl set-hostname ${hostname}`, "stdout");
  const result = await run("/usr/bin/hostnamectl", ["set-hostname", hostname], { timeout: 30_000 });
  if (!result.ok) throw new Error(`hostnamectl failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  try {
    const hosts = await files.readFile(hostsPath, "utf8");
    await files.writeFile(hostsPath, rewriteHostsFile(hosts, hostname));
    log?.(`Updated ${hostsPath} 127.0.1.1 entry`, "stdout");
  } catch (error) {
    log?.(`Could not update ${hostsPath}: ${error.message}`, "stderr");
  }
  return { hostname, previous };
}

export async function setTimezone({ timezone } = {}, { run = fixedRun, log = null, exists = (target) => access(target).then(() => true, () => false) } = {}) {
  if (typeof timezone !== "string" || timezone.length > 64 || !timezonePattern.test(timezone)) throw new Error("Time zone must be an IANA name like Europe/Berlin");
  if (!(await exists(`/usr/share/zoneinfo/${timezone}`))) throw new Error(`Time zone ${timezone} is not installed on this system`);
  log?.(`$ timedatectl set-timezone ${timezone}`, "stdout");
  const result = await run("/usr/bin/timedatectl", ["set-timezone", timezone], { timeout: 30_000 });
  if (!result.ok) throw new Error(`timedatectl failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { timezone };
}

/** Replace or append one `key = value` line in a sysctl drop-in, preserving everything else. */
export function rewriteSysctlDropIn(content, key, value) {
  const lines = String(content ?? "").split("\n").filter((line, index, all) => !(line === "" && index === all.length - 1));
  const pattern = new RegExp(`^\\s*${key.replaceAll(".", "\\.")}\\s*=`);
  const entry = `${key} = ${value}`;
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) {
    if (lines.length === 0) lines.push("# Managed by BoxPilot (System page). Other lines are preserved.");
    lines.push(entry);
  } else {
    lines[index] = entry;
  }
  return `${lines.join("\n")}\n`;
}

/** Set the system LANG to an already-generated locale. */
export async function setLocale({ locale } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof locale !== "string" || !/^[A-Za-z][A-Za-z0-9_.@-]{1,31}$/.test(locale)) throw new Error("Locale is invalid");
  const generated = await run("/usr/bin/locale", ["-a"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const available = generated.ok ? generated.stdout.split("\n").map((line) => line.trim()) : [];
  if (!available.includes(locale)) throw new Error(`Locale ${locale} is not generated on this system`);
  log?.(`$ update-locale LANG=${locale}`, "stdout");
  const result = await run("/usr/sbin/update-locale", [`LANG=${locale}`], { timeout: 30_000 });
  if (!result.ok) throw new Error(`update-locale failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { locale, appliesTo: "new sessions and services after their next restart" };
}

const dockerDaemonPath = "/etc/docker/daemon.json";

/** Merge sane logging defaults into daemon.json without touching other keys; exported for tests. */
export function mergeDockerLoggingDefaults(content) {
  let config = {};
  try { config = JSON.parse(content || "{}"); } catch { throw new Error(`${dockerDaemonPath} contains invalid JSON; fix it by hand first`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${dockerDaemonPath} must contain a JSON object`);
  return {
    ...config,
    "log-driver": "json-file",
    "log-opts": { ...(config["log-opts"] ?? {}), "max-size": "10m", "max-file": "3" },
    "live-restore": true,
  };
}

/** Apply log rotation + live-restore defaults and restart dockerd. */
export async function dockerLoggingDefaults(_parameters = {}, { run = fixedRun, log = null, files = { readFile, writeFile } } = {}) {
  const existing = await files.readFile(dockerDaemonPath, "utf8").catch(() => "");
  const merged = mergeDockerLoggingDefaults(existing);
  await files.writeFile(dockerDaemonPath, `${JSON.stringify(merged, null, 2)}\n`);
  log?.(`Wrote ${dockerDaemonPath}; restarting dockerd`, "stdout");
  const restart = await run("/usr/bin/systemctl", ["restart", "docker.service"], { timeout: 3 * 60_000 });
  if (!restart.ok) throw new Error(`docker restart failed: ${restart.stderr.split("\n").slice(-2).join(" ")}`);
  return { applied: true, config: { logDriver: merged["log-driver"], logOpts: merged["log-opts"], liveRestore: merged["live-restore"] }, note: "Log limits apply to containers created from now on; live-restore keeps containers up through future daemon restarts" };
}

export async function setSwappiness({ value } = {}, { run = fixedRun, log = null, files = { readFile, writeFile } } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("Swappiness must be a whole number between 0 and 100");
  const existing = await files.readFile(sysctlDropInPath, "utf8").catch(() => "");
  await files.writeFile(sysctlDropInPath, rewriteSysctlDropIn(existing, "vm.swappiness", value));
  log?.(`Wrote vm.swappiness = ${value} to ${sysctlDropInPath}`, "stdout");
  const result = await run("/usr/sbin/sysctl", ["-w", `vm.swappiness=${value}`], { timeout: 15_000 });
  if (!result.ok) throw new Error(`sysctl failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { swappiness: value, persisted: sysctlDropInPath };
}
