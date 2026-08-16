#!/usr/local/bin/node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { lstat, readFile, readlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { keelArtifactSpec } from "../server/keel-artifact-spec.mjs";
import {
  keelEnvironmentContent,
  keelEnvironmentSha256,
  keelInstallPaths,
  keelServiceIdentity,
  keelServiceUnitSha256,
} from "../server/keel-install-spec.mjs";

const getentBinary = "/usr/bin/getent";
const systemctlBinary = "/usr/bin/systemctl";
const claimPattern = /^keel_claim_[A-Za-z0-9_-]{43}$/;

function parsePasswd(value) {
  const fields = String(value ?? "").trim().split(":");
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (fields.length !== 7 || fields[0] !== keelServiceIdentity.account || !Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid, home: fields[5], shell: fields[6] };
}

function parseGroup(value) {
  const fields = String(value ?? "").trim().split(":");
  const gid = Number.parseInt(fields[2], 10);
  if (fields.length !== 4 || fields[0] !== keelServiceIdentity.group || !Number.isInteger(gid)) return null;
  return { gid };
}

function defaultAccount() {
  try {
    const passwd = parsePasswd(execFileSync(getentBinary, ["passwd", keelServiceIdentity.account], { encoding: "utf8", timeout: 5000 }));
    const group = parseGroup(execFileSync(getentBinary, ["group", keelServiceIdentity.group], { encoding: "utf8", timeout: 5000 }));
    if (!passwd || !group || passwd.gid !== group.gid || passwd.home !== keelInstallPaths.state || !["/usr/sbin/nologin", "/sbin/nologin"].includes(passwd.shell)) return null;
    return { uid: passwd.uid, gid: group.gid };
  } catch {
    return null;
  }
}

function defaultServiceActive() {
  try {
    execFileSync(systemctlBinary, ["is-active", "--quiet", keelServiceIdentity.unitName], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function requireRegular(target, { uid, gid, mode, label }) {
  const value = await lstat(target);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== uid || value.gid !== gid || (value.mode & 0o7777) !== mode) {
    throw new Error(`${label} does not match the fixed private installation boundary`);
  }
  return value;
}

async function verifyBoundary({ paths, account, rootUid, serviceActive }) {
  const current = await lstat(paths.current);
  if (!current.isSymbolicLink() || path.resolve(path.dirname(paths.current), await readlink(paths.current)) !== paths.release) {
    throw new Error("The fixed Keel activation link is unavailable or changed");
  }
  await requireRegular(paths.environment, { uid: rootUid, gid: account.gid, mode: 0o640, label: "The Keel environment" });
  if (await readFile(paths.environment, "utf8") !== keelEnvironmentContent()) throw new Error("The fixed Keel environment content changed");
  await requireRegular(paths.database, { uid: account.uid, gid: account.gid, mode: 0o600, label: "The Keel database" });
  await requireRegular(paths.evidence, { uid: rootUid, gid: account.gid, mode: 0o640, label: "The Keel installation evidence" });
  let evidence;
  try { evidence = JSON.parse(await readFile(paths.evidence, "utf8")); } catch { throw new Error("The Keel installation evidence is invalid"); }
  const exact = evidence?.schemaVersion === 1
    && evidence?.releaseTag === keelArtifactSpec.releaseTag
    && evidence?.releaseCommitSha === keelArtifactSpec.releaseCommitSha
    && evidence?.releaseVersion === keelServiceIdentity.releaseVersion
    && evidence?.releasePath === paths.release
    && evidence?.statePath === paths.state
    && evidence?.unitName === keelServiceIdentity.unitName
    && evidence?.unitSha256 === keelServiceUnitSha256
    && evidence?.environmentSha256 === keelEnvironmentSha256
    && evidence?.bindAddress === keelServiceIdentity.bindAddress
    && evidence?.port === keelServiceIdentity.port
    && evidence?.healthIdentityVerified === true
    && evidence?.claimRequired === true;
  if (!exact) throw new Error("The Keel installation evidence changed");
  if (!serviceActive()) throw new Error("The fixed Keel service must be active before it can be claimed");
}

export async function claimInstalledKeel({
  token,
  paths = keelInstallPaths,
  rootUid = 0,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  sudoUid = process.env.SUDO_UID,
  stdinTty = process.stdin.isTTY,
  stdoutTty = process.stdout.isTTY,
  inspectAccount = defaultAccount,
  serviceActive = defaultServiceActive,
  setGroups = (groups) => process.setgroups(groups),
  setGid = (gid) => process.setgid(gid),
  setUid = (userId) => process.setuid(userId),
  runClaim,
} = {}) {
  if (!claimPattern.test(String(token ?? ""))) throw new Error("Paste one current five-minute Keel claim token as the only argument");
  if (uid !== 0 || !/^\d+$/.test(String(sudoUid ?? "")) || Number(sudoUid) <= 0) throw new Error("Run this command from a normal Bigbox administrator account through fresh sudo, not from a root login");
  if (!stdinTty || !stdoutTty) throw new Error("Keel claim must run interactively in a Bigbox terminal");
  const account = await inspectAccount();
  if (!account) throw new Error("The dedicated Keel service account is unavailable or changed");
  await verifyBoundary({ paths, account, rootUid, serviceActive });
  setGroups([account.gid]);
  setGid(account.gid);
  setUid(account.uid);
  const execute = runClaim ?? (async (options) => {
    const claimModule = await import(pathToFileURL(path.join(paths.release, "server", "scripts", "claim-instance.mjs")).href);
    return claimModule.runClaimFlow(options, { authorize: async () => "boxpilot-terminal-sudo" });
  });
  return execute({
    token,
    appRoot: paths.release,
    envFile: paths.environment,
    defaultDatabase: paths.database,
    processEnvironment: {
      DATABASE_URL: `file:${paths.database}`,
      KEEL_ENV_FILE: paths.environment,
      KEEL_HOME: paths.state,
    },
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error("Usage: sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-claim.mjs 'keel_claim_TOKEN'");
    process.exitCode = 64;
  } else {
    try {
      await claimInstalledKeel({ token: process.argv[2] });
    } catch (error) {
      console.error(`Keel claim failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

export const keelClaimInternals = { claimPattern, parseGroup, parsePasswd, verifyBoundary };
