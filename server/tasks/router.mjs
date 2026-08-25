/**
 * Talking to an OpenWrt-derived router — GL.iNet firmware 4.x to begin with.
 *
 * This is a task rather than something the helper does, for two reasons that both matter. The
 * helper runs with `PrivateNetwork=true` and cannot reach the router at all; and the credential
 * lives under `/etc/boxpilot/secrets`, which the helper may read but not write. The task runner is
 * the side with a network and the ability to store it, which is where the share credentials
 * already live.
 *
 * The password is never an argument. `openssl passwd` reads it on stdin, so it never appears in
 * argv where `ps` would show it — the same care the share mount takes.
 *
 * GL.iNet 4.x authentication, which is a salted-crypt challenge rather than a bearer token:
 *   1. `challenge` for the user returns `{ alg, salt, nonce }`
 *   2. the password is crypt(3)-hashed with that salt (alg 5 is SHA-256)
 *   3. `md5(user:hash:nonce)` is sent to `login`, which returns a session id
 *   4. the session id goes in every later call, and expires, so it is re-obtained on demand
 */
import { fixedRun } from "../exec.mjs";
import { createHash } from "node:crypto";
import https from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const defaultFiles = { mkdir, readFile, writeFile };

/**
 * A JSON-RPC POST to the router.
 *
 * These devices carry a self-signed certificate, so there is no authority to check it against and
 * `rejectUnauthorized` has to be off. Left there, that is an open invitation: anything on the LAN
 * could answer for the router and be handed the password. So the certificate is pinned on first
 * contact — its fingerprint is stored beside the credential — and every later call refuses one
 * that does not match. The first connection is still trusted blindly; nothing after it is, which
 * is the best available against a device that cannot be issued a real certificate.
 */
export function httpsJson({ expectFingerprint = null, onFingerprint = null } = {}) {
  return (url, body) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = https.request({
      host: target.hostname, port: target.port || 443, path: target.pathname, method: "POST",
      rejectUnauthorized: false, timeout: 20_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (response) => {
      const certificate = response.socket.getPeerCertificate?.();
      const fingerprint = certificate?.raw ? createHash("sha256").update(certificate.raw).digest("hex") : null;
      if (expectFingerprint && fingerprint && fingerprint !== expectFingerprint) {
        request.destroy();
        reject(new Error("The router presented a different certificate than the one recorded when it was connected. Something on the network may be answering for it; reconnect only if you changed the router's certificate yourself."));
        return;
      }
      if (fingerprint) onFingerprint?.(fingerprint);
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; if (text.length > 4 * 1024 * 1024) request.destroy(); });
      response.on("end", () => {
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`The router answered with something that is not JSON (HTTP ${response.statusCode})`)); }
      });
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("The router did not answer in time")); });
    request.on("error", (error) => reject(new Error(`Could not reach the router: ${error.message}`)));
    request.end(payload);
  });
}

export const routerKinds = Object.freeze(["glinet"]);
export const credentialsPath = "/etc/boxpilot/secrets/router.cred";
const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
const usernamePattern = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * These routers have exactly one administrative account and their own login page does not ask which
 * — it shows a password box and nothing else. The JSON-RPC underneath still wants a username, so
 * one is supplied rather than demanded; asking the owner to name an account the router never
 * mentions is asking them to guess.
 */
export const defaultUsername = "root";
export const accountFor = (username) => (typeof username === "string" && username.trim() ? username.trim() : defaultUsername);
/** Whether the owner named an account, as opposed to having root filled in for them. */
export const accountWasNamed = (username) => typeof username === "string" && Boolean(username.trim()) && username.trim() !== defaultUsername;
/** The router's word for both "no such account" and "wrong password"; only the stage separates them. */
const denied = (error) => /access denied/i.test(String(error?.message ?? ""));

export function validateRouter({ kind, host, username, password } = {}) {
  if (!routerKinds.includes(kind)) return "kind must be glinet";
  if (typeof host !== "string" || !hostPattern.test(host)) return "router address is invalid";
  // Absent means root. Present means it has to be a username.
  if (username !== undefined && username !== null && username !== "" && !usernamePattern.test(String(username))) return "username is invalid";
  if (password !== undefined && (typeof password !== "string" || password.length > 256 || /[\r\n]/.test(password))) return "password is invalid";
  return null;
}

/** crypt(3) with the router's own salt. The password goes in on stdin, never in argv. */
async function cryptPassword(run, password, alg, salt) {
  const result = await run("/usr/bin/openssl", ["passwd", `-${alg}`, "-salt", salt, "-stdin"], { timeout: 15_000, input: `${password}` });
  if (!result.ok) throw new Error("Could not hash the router password on this server");
  return result.stdout.trim().split("\n").pop();
}

async function md5(run, text) {
  const result = await run("/usr/bin/openssl", ["md5", "-r"], { timeout: 15_000, input: text });
  if (!result.ok) throw new Error("Could not hash the router challenge on this server");
  return result.stdout.trim().split(/\s+/)[0];
}

/**
 * One JSON-RPC call. `fetchJson` is injected so the whole flow is testable without a router; the
 * certificate is self-signed on every one of these devices, so verification is off for the LAN
 * address the owner typed and nothing else.
 */
function rpcClient({ host, fetchJson }) {
  return async function rpc(method, params) {
    const body = { jsonrpc: "2.0", id: 1, method, params };
    const answer = await fetchJson(`https://${host}/rpc`, body);
    if (answer?.error) throw new Error(String(answer.error.message ?? answer.error).slice(0, 200));
    return answer?.result;
  };
}

/**
 * Authenticate and return a session id.
 *
 * The router answers "Access denied" to two completely different problems — an account it does not
 * have, and a password it does not accept — and nothing in the reply tells them apart. The *stage*
 * does: a denial at `challenge` is the account, a denial at `login` is the password. So each stage
 * is caught separately and turned into a sentence that says which one it was and what to do about
 * it. Passing the router's own word through was accurate and useless.
 */
export async function routerLogin({ host, username, password }, { run = fixedRun, fetchJson } = {}) {
  const account = accountFor(username);
  const named = accountWasNamed(username);
  const rpc = rpcClient({ host, fetchJson });

  const challenge = await rpc("challenge", { username: account }).catch((error) => {
    if (!denied(error)) throw error;
    throw new Error(named
      ? `This router has no account called "${account}". Check the name you sign in to the router's own page with.`
      : `This router does not sign in as "${defaultUsername}", so it needs to be told which account to use. Choose "This router asks for a username too" and enter the name you sign in to the router's own page with.`);
  });
  if (!challenge?.salt || !challenge?.nonce) throw new Error("The router did not answer the login challenge as expected");

  const hashed = await cryptPassword(run, password, challenge.alg ?? 5, challenge.salt);
  const proof = await md5(run, `${account}:${hashed}:${challenge.nonce}`);

  const session = await rpc("login", { username: account, hash: proof }).catch((error) => {
    if (!denied(error)) throw error;
    // The account exists — the challenge for it succeeded a moment ago — so this is the password.
    throw new Error(`The router did not accept that password for "${account}". This is the password for the router's own admin page, which is often not the same as any other password on this network. Some routers also refuse sign-ins for a few minutes after several wrong attempts.`);
  });
  if (!session?.sid) throw new Error("The router did not accept that password");
  return session.sid;
}

/**
 * Store the credential and prove it works before doing so — a saved credential that has never
 * been tried is a setting that looks done and is not.
 */
export async function routerConnect({ kind = "glinet", host, username = defaultUsername, password } = {}, { run = fixedRun, log = null, fetchJson = null, files = defaultFiles } = {}) {
  const problem = validateRouter({ kind, host, username, password });
  if (problem) throw new Error(problem);
  if (typeof password !== "string" || !password) throw new Error("A router password is required");
  // First contact records whatever certificate answers, so a later swap is detectable.
  let fingerprint = null;
  const transport = fetchJson ?? httpsJson({ onFingerprint: (value) => { fingerprint = value; } });
  const account = accountFor(username);
  const sid = await routerLogin({ host, username: account, password }, { run, fetchJson: transport });
  log?.(`Signed in to ${host} as ${account}`, "stdout");

  await files.mkdir("/etc/boxpilot/secrets", { recursive: true, mode: 0o700 });
  await files.writeFile(credentialsPath, `kind=${kind}\nhost=${host}\nusername=${account}\npassword=${password}\nfingerprint=${fingerprint ?? ""}\n`, { mode: 0o600 });
  if (fingerprint) log?.(`Pinned the router's certificate (${fingerprint.slice(0, 16)}…)`, "stdout");
  log?.(`Stored the router credential at ${credentialsPath} (root only)`, "stdout");
  return { connected: true, kind, host, username: account, sid: Boolean(sid) };
}

/** Read the stored credential. Absent is a normal state, not an error. */
export async function readRouterCredential({ files = defaultFiles } = {}) {
  const text = await files.readFile(credentialsPath, "utf8").catch(() => null);
  if (!text) return null;
  const fields = Object.fromEntries(String(text).split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return fields.host && fields.username ? fields : null;
}

/** What the router says about itself, and whether the stored credential still works. */
export async function routerInspect(_parameters = {}, { run = fixedRun, fetchJson = null, files = defaultFiles } = {}) {
  const credential = await readRouterCredential({ files });
  if (!credential) return { configured: false, reachable: false, host: null, username: null, model: null, reason: "No router is connected yet." };
  try {
    const transport = fetchJson ?? httpsJson({ expectFingerprint: credential.fingerprint || null });
    const sid = await routerLogin(credential, { run, fetchJson: transport });
    const rpc = rpcClient({ host: credential.host, fetchJson: transport });
    const info = await rpc("call", [sid, "system", "get_info", {}]).catch(() => null);
    return {
      configured: true, reachable: true, host: credential.host, username: credential.username,
      model: info?.model ?? null, firmware: info?.firmware_version ?? null, reason: null,
    };
  } catch (error) {
    // A stored credential that stopped working is a different problem from one never set up.
    return { configured: true, reachable: false, host: credential.host, username: credential.username, model: null, reason: error.message };
  }
}

/** Every device the router has handed an address to. */
export async function routerLeases(_parameters = {}, { run = fixedRun, fetchJson = null, files = defaultFiles } = {}) {
  const credential = await readRouterCredential({ files });
  if (!credential) throw new Error("No router is connected yet");
  const transport = fetchJson ?? httpsJson({ expectFingerprint: credential.fingerprint || null });
  const sid = await routerLogin(credential, { run, fetchJson: transport });
  const rpc = rpcClient({ host: credential.host, fetchJson: transport });
  const answer = await rpc("call", [sid, "clients", "get_list", {}]);
  const clients = Array.isArray(answer?.clients) ? answer.clients : [];
  return {
    host: credential.host,
    leases: clients.map((client) => ({
      name: client.name ?? client.hostname ?? null,
      address: client.ip ?? null,
      mac: client.mac ?? null,
      online: client.online === true,
      // A lease the owner pinned by hand; the router calls it static, and it is the thing worth
      // knowing before offering to add one.
      reserved: client.is_static === true || client.static === true,
    })).filter((lease) => lease.address),
  };
}
