import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { lstat, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { keelArtifactSpec, validUuid } from "./keel-artifact-spec.mjs";
import { createKeelStageHelper } from "./keel-stage-helper.mjs";
import {
  keelEnvironmentSha256,
  keelInstallPaths,
  keelServiceIdentity,
  keelServiceUnitSha256,
  keelEnvironmentContent,
  keelServiceUnitContent,
} from "./keel-install-spec.mjs";

const execFile = promisify(execFileCallback);
const defaultSystemctl = "/usr/bin/systemctl";
const defaultGetent = "/usr/bin/getent";
const defaultNsenter = "/usr/bin/nsenter";
const defaultCurl = "/usr/bin/curl";

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, {
      timeout,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : "",
      code: error.code ?? null,
    };
  }
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function readExactRegularFile(target, maximumBytes = 64 * 1024) {
  const value = await metadata(target);
  if (!value) return null;
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.size > maximumBytes) throw new Error("A fixed Keel installation file is unsafe");
  return { value: await readFile(target, "utf8"), metadata: value };
}

function boundary(mutationPerformed) {
  return {
    mutationPerformed,
    releaseExecuted: mutationPerformed,
    serviceChanged: mutationPerformed,
    accountChanged: mutationPerformed,
    applicationStateCreated: mutationPerformed,
    listenerChanged: mutationPerformed,
    registrationChanged: false,
    claimChanged: false,
    tailscaleChanged: false,
    firewallChanged: false,
    routerChanged: false,
    databaseOpened: false,
    secretRead: false,
    arbitraryPathAccepted: false,
    arbitraryCommandAccepted: false,
    browserEnvironmentAccepted: false,
  };
}

function parsePasswd(value) {
  const fields = String(value ?? "").trim().split(":");
  if (fields.length !== 7 || fields[0] !== keelServiceIdentity.account) return null;
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid, home: fields[5], shell: fields[6] };
}

function parseGroup(value) {
  const fields = String(value ?? "").trim().split(":");
  if (fields.length !== 4 || fields[0] !== keelServiceIdentity.group) return null;
  const gid = Number.parseInt(fields[2], 10);
  return Number.isInteger(gid) ? { gid } : null;
}

async function defaultAccountInspector(run = fixedRun) {
  const [passwdResult, groupResult] = await Promise.all([
    run(defaultGetent, ["passwd", keelServiceIdentity.account]),
    run(defaultGetent, ["group", keelServiceIdentity.group]),
  ]);
  const passwd = passwdResult.ok ? parsePasswd(passwdResult.stdout) : null;
  const group = groupResult.ok ? parseGroup(groupResult.stdout) : null;
  if (!passwd && !group) return { state: "absent", exact: false, uid: null, gid: null };
  const exact = Boolean(passwd && group
    && passwd.gid === group.gid
    && passwd.home === keelInstallPaths.state
    && ["/usr/sbin/nologin", "/sbin/nologin"].includes(passwd.shell));
  return { state: exact ? "exact" : "conflict", exact, uid: passwd?.uid ?? null, gid: group?.gid ?? null };
}

async function defaultHealthInspector(run = fixedRun) {
  const response = await run(defaultNsenter, [
    "--target", "1", "--net", "--", defaultCurl,
    "--silent", "--show-error", "--fail", "--max-time", "3",
    `http://${keelServiceIdentity.bindAddress}:${keelServiceIdentity.port}/api/health`,
  ], { timeout: 5000 });
  if (!response.ok || response.stdout.length > 8192) return false;
  try {
    const value = JSON.parse(response.stdout);
    return value?.app === "keel" && value?.ok === true;
  } catch {
    return false;
  }
}

function exactEvidence(value, paths = keelInstallPaths) {
  return value?.schemaVersion === 1
    && validUuid(value?.installId)
    && value?.releaseTag === keelArtifactSpec.releaseTag
    && value?.releaseCommitSha === keelArtifactSpec.releaseCommitSha
    && value?.releaseVersion === keelServiceIdentity.releaseVersion
    && value?.releasePath === paths.release
    && value?.statePath === paths.state
    && value?.unitName === keelServiceIdentity.unitName
    && value?.unitSha256 === keelServiceUnitSha256
    && value?.environmentSha256 === keelEnvironmentSha256
    && value?.bindAddress === keelServiceIdentity.bindAddress
    && value?.port === keelServiceIdentity.port
    && typeof value?.installedAt === "string"
    && Number.isFinite(Date.parse(value.installedAt));
}

export function createKeelInstallHelper({
  paths = keelInstallPaths,
  now = () => new Date(),
  run = fixedRun,
  systemctlBinary = defaultSystemctl,
  inspectAccount = () => defaultAccountInspector(run),
  inspectHealth = () => defaultHealthInspector(run),
  stageHelper = createKeelStageHelper(),
  expectedRootUid = 0,
} = {}) {
  async function inspect() {
    try {
      const [stage, account, currentMetadata, unitFile, environmentFile, stateMetadata, evidenceFile] = await Promise.all([
        stageHelper.inspect(),
        inspectAccount(),
        metadata(paths.current),
        readExactRegularFile(paths.unit),
        readExactRegularFile(paths.environment),
        metadata(paths.state),
        readExactRegularFile(paths.evidence),
      ]);
      const signals = Boolean(currentMetadata || unitFile || environmentFile || stateMetadata || evidenceFile || account.state !== "absent");
      if (!signals) {
        return {
          state: "absent", installed: false, readyToInstall: stage.state === "staged" && stage.staged === true,
          releaseVersion: stage.version ?? null, serviceActive: false, serviceEnabled: false, healthy: false,
          listener: "none", installedAt: null, installId: null, databasePresent: false, managedSecretKeyPresent: false,
          claim: { state: "not-applicable", terminalRequired: true },
          detail: stage.state === "staged" ? "The exact staged release is ready for a private native-service installation" : "Keel installation is absent and the fixed release must be staged first",
          boundary: boundary(false),
        };
      }
      const currentTarget = currentMetadata?.isSymbolicLink() ? path.resolve(path.dirname(paths.current), await readlink(paths.current)) : null;
      const currentExact = currentTarget === paths.release;
      const unitExact = unitFile?.value === keelServiceUnitContent() && (unitFile.metadata.mode & 0o7777) === 0o644;
      const environmentExact = environmentFile?.value === keelEnvironmentContent()
        && (environmentFile.metadata.mode & 0o7777) === 0o640
        && account.exact
        && environmentFile.metadata.uid === expectedRootUid
        && environmentFile.metadata.gid === account.gid;
      const stateExact = Boolean(stateMetadata?.isDirectory() && !stateMetadata.isSymbolicLink()
        && (stateMetadata.mode & 0o7777) === 0o700
        && account.exact
        && stateMetadata.uid === account.uid
        && stateMetadata.gid === account.gid);
      let evidence = null;
      try { evidence = evidenceFile ? JSON.parse(evidenceFile.value) : null; } catch {}
      const evidenceMatched = exactEvidence(evidence, paths);
      const [active, enabled, healthy, databaseMetadata, keyMetadata] = await Promise.all([
        run(systemctlBinary, ["is-active", "--quiet", keelServiceIdentity.unitName]),
        run(systemctlBinary, ["is-enabled", "--quiet", keelServiceIdentity.unitName]),
        inspectHealth(),
        metadata(paths.database),
        metadata(paths.managedSecretKey),
      ]);
      const databasePresent = Boolean(databaseMetadata?.isFile() && !databaseMetadata.isSymbolicLink());
      const managedSecretKeyPresent = Boolean(keyMetadata?.isFile() && !keyMetadata.isSymbolicLink());
      const staticExact = Boolean(currentExact && unitExact && environmentExact && stateExact && evidenceMatched && account.exact);
      const complete = staticExact && active.ok && enabled.ok && healthy && databasePresent;
      return {
        state: complete ? "installed" : staticExact ? "degraded" : "incomplete",
        installed: staticExact,
        readyToInstall: false,
        releaseVersion: evidenceMatched ? evidence.releaseVersion : null,
        serviceActive: active.ok,
        serviceEnabled: enabled.ok,
        healthy,
        listener: staticExact ? `${keelServiceIdentity.bindAddress}:${keelServiceIdentity.port}` : "unverified",
        installedAt: evidenceMatched ? evidence.installedAt : null,
        installId: evidenceMatched ? evidence.installId : null,
        databasePresent,
        managedSecretKeyPresent,
        account: { state: account.state, dedicated: account.exact },
        activation: { exact: currentExact, release: currentExact ? keelServiceIdentity.releaseVersion : null },
        unit: { exact: unitExact, hardened: unitExact },
        environment: { exact: environmentExact, containsBrowserInput: false },
        claim: { state: complete ? "unclaimed-or-unknown" : "unavailable", terminalRequired: true },
        detail: complete
          ? "Keel 1.2.6 is healthy on loopback under the dedicated keel account; terminal claim and private access handoff remain separate"
          : staticExact
            ? "The managed Keel installation is exact but its service or health identity needs repair"
            : "Keel installation signals exist but do not match the fixed BoxPilot service contract",
        boundary: boundary(false),
      };
    } catch {
      return {
        state: "unavailable", installed: false, readyToInstall: false, releaseVersion: null,
        serviceActive: false, serviceEnabled: false, healthy: false, listener: "unknown", installedAt: null, installId: null,
        databasePresent: false, managedSecretKeyPresent: false,
        claim: { state: "unavailable", terminalRequired: true },
        detail: "The fixed Keel installation boundary could not be inspected safely",
        boundary: boundary(false),
      };
    }
  }

  async function install(input) {
    const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
    if (keys.length !== 1 || keys[0] !== "installId" || !validUuid(input.installId)) throw new Error("Keel installation accepts only one installId UUID");
    const before = await inspect();
    if (before.state !== "absent" || before.readyToInstall !== true) throw new Error("Host state changed: the staged Keel release is not safely installable");
    await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await writeFile(paths.approval, `${JSON.stringify({
      installId: input.installId,
      approvedAt: now().toISOString(),
      releaseTag: keelArtifactSpec.releaseTag,
      releaseCommitSha: keelArtifactSpec.releaseCommitSha,
      releaseVersion: keelServiceIdentity.releaseVersion,
      releasePath: paths.release,
      statePath: paths.state,
      currentPath: paths.current,
      unitName: keelServiceIdentity.unitName,
      unitSha256: keelServiceUnitSha256,
      environmentSha256: keelEnvironmentSha256,
      bindAddress: keelServiceIdentity.bindAddress,
      port: keelServiceIdentity.port,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    let started;
    try {
      started = await run(systemctlBinary, ["start", "boxpilot-keel-install.service"], { timeout: 15 * 60 * 1000 });
    } finally {
      await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    if (!started.ok) throw new Error("The fixed Keel installation service failed; application state was preserved for recovery");
    const after = await inspect();
    if (after.installed !== true || after.installId !== input.installId || after.serviceActive !== true || after.serviceEnabled !== true || after.listener !== "127.0.0.1:3000") throw new Error("The fixed Keel installation did not produce complete matching evidence");
    return {
      installId: input.installId,
      installed: true,
      healthy: true,
      releaseVersion: keelServiceIdentity.releaseVersion,
      serviceActive: true,
      serviceEnabled: true,
      listener: `${keelServiceIdentity.bindAddress}:${keelServiceIdentity.port}`,
      statePreserved: true,
      claimRequired: true,
      privateAccessConfigured: false,
      boundary: boundary(true),
    };
  }

  return { inspect, install };
}

export const keelInstallHelperInternals = {
  boundary,
  defaultAccountInspector,
  defaultHealthInspector,
  exactEvidence,
  parseGroup,
  parsePasswd,
};
