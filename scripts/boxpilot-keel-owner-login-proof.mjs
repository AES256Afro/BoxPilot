#!/usr/local/bin/node
import { execFileSync, fork } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keelClaimInternals } from "./boxpilot-keel-claim.mjs";
import { exactKeelOwnerLoginProof } from "../server/keel-login-proof-helper.mjs";
import { keelInstallPaths, keelServiceIdentity } from "../server/keel-install-spec.mjs";

const getentBinary = "/usr/bin/getent";
const systemctlBinary = "/usr/bin/systemctl";
const baseUrl = `http://${keelServiceIdentity.bindAddress}:${keelServiceIdentity.port}`;
const workerFlag = "--credential-worker";

export class KeelSecondFactorRequiredError extends Error {}

async function defaultDatabaseIdentity() {
  const metadata = await lstat(keelInstallPaths.database);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || !Number.isSafeInteger(metadata.dev) || metadata.dev < 0
    || !Number.isSafeInteger(metadata.ino) || metadata.ino <= 0) {
    throw new Error("Keel's fixed active database identity is unsafe");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function defaultAccount() {
  try {
    const passwd = keelClaimInternals.parsePasswd(execFileSync(getentBinary, ["passwd", keelServiceIdentity.account], { encoding: "utf8", timeout: 5000 }));
    const group = keelClaimInternals.parseGroup(execFileSync(getentBinary, ["group", keelServiceIdentity.group], { encoding: "utf8", timeout: 5000 }));
    if (!passwd || !group || passwd.gid !== group.gid || passwd.home !== keelInstallPaths.state
      || !["/usr/sbin/nologin", "/sbin/nologin"].includes(passwd.shell)) return null;
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

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function serializedServerAction(source, property) {
  const decoded = source.replaceAll('\\"', '"').replaceAll("\\n", "\n");
  const propertyMatches = [...decoded.matchAll(new RegExp(`"${property}":"\\$h([0-9a-z]+)"`, "g"))];
  if (propertyMatches.length !== 1) return null;
  const reference = propertyMatches[0][1];
  const idMatches = [...decoded.matchAll(new RegExp(`(?:^|[\\n"])${reference}:\\{"id":"([a-f0-9]{40,64})","bound":null\\}`, "g"))];
  return idMatches.length === 1 ? { fields: [[`$ACTION_ID_${idMatches[0][1]}`, ""]] } : null;
}

function validateProgressiveActionFields(fields) {
  const reference = fields.find(([name]) => /^\$ACTION_REF_\d+$/.test(name));
  if (!reference || reference[1] !== "") return false;
  const index = reference[0].slice("$ACTION_REF_".length);
  const expected = [`$ACTION_${index}:0`, `$ACTION_${index}:1`, "$ACTION_KEY", `$ACTION_REF_${index}`].sort();
  if (fields.length !== expected.length || fields.map(([name]) => name).sort().some((name, position) => name !== expected[position])) return false;
  const values = new Map(fields);
  let binding;
  let state;
  try {
    binding = JSON.parse(values.get(`$ACTION_${index}:0`));
    state = JSON.parse(values.get(`$ACTION_${index}:1`));
  } catch {
    return false;
  }
  return binding && typeof binding === "object" && !Array.isArray(binding)
    && Object.keys(binding).sort().join(",") === "bound,id"
    && /^[a-f0-9]{40,64}$/.test(binding.id)
    && binding.bound === `$@${index}`
    && Array.isArray(state) && state.length === 1 && state[0] === "$undefined"
    && /^[a-f0-9]{32}$/.test(values.get("$ACTION_KEY") ?? "");
}

export function extractServerAction(html, { formText, serializedProperty } = {}) {
  const source = String(html ?? "");
  const scopes = formText
    ? (source.match(/<form\b[\s\S]*?<\/form>/gi) ?? []).filter((form) => form.includes(formText))
    : [source];
  const actionFields = [];
  for (const scope of scopes) {
    for (const input of scope.match(/<input\b[^>]*>/gi) ?? []) {
      const name = attribute(input, "name");
      if (!name?.startsWith("$ACTION_")) continue;
      const value = attribute(input, "value") ?? "";
      if (!/^\$ACTION_(?:REF_\d+|KEY|\d+:\d+|ID_[a-f0-9]{40,64})$/.test(name) || value.length > 2048) {
        throw new Error("Keel returned an unsupported Server Action field");
      }
      actionFields.push([name, value]);
    }
  }
  if (actionFields.length > 0) {
    if (!validateProgressiveActionFields(actionFields)) throw new Error("Keel returned an incomplete or changed progressive Server Action form");
    return { fields: actionFields };
  }
  const serialized = serializedProperty ? serializedServerAction(source, serializedProperty) : null;
  if (serialized) return serialized;
  throw new Error(`Expected one bounded Keel ${serializedProperty === "logoutAction" ? "logout" : "login"} Server Action`);
}

function splitSetCookie(value) {
  return String(value ?? "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map((entry) => entry.trim()).filter(Boolean);
}

function responseCookies(headers) {
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const value = headers?.get?.("set-cookie");
  return value ? splitSetCookie(value) : [];
}

export function updateCookieJar(jar, headers) {
  for (const setCookie of responseCookies(headers)) {
    const pair = setCookie.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(setCookie)) jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function locationPath(response) {
  try { return new URL(response.headers.get("location") ?? "", baseUrl).pathname; } catch { return ""; }
}

async function submitAction(fetchImpl, action, fields, cookie = "") {
  const form = new FormData();
  for (const [name, value] of action.fields) form.set(name, value);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers = { Origin: baseUrl, Referer: `${baseUrl}/login` };
  if (cookie) headers.Cookie = cookie;
  return fetchImpl(`${baseUrl}/login`, { method: "POST", headers, body: form, redirect: "manual" });
}

export async function authenticateKeelOwner({
  fetchImpl = fetch,
  credentials,
  now = () => new Date(),
  inspectDatabaseIdentity = defaultDatabaseIdentity,
} = {}) {
  let email = String(credentials?.email ?? "").trim().toLowerCase();
  let password = String(credentials?.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Enter the email address used by the Keel instance owner");
  if (password.length < 1 || password.length > 512) throw new Error("Enter the Keel password, limited to 512 characters");

  const jar = new Map();
  const loginPage = await fetchImpl(`${baseUrl}/login`, { redirect: "manual" });
  if (loginPage.status !== 200) throw new Error("Keel's fixed loopback login page is unavailable");
  updateCookieJar(jar, loginPage.headers);
  const loginAction = extractServerAction(await loginPage.text(), { formText: "Sign in" });
  const loginResponse = await submitAction(fetchImpl, loginAction, { email, password }, cookieHeader(jar));
  email = "";
  password = "";
  updateCookieJar(jar, loginResponse.headers);
  const loginLocation = locationPath(loginResponse);
  if (loginLocation === "/2fa") {
    jar.clear();
    throw new KeelSecondFactorRequiredError("Keel accepted the password but requires a security key; complete owner login in a browser because terminal proof cannot impersonate WebAuthn");
  }
  if (![302, 303, 307].includes(loginResponse.status) || loginLocation !== "/" || !jar.has("keel_session")) {
    jar.clear();
    throw new Error("Keel did not create a session; check the owner email, password, access policy, and login rate limit");
  }

  let sessionCookie = cookieHeader(jar);
  let verificationError = null;
  let ownerVerified = false;
  let releaseVersion = null;
  try {
    const ownerResponse = await fetchImpl(`${baseUrl}/api/admin/server`, {
      headers: { Cookie: sessionCookie },
      redirect: "manual",
    });
    if (ownerResponse.status !== 200) {
      throw new Error(ownerResponse.status === 403
        ? "The credentials are valid, but this account is not Keel's instance owner"
        : "Keel did not authorize the instance-owner verification endpoint");
    }
    const body = await ownerResponse.json().catch(() => null);
    if (body?.version !== keelServiceIdentity.releaseVersion) throw new Error("Keel's instance-owner endpoint returned an unexpected release identity");
    ownerVerified = true;
    releaseVersion = body.version;
  } catch (error) {
    verificationError = error;
  }

  let logoutVerified = false;
  try {
    const workspace = await fetchImpl(`${baseUrl}/`, { headers: { Cookie: sessionCookie }, redirect: "follow" });
    if (workspace.status !== 200) throw new Error("Keel's authenticated workspace page is unavailable for safe logout");
    const workspaceUrl = new URL(workspace.url || `${baseUrl}/`);
    if (workspaceUrl.origin !== baseUrl) throw new Error("Keel redirected the authenticated workspace outside fixed loopback");
    const logoutAction = extractServerAction(await workspace.text(), { formText: "Sign out", serializedProperty: "logoutAction" });
    const logoutForm = new FormData();
    for (const [name, value] of logoutAction.fields) logoutForm.set(name, value);
    const logoutResponse = await fetchImpl(workspaceUrl.href, {
      method: "POST",
      headers: { Cookie: sessionCookie, Origin: baseUrl, Referer: workspaceUrl.href },
      body: logoutForm,
      redirect: "manual",
    });
    if (![302, 303, 307].includes(logoutResponse.status) || locationPath(logoutResponse) !== "/login") {
      throw new Error("Keel did not confirm logout");
    }
    const revoked = await fetchImpl(`${baseUrl}/api/admin/server`, {
      headers: { Cookie: sessionCookie },
      redirect: "manual",
    });
    logoutVerified = revoked.status === 401;
    if (!logoutVerified) throw new Error("Keel's former session remained authorized after logout");
  } finally {
    jar.clear();
    sessionCookie = "";
  }

  if (verificationError) throw verificationError;
  if (!ownerVerified || !logoutVerified) throw new Error("Keel owner login proof did not complete");
  const databaseIdentity = await inspectDatabaseIdentity();
  if (!Number.isSafeInteger(databaseIdentity?.device) || databaseIdentity.device < 0
    || !Number.isSafeInteger(databaseIdentity?.inode) || databaseIdentity.inode <= 0) {
    throw new Error("Keel's active database identity could not be bound to the login proof");
  }
  return {
    schemaVersion: 1,
    applicationId: "keel",
    releaseVersion,
    verifiedAt: now().toISOString(),
    endpoint: baseUrl,
    loginProtocol: "keel-server-action",
    ownerRoute: "/api/admin/server",
    ownerRouteVerified: true,
    logoutVerified: true,
    credentialsStored: false,
    databaseDevice: databaseIdentity.device,
    databaseInode: databaseIdentity.inode,
    sessionStored: false,
    secondFactorRequired: false,
    terminalOnly: true,
    boxpilotCredentialAccess: false,
  };
}

function readLineFromTty(prompt) {
  writeSync(1, prompt);
  const bytes = [];
  const buffer = Buffer.alloc(1);
  while (true) {
    const read = readSync(0, buffer, 0, 1);
    if (read === 0) throw new Error("Terminal input closed");
    if (buffer[0] === 10 || buffer[0] === 13) { writeSync(1, "\n"); break; }
    if (buffer[0] === 3) throw new Error("Cancelled");
    if (bytes.length >= 512) throw new Error("Terminal input is too long");
    bytes.push(buffer[0]);
  }
  return Buffer.from(bytes).toString("utf8").trim();
}

function readMaskedPassword(prompt) {
  const tty = openSync("/dev/tty", "r+");
  const input = process.stdin;
  const wasRaw = input.isRaw;
  const bytes = [];
  writeSync(tty, prompt);
  try {
    input.setRawMode(true);
    const buffer = Buffer.alloc(1);
    while (true) {
      const read = readSync(tty, buffer, 0, 1);
      if (read === 0) throw new Error("Terminal input closed");
      const value = buffer[0];
      if (value === 3) throw new Error("Cancelled");
      if (value === 10 || value === 13) { writeSync(tty, "\n"); break; }
      if (value === 8 || value === 127) { if (bytes.length > 0) bytes.pop(); continue; }
      if (bytes.length >= 512) throw new Error("Password is too long");
      bytes.push(value);
    }
    return Buffer.from(bytes).toString("utf8");
  } finally {
    input.setRawMode(Boolean(wasRaw));
    bytes.fill(0);
    closeSync(tty);
  }
}

export async function persistSanitizedProof(proof, {
  proofDirectory = keelInstallPaths.loginProofDirectory,
  proofPath = keelInstallPaths.loginProof,
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  if (!exactKeelOwnerLoginProof(proof)) throw new Error("Refusing to persist incomplete or non-sanitized Keel login evidence");
  try { await mkdir(proofDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const directory = await lstat(proofDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== expectedRootUid
    || directory.gid !== expectedRootGid || (directory.mode & 0o7777) !== 0o700) {
    throw new Error("The fixed Keel owner-login proof directory is unsafe");
  }
  const temporary = path.join(proofDirectory, `.latest.${process.pid}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(proof)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, proofPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((cleanupError) => { if (cleanupError.code !== "ENOENT") throw cleanupError; });
    throw error;
  }
}

function spawnCredentialWorker(account) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [workerFlag], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    let settled = false;
    child.once("message", (message) => {
      if (message?.type === "proof" && exactKeelOwnerLoginProof(message.proof)) {
        settled = true;
        resolve(message.proof);
      } else if (message?.type === "error") {
        settled = true;
        reject(new Error(String(message.message ?? "Keel login proof failed")));
      }
    });
    child.once("error", (error) => { if (!settled) reject(error); });
    child.once("exit", (code) => { if (!settled) reject(new Error(`Keel credential worker exited before producing proof (${code ?? "signal"})`)); });
    child.send({ type: "start", uid: account.uid, gid: account.gid });
  });
}

export async function runKeelOwnerLoginProof({
  paths = keelInstallPaths,
  rootUid = 0,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  sudoUid = process.env.SUDO_UID,
  stdinTty = process.stdin.isTTY,
  stdoutTty = process.stdout.isTTY,
  inspectAccount = defaultAccount,
  serviceActive = defaultServiceActive,
  runWorker = spawnCredentialWorker,
  persist = persistSanitizedProof,
} = {}) {
  if (uid !== 0 || !/^\d+$/.test(String(sudoUid ?? "")) || Number(sudoUid) <= 0) {
    throw new Error("Run this command from a normal server administrator account through fresh sudo, not from a root login");
  }
  if (!stdinTty || !stdoutTty) throw new Error("Keel owner-login proof must run interactively in a server terminal");
  const account = await inspectAccount();
  if (!account) throw new Error("The dedicated Keel service account is unavailable or changed");
  await keelClaimInternals.verifyBoundary({ paths, account, rootUid, serviceActive });
  const proof = await runWorker(account);
  if (!exactKeelOwnerLoginProof(proof)) throw new Error("The credential worker did not return exact sanitized evidence");
  await persist(proof);
  return proof;
}

async function credentialWorkerMain() {
  process.once("message", async (message) => {
    try {
      if (message?.type !== "start" || !Number.isInteger(message.uid) || !Number.isInteger(message.gid)
        || message.uid <= 0 || message.gid <= 0 || !process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Credential worker received an invalid fixed identity or terminal");
      }
      process.setgroups([]);
      process.setgid(message.gid);
      process.setuid(message.uid);
      const email = readLineFromTty("Keel instance-owner email: ");
      const password = readMaskedPassword("Keel password (hidden): ");
      const proof = await authenticateKeelOwner({ credentials: { email, password } });
      process.send?.({ type: "proof", proof }, () => process.exit(0));
    } catch (error) {
      const messageText = error instanceof KeelSecondFactorRequiredError
        ? error.message
        : `Keel owner-login proof failed: ${error.message}`;
      process.send?.({ type: "error", message: messageText }, () => process.exit(1));
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv[2] === workerFlag && process.argv.length === 3) {
    await credentialWorkerMain();
  } else if (process.argv.length !== 2) {
    console.error("Usage: sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-owner-login-proof.mjs");
    process.exitCode = 64;
  } else {
    try {
      const proof = await runKeelOwnerLoginProof();
      console.log(`Keel ${proof.releaseVersion} instance-owner login and logout verified. No credential or session was stored by BoxPilot.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const keelOwnerLoginProofInternals = {
  attribute,
  baseUrl,
  cookieHeader,
  defaultAccount,
  locationPath,
  responseCookies,
  splitSetCookie,
};
