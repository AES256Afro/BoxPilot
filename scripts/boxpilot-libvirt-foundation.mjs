#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createLibvirtFoundationHelper, libvirtFoundationInternals, libvirtFoundationSpec } from "../server/libvirt-foundation-helper.mjs";

const execFile = promisify(execFileCallback);
const approvalPath = "/run/boxpilot/libvirt-foundation-approval.json";
const fixedEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const networkXml = `<network>
  <name>default</name>
  <forward mode='nat'/>
  <bridge name='virbr0' stp='on' delay='0'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='192.168.122.2' end='192.168.122.254'/>
    </dhcp>
  </ip>
</network>
`;

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 512 * 1024, encoding: "utf8", env: fixedEnvironment });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", stderr: typeof error.stderr === "string" ? error.stderr.trim() : error.message };
  }
}

function parseApproval(raw, currentTime) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The libvirt foundation approval marker is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "approvedAt,expectedRevision,foundationId") {
    throw new Error("The libvirt foundation approval marker has unexpected fields");
  }
  if (!libvirtFoundationInternals.uuidPattern.test(String(value.foundationId ?? "")) || !libvirtFoundationInternals.revisionPattern.test(String(value.expectedRevision ?? "")) || typeof value.approvedAt !== "string") {
    throw new Error("The libvirt foundation approval marker has invalid identity fields");
  }
  const approvedTime = Date.parse(value.approvedAt);
  const age = currentTime.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The libvirt foundation approval marker is stale");
  return value;
}

export async function initializeApprovedLibvirtFoundation({
  run = fixedRun,
  loadApproval = () => readFile(approvalPath, "utf8"),
  now = () => new Date(),
  createWorkspace = () => mkdtemp(path.join(tmpdir(), "boxpilot-libvirt-foundation.")),
  writeNetworkXml = (xmlPath) => writeFile(xmlPath, networkXml, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  removeWorkspace = (workspace) => rm(workspace, { recursive: true, force: true }),
  removeEmptyTarget = () => rmdir(libvirtFoundationSpec.poolTarget),
  inspector = createLibvirtFoundationHelper({ run }),
} = {}) {
  const approval = parseApproval(await loadApproval(), now());
  const before = await inspector.inspect();
  if (before.revision !== approval.expectedRevision) throw new Error("Host state changed after approval; no libvirt resource was changed");
  if (before.ready) throw new Error("The canonical libvirt foundation is already ready; no resource was changed");
  if (!before.planAvailable) throw new Error(before.conflicts[0] ?? "The canonical libvirt foundation cannot be initialized safely");
  const changed = { networkDefined: false, networkStarted: false, networkAutostart: false, poolTargetCreated: false, poolDefined: false, poolStarted: false, poolAutostart: false };
  let workspace = null;
  const virsh = (args, timeout = 30000) => run("/usr/bin/virsh", ["--connect", libvirtFoundationSpec.connectionUri, ...args], { timeout });
  try {
    if (!before.network.exists) {
      workspace = await createWorkspace();
      const xmlPath = path.join(workspace, "default-network.xml");
      await writeNetworkXml(xmlPath);
      const defined = await virsh(["net-define", xmlPath]);
      if (!defined.ok) throw new Error("The fixed default network could not be defined");
      changed.networkDefined = true;
    }
    if (!before.network.active) {
      const started = await virsh(["net-start", libvirtFoundationSpec.networkName], 60000);
      if (!started.ok) throw new Error("The fixed default network could not be started");
      changed.networkStarted = true;
    }
    if (!before.network.autostart) {
      const enabled = await virsh(["net-autostart", libvirtFoundationSpec.networkName]);
      if (!enabled.ok) throw new Error("The fixed default network autostart could not be enabled");
      changed.networkAutostart = true;
    }
    if (!before.pool.exists) {
      if (!before.pool.target.exists) {
        const directory = await run("/usr/bin/install", ["-d", "-o", "root", "-g", "root", "-m", "0755", libvirtFoundationSpec.poolTarget], { timeout: 10000 });
        if (!directory.ok) throw new Error("The fixed libvirt image directory could not be created");
        changed.poolTargetCreated = true;
      }
      const defined = await virsh(["pool-define-as", libvirtFoundationSpec.poolName, "dir", "--target", libvirtFoundationSpec.poolTarget]);
      if (!defined.ok) throw new Error("The fixed default storage pool could not be defined");
      changed.poolDefined = true;
    }
    if (!before.pool.active) {
      const started = await virsh(["pool-start", libvirtFoundationSpec.poolName], 60000);
      if (!started.ok) throw new Error("The fixed default storage pool could not be started");
      changed.poolStarted = true;
    }
    if (!before.pool.autostart) {
      const enabled = await virsh(["pool-autostart", libvirtFoundationSpec.poolName]);
      if (!enabled.ok) throw new Error("The fixed default storage pool autostart could not be enabled");
      changed.poolAutostart = true;
    }
    const after = await inspector.inspect();
    if (!after.ready) throw new Error("The fixed default network and pool failed final readiness verification");
    return { foundationId: approval.foundationId, ready: true, changed };
  } catch (error) {
    const rollbackErrors = [];
    async function rollback(args) {
      const result = await virsh(args, 60000);
      if (!result.ok) rollbackErrors.push(args.join(" "));
    }
    if (changed.poolAutostart) await rollback(["pool-autostart", libvirtFoundationSpec.poolName, "--disable"]);
    if (changed.poolStarted) await rollback(["pool-destroy", libvirtFoundationSpec.poolName]);
    if (changed.poolDefined) await rollback(["pool-undefine", libvirtFoundationSpec.poolName]);
    if (changed.poolTargetCreated) await removeEmptyTarget().catch(() => rollbackErrors.push("remove empty pool target"));
    if (changed.networkAutostart) await rollback(["net-autostart", libvirtFoundationSpec.networkName, "--disable"]);
    if (changed.networkStarted) await rollback(["net-destroy", libvirtFoundationSpec.networkName]);
    if (changed.networkDefined) await rollback(["net-undefine", libvirtFoundationSpec.networkName]);
    const suffix = rollbackErrors.length ? ` Automatic rollback was incomplete: ${rollbackErrors.join(", ")}.` : " Automatic rollback completed.";
    throw new Error(`${error.message}${suffix}`);
  } finally {
    if (workspace) await removeWorkspace(workspace).catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed libvirt foundation initializer accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await initializeApprovedLibvirtFoundation();
      console.log(`Verified fixed libvirt foundation ${result.foundationId}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const libvirtFoundationScriptInternals = { networkXml, parseApproval };
