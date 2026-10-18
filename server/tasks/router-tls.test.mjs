// @vitest-environment node
import { createHash } from "node:crypto";
import https from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { selfSignedCertificate } from "../../test/self-signed-certificate.mjs";
import { httpsJson } from "./router.mjs";

/*
 * The router's transport over a real TLS connection. Its certificate is self-signed, so it is
 * pinned on first contact and every later call must present the same one; a different certificate
 * gets nothing, and above all not the request body, which carries the login proof.
 */

const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

async function routerAt({ certificate = selfSignedCertificate(), answer = (body) => JSON.stringify({ result: { echoed: body.method } }) } = {}) {
  const received = [];
  const server = https.createServer({ cert: certificate.cert, key: certificate.key }, (request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => { received.push(text); response.end(answer(JSON.parse(text || "{}"))); });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { url: `https://127.0.0.1:${server.address().port}/rpc`, received, fingerprint: createHash("sha256").update(certificate.der).digest("hex") };
}

describe("talking to the router over TLS", () => {
  it("records the certificate it met first, and answers with the router's JSON", async () => {
    const router = await routerAt();
    const seen = [];
    expect(await httpsJson({ onFingerprint: (value) => seen.push(value) })(router.url, { method: "challenge" })).toEqual({ result: { echoed: "challenge" } });
    expect(seen).toEqual([router.fingerprint]);
    expect(router.received).toEqual([JSON.stringify({ method: "challenge" })]);
  });

  it("goes on talking to the certificate it pinned", async () => {
    const router = await routerAt();
    expect(await httpsJson({ expectFingerprint: router.fingerprint })(router.url, { method: "login" })).toEqual({ result: { echoed: "login" } });
  });

  it("sends nothing to a router presenting a different certificate", async () => {
    const pinned = selfSignedCertificate();
    const impostor = await routerAt();
    const send = httpsJson({ expectFingerprint: createHash("sha256").update(pinned.der).digest("hex") });
    await expect(send(impostor.url, { method: "login", params: { hash: "proof" } })).rejects.toThrow(/different certificate/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(impostor.received).toEqual([]);
  });

  it("says when the router answers with something that is not JSON, or cannot be reached", async () => {
    const router = await routerAt({ answer: () => "<html>login</html>" });
    await expect(httpsJson()(router.url, {})).rejects.toThrow(/not JSON/);
    const closed = await routerAt();
    const url = closed.url;
    await new Promise((resolve) => servers.pop().close(resolve));
    await expect(httpsJson()(url, {})).rejects.toThrow(/Could not reach the router/);
  });
});
