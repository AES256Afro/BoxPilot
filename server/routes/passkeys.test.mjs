/**
 * Passkey routes end to end: mounted like server/index.mjs, driven over a real socket, with a
 * software authenticator standing in for a platform passkey. Covers who may reach each route and the
 * full register -> sign-in -> recovery path.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, createHash, randomBytes } from "node:crypto";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";
import { createIdentityService } from "../identity.mjs";
import { createPasskeyService } from "../passkeys.mjs";
import { createPasskeyRouter } from "./passkeys.mjs";
import { bufferToBase64url } from "../webauthn.mjs";

const password = "correct horse battery";
const origin = "https://boxpilot.lan:8443";
const rpId = "boxpilot.lan";
const sha256 = (buffer) => createHash("sha256").update(buffer).digest();
let directory; let server; let base; let state;

async function api(method, urlPath, { session = null, body = undefined } = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(session ? { Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed, setCookie: response.headers.getSetCookie?.() ?? [] };
}

async function signInWithPassword() {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alex", password }) });
  const body = await response.json();
  const cookie = String(response.headers.getSetCookie?.()[0]).split(";")[0];
  return { cookie, csrfToken: body.csrfToken, owner: body.owner };
}

function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = bufferToBase64url(randomBytes(16));
  let counter = 0;
  const authData = () => { counter += 1; const b = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([0x05]), Buffer.alloc(4)]); b.writeUInt32BE(counter, 33); return b; };
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    credentialId,
    create: (challenge, label) => ({ challenge, id: credentialId, label, algorithm: -7, publicKey: bufferToBase64url(publicKey.export({ format: "der", type: "spki" })), authenticatorData: bufferToBase64url(authData()), clientDataJSON: bufferToBase64url(clientData("webauthn.create", challenge)), transports: ["internal"] }),
    get: (challenge) => { const ad = authData(); const cd = clientData("webauthn.get", challenge); return { challenge, id: credentialId, authenticatorData: bufferToBase64url(ad), clientDataJSON: bufferToBase64url(cd), signature: bufferToBase64url(cryptoSign("sha256", Buffer.concat([ad, sha256(cd)]), { key: privateKey, dsaEncoding: "der" })) }; },
  };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-passkey-routes-"));
  state = createStateStore({ stateDirectory: directory });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
  const auth = createAuthService(state);
  const identity = createIdentityService({ store: state, run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })) });
  const passkeys = createPasskeyService({ store: state });
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.use("/api/v1", createPasskeyRouter({ store: state, auth, passkeys, identity }));
  app.post("/api/v1/auth/login", auth.login);
  app.use("/api/v1", auth.requireSession);
  app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { server?.close(); state?.close?.(); await rm(directory, { recursive: true, force: true }); });

describe("passkey routes", () => {
  const device = authenticator();

  it("will not start registration without a session", async () => {
    const result = await api("POST", "/api/v1/auth/passkey/register/options", { body: { origin } });
    expect(result.status).toBe(401);
  });

  it("registers a passkey for the signed-in owner and then signs in with it", async () => {
    const session = await signInWithPassword();
    const options = await api("POST", "/api/v1/auth/passkey/register/options", { session, body: { origin } });
    expect(options.status).toBe(200);
    expect(options.body.rp.id).toBe(rpId);

    const registered = await api("POST", "/api/v1/auth/passkey/register/verify", { session, body: { origin, credential: device.create(options.body.challenge, "My phone") } });
    expect(registered.status).toBe(201);
    expect(registered.body.passkey.label).toBe("My phone");

    // Anonymous sign-in with the passkey.
    const authOptions = await api("POST", "/api/v1/auth/passkey/options", { body: { origin } });
    expect(authOptions.status).toBe(200);
    const verified = await api("POST", "/api/v1/auth/passkey/verify", { body: { origin, response: device.get(authOptions.body.challenge) } });
    expect(verified.status).toBe(200);
    expect(verified.body.owner.username).toBe("alex");
    expect(verified.body.method).toBe("passkey");
    expect(verified.setCookie.join()).toMatch(/boxpilot_session/);
  });

  it("shows the registered passkey to the owner", async () => {
    const session = await signInWithPassword();
    const status = await api("GET", "/api/v1/auth/passkey", { session });
    expect(status.status).toBe(200);
    expect(status.body.passkeys).toHaveLength(1);
    expect(status.body.passkeys[0]).not.toHaveProperty("publicKey"); // never sent to the client
  });

  it("rejects a stale challenge on verify", async () => {
    await api("POST", "/api/v1/auth/passkey/options", { body: { origin } });
    const replay = await api("POST", "/api/v1/auth/passkey/verify", { body: { origin, response: device.get("not-a-real-challenge") } });
    expect(replay.status).toBe(401);
  });

  it("needs the password to remove a passkey", async () => {
    const session = await signInWithPassword();
    const list = await api("GET", "/api/v1/auth/passkey", { session });
    const id = list.body.passkeys[0].id;
    const withoutPassword = await api("DELETE", `/api/v1/auth/passkey/${encodeURIComponent(id)}`, { session, body: {} });
    expect(withoutPassword.status).toBe(401);
    const withPassword = await api("DELETE", `/api/v1/auth/passkey/${encodeURIComponent(id)}`, { session, body: { password } });
    expect(withPassword.status).toBe(200);
    expect(withPassword.body.passkeys).toHaveLength(0);
  });

  it("mints recovery codes (with the password) that then sign in once each", async () => {
    const session = await signInWithPassword();
    const denied = await api("POST", "/api/v1/auth/passkey/recovery-codes", { session, body: { password: "wrong wrong wrong" } });
    expect(denied.status).toBe(401);
    const minted = await api("POST", "/api/v1/auth/passkey/recovery-codes", { session, body: { password } });
    expect(minted.status).toBe(200);
    expect(minted.body.codes).toHaveLength(10);

    const used = await api("POST", "/api/v1/auth/passkey/recovery", { body: { code: minted.body.codes[0] } });
    expect(used.status).toBe(200);
    expect(used.body.owner.username).toBe("alex");
    expect(used.body.recoveryCodesRemaining).toBe(9);

    const reused = await api("POST", "/api/v1/auth/passkey/recovery", { body: { code: minted.body.codes[0] } });
    expect(reused.status).toBe(401);
  });
});
