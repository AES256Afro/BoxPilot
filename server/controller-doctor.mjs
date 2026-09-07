import { lstat, readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";

export const controllerDoctorPaths = Object.freeze({
  install: process.env.BOXPILOT_INSTALL_DIR ?? "/opt/boxpilot",
  state: process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot",
  socket: process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock",
  logs: process.env.BOXPILOT_JOB_LOG_DIRECTORY ?? "/run/boxpilot/logs",
});
const serviceProperties = "ActiveState,SubState,NRestarts,MainPID,Result,User,Group";
const fields = (text) => Object.fromEntries(String(text).split("\n").filter((line) => line.includes("=")).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));

export function summarizeDoctor(checks) {
  const counts = { pass: 0, warning: 0, fail: 0, unknown: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { counts, status: counts.fail ? "needs-attention" : counts.unknown ? "incomplete" : counts.warning ? "warning" : "ready" };
}

/** Fixed metadata checks. Does not read configuration, logs, credentials or the database contents. */
export async function inspectControllerFiles({ paths = controllerDoctorPaths, run = fixedRun, inspect = lstat, read = readFile, filesystem = statfs, platform = process.platform, nodeVersion = process.versions.node, now = () => new Date() } = {}) {
  const checks = [];
  const add = (id, title, status, detail, next = null) => checks.push({ id, title, status, detail, next });
  add("platform", "Linux host", platform === "linux" ? "pass" : "fail", `Detected ${platform}`, platform === "linux" ? null : "Run this doctor on the Ubuntu server.");
  add("node", "Doctor Node.js runtime", Number(nodeVersion.split(".")[0]) >= 24 ? "pass" : "fail", `Node.js ${nodeVersion}`, "The installed services also need Node.js 24 or newer.");
  const serviceUser = process.env.BOXPILOT_SERVICE_USER ?? "boxpilot";
  const [user, group, web, helper] = await Promise.all([
    run("/usr/bin/id", ["-u", serviceUser], { timeout: 5000 }),
    run("/usr/bin/id", ["-g", serviceUser], { timeout: 5000 }),
    run("/usr/bin/systemctl", ["show", "boxpilot.service", `--property=${serviceProperties}`], { timeout: 5000 }),
    run("/usr/bin/systemctl", ["show", "boxpilot-helper.service", `--property=${serviceProperties}`], { timeout: 5000 }),
  ]);
  const uid = user.ok && /^\d+$/.test(user.stdout?.trim()) ? Number(user.stdout) : null;
  const gid = group.ok && /^\d+$/.test(group.stdout?.trim()) ? Number(group.stdout) : null;
  add("account", "Service account", uid !== null && gid !== null ? "pass" : "unknown", uid !== null && gid !== null ? "Service user and primary group resolved" : "Could not resolve the service account", "Check the installed service account and unit configuration.");
  for (const [id, title, result, expectedUser] of [["web-service", "Web service", web, serviceUser], ["helper-service", "Root helper service", helper, "root"]]) {
    const state = fields(result.stdout);
    const known = result.ok && Boolean(state.ActiveState);
    const running = known && state.ActiveState === "active" && state.SubState === "running";
    add(id, title, !known ? "unknown" : running ? "pass" : "fail", known ? `${state.ActiveState}/${state.SubState}; restarts ${state.NRestarts ?? "unknown"}` : "systemd did not return service state", `Review systemctl status ${id === "web-service" ? "boxpilot.service" : "boxpilot-helper.service"} and its journal before restarting it.`);
    if (known) add(`${id}-identity`, `${title} identity`, (state.User || "root") === expectedUser ? "pass" : "fail", (state.User || "root") === expectedUser ? "Unit uses the expected account" : "Unit runs as an unexpected account", "Compare the installed unit with the matching release's deploy directory.");
  }
  async function metadata(id, title, file, type, owner, groupId, mode, { optional = false } = {}) {
    try {
      const info = await inspect(file);
      const correctType = !info.isSymbolicLink() && (type === "directory" ? info.isDirectory() : type === "socket" ? info.isSocket() : info.isFile());
      if (!correctType) { add(id, title, "fail", "Unexpected file type or symbolic link", "Inspect this path before changing permissions or replacing it."); return; }
      if (owner === null || (groupId === null && type !== "file")) { add(id, title, "unknown", "Present; account ownership could not be checked", "Resolve the service account, then check again."); return; }
      const correct = info.uid === owner && (groupId === undefined || info.gid === groupId) && (info.mode & 0o7777) === mode;
      add(id, title, correct ? "pass" : "fail", `Mode ${(info.mode & 0o7777).toString(8)}; ${correct ? "expected ownership" : "ownership or mode differs from the release"}`, correct ? null : "Compare ownership and permissions with the installed release before correcting this specific path.");
    } catch (error) {
      add(id, title, error.code === "ENOENT" ? optional ? "warning" : "fail" : "unknown", error.code === "ENOENT" ? optional ? "Not created yet" : "Required path is missing" : "Metadata cannot be read from this account", error.code === "EACCES" ? "Run the independent doctor with sudo to inspect protected metadata." : "Review the install and service journal.");
    }
  }
  await metadata("state-directory", "State directory", paths.state, "directory", uid, undefined, 0o700);
  await metadata("helper-socket", "Helper socket", paths.socket, "socket", 0, gid, 0o660);
  await metadata("job-log-directory", "Live job log directory", paths.logs, "directory", 0, gid, 0o750, { optional: true });
  let installedVersion = null;
  try {
    const packageFile = path.join(paths.install, "package.json");
    const info = await inspect(packageFile);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("Invalid release metadata");
    const version = JSON.parse(await read(packageFile, "utf8")).version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Invalid release version");
    installedVersion = version;
    add("release", "Installed release", "pass", version);
  } catch { add("release", "Installed release", "unknown", "Release metadata is missing or unreadable", "Recover the complete matching release; preserve the existing state and configuration."); }
  for (const relative of ["server/index.mjs", "server/helper-server.mjs", "dist/index.html", "node_modules/express/package.json"]) {
    try {
      const info = await inspect(path.join(paths.install, relative));
      add(`asset:${relative}`, relative, info.isFile() && info.size > 0 ? "pass" : "fail", info.isFile() && info.size > 0 ? "Present" : "Missing or empty release file", "Rebuild or restore the complete compatible release before restarting services.");
    } catch (error) { add(`asset:${relative}`, relative, error.code === "ENOENT" ? "fail" : "unknown", "Release file could not be read", "Check the installed release and its build/dependencies."); }
  }
  let capacity = null;
  try {
    const fs = await filesystem(paths.state);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const freeInodes = Number(fs.ffree);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(freeInodes)) throw new Error("Invalid filesystem counters");
    capacity = { freeBytes, freeInodes };
    add("free-space", "State filesystem free space", freeBytes < 100 * 1024 ** 2 ? "fail" : freeBytes < 1024 ** 3 ? "warning" : "pass", `${Math.round(freeBytes / 1024 ** 2)} MiB available`, "Review Storage and backup retention before removing data.");
    // Some filesystems have no finite inode pool. Zero total means this metric is not applicable.
    add("free-inodes", "State filesystem free inodes", Number(fs.files) === 0 ? "pass" : freeInodes < 100 ? "fail" : freeInodes < 1000 ? "warning" : "pass", Number(fs.files) === 0 ? "Filesystem has no fixed inode limit" : `${freeInodes} free`, "Many small files can exhaust inodes even when bytes remain free.");
  } catch { add("capacity", "State filesystem capacity", "unknown", "Free space and inodes could not be read", "Inspect the state directory and its mount."); }
  return { checkedAt: now().toISOString(), installedVersion, capacity, checks, ...summarizeDoctor(checks) };
}

export function addControllerConnectivity(report, { web = null, helper = null, webError = null, helperError = null } = {}) {
  const checks = [...report.checks];
  const check = (id, title, value, version, error) => {
    const valid = value && typeof version === "string" && Boolean(version);
    const matches = valid && report.installedVersion && version === report.installedVersion;
    checks.push({ id, title, status: !valid ? "unknown" : !report.installedVersion ? "unknown" : matches ? "pass" : "fail", detail: valid ? `Running ${version}${matches ? "; matches installed release" : "; compare with installed release"}` : error ?? "No valid response", next: "Check the service journal. Restart only after confirming that its installed release and database are compatible." });
  };
  check("web-response", "Web health response", web?.product === "BoxPilot" && web?.status === "ok", web?.version, webError);
  check("helper-response", "Helper response", helper, helper?.version, helperError);
  return { ...report, checks, ...summarizeDoctor(checks) };
}
