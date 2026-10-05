// @vitest-environment node
/**
 * The session cookie over the LAN's HTTPS listener (sweep 1, S1-2).
 *
 * The installer's LAN mode sets BOXPILOT_COOKIE_SECURE=false, because its main listener is plain
 * HTTP. That setting used to win over the connection itself, so a sign-in over the HTTPS listener
 * (:8443, started by startTlsListener) got a cookie without Secure and without the __Host- prefix:
 * one the browser would also send over plain HTTP. The connection being TLS is the stronger fact.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword } from "./security.mjs";
import { startTlsListener } from "./tls-listener.mjs";

vi.setConfig({ testTimeout: 30_000 });

// ---- a throwaway self-signed certificate, built here so the test needs no openssl ----
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? Buffer.from([body.length]) : (() => { const bytes = []; for (let n = body.length; n; n >>= 8) bytes.unshift(n & 255); return Buffer.from([0x80 | bytes.length, ...bytes]); })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts) => der(0x30, ...parts);
function objectId(text) {
  const [first, second, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (let value of rest) { const chunk = [value & 127]; for (value >>= 7; value; value >>= 7) chunk.unshift((value & 127) | 128); bytes.push(...chunk); }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

function selfSignedCertificate() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = sequence(der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from("localhost")))));
  const algorithm = sequence(objectId("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const now = Date.now();
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name, sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))), name, publicKey.export({ type: "spki", format: "der" }));
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

// ---- the app, signed in to over HTTPS and over HTTP ----
const password = "correct horse battery";
let directory; let state; let auth; let http; let https; let httpBase; let httpsPort;
const savedSecure = process.env.BOXPILOT_COOKIE_SECURE;

function overHttps(method, urlPath, { headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = httpsRequest({ host: "127.0.0.1", port: httpsPort, method, path: urlPath, rejectUnauthorized: false, headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, setCookie: response.headers["set-cookie"] ?? [], body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function overHttp(urlPath, headers = {}) {
  const response = await fetch(`${httpBase}${urlPath}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ username: "alex", password }) });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cookies-"));
  state = createStateStore({ stateDirectory: directory });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
  auth = createAuthService(state);
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/api/v1/auth/login", auth.login);
  app.post("/api/v1/auth/device", async (request, response) => { await auth.rememberDevice(request, response, state.findOwnerByUsername("alex")); response.status(204).end(); });
  http = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  httpBase = `http://127.0.0.1:${http.address().port}`;
  const { cert, key } = selfSignedCertificate();
  https = startTlsListener(app, {
    host: "127.0.0.1",
    env: { BOXPILOT_TLS_CERT: "leaf.crt", BOXPILOT_TLS_KEY: "leaf.key", BOXPILOT_TLS_PORT: "0" },
    readFile: (file) => (file === "leaf.crt" ? cert : key),
    log: { warn: () => {}, log: () => {} },
  });
  await new Promise((resolve) => (https.listening ? resolve() : https.once("listening", resolve)));
  httpsPort = https.address().port;
});

afterEach(() => {
  if (savedSecure === undefined) delete process.env.BOXPILOT_COOKIE_SECURE; else process.env.BOXPILOT_COOKIE_SECURE = savedSecure;
});

afterAll(async () => {
  http?.close(); https?.close();
  state?.close?.();
  await rm(directory, { recursive: true, force: true });
});

describe("the session cookie", () => {
  it("is Secure and host-pinned when signing in over the HTTPS listener, even in LAN mode", async () => {
    process.env.BOXPILOT_COOKIE_SECURE = "false";
    const result = await overHttps("POST", "/api/v1/auth/login", { body: { username: "alex", password } });
    expect(result.status).toBe(200);
    const [cookie] = result.setCookie;
    expect(cookie).toMatch(/^__Host-boxpilot_session=/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; Path=\//);
  });

  it("stays plain over plain HTTP in LAN mode, where a browser would refuse a Secure cookie", async () => {
    process.env.BOXPILOT_COOKIE_SECURE = "false";
    const [cookie] = (await overHttp("/api/v1/auth/login")).setCookie;
    expect(cookie).toMatch(/^boxpilot_session=/);
    expect(cookie).not.toMatch(/Secure/);
    // A forwarded-HTTPS claim does not override LAN mode: nothing in front says so there.
    const [forwarded] = (await overHttp("/api/v1/auth/login", { "X-Forwarded-Proto": "https" })).setCookie;
    expect(forwarded).not.toMatch(/Secure/);
  });

  it("follows Tailscale Serve's forwarded HTTPS when the mode is not set, and is Secure whenever the mode says so", async () => {
    delete process.env.BOXPILOT_COOKIE_SECURE;
    const [forwarded] = (await overHttp("/api/v1/auth/login", { "X-Forwarded-Proto": "https" })).setCookie;
    expect(forwarded).toMatch(/^__Host-boxpilot_session=.*; Secure/);
    process.env.BOXPILOT_COOKIE_SECURE = "true";
    const [forced] = (await overHttp("/api/v1/auth/login")).setCookie;
    expect(forced).toMatch(/^__Host-boxpilot_session=.*; Secure/);
  });
});

describe("the remembered-device cookie", () => {
  it("is Secure over the HTTPS listener in LAN mode too", async () => {
    process.env.BOXPILOT_COOKIE_SECURE = "false";
    const result = await overHttps("POST", "/api/v1/auth/device");
    expect(result.status).toBe(204);
    expect(result.setCookie.find((line) => line.startsWith("boxpilot_device="))).toMatch(/; Secure/);
  });
});
