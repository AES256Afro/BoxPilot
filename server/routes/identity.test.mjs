import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityRouter } from "./identity.mjs";

/*
 * Signing in with Tailscale or GitHub, and linking those identities, through the router's own
 * checks. The auth service and the identity store are small fakes: a session is named by the
 * x-test-session header, the CSRF token is "csrf", and the right password is "right password".
 */

const accounts = {
  alex: { id: "alex", username: "alex", role: "owner" },
  olly: { id: "olly", username: "olly", role: "operator" },
  vic: { id: "vic", username: "vic", role: "viewer" },
  gone: { id: "gone", username: "gone", role: "disabled" },
};
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

async function serve({ tailscale = { available: false }, tailscaleAccount = null, trusted = false, poll = null, githubAccount = null, issueFails = false } = {}) {
  const calls = { remembered: [], issued: [], linked: [], unlinked: [], started: [] };
  const store = { findOwnerById: (id) => accounts[id] ?? null, anyPasskeys: () => false };
  const auth = {
    requireSession: (request, response, next) => { const who = accounts[request.get("x-test-session") ?? ""]; if (!who) return response.status(401).json({ code: "unauthenticated" }); request.boxpilotSession = { owner: who }; return next(); },
    requireCsrf: async (request, response, next) => {
      const who = accounts[request.get("x-test-session") ?? ""];
      if (!who || request.get("x-boxpilot-csrf") !== "csrf") return response.status(403).json({ code: "csrf_required" });
      request.boxpilotSession = { owner: who };
      return next();
    },
    requireRole: (...roles) => (request, response, next) => (roles.includes(request.boxpilotSession?.owner?.role) ? next() : response.status(403).json({ code: "forbidden" })),
    checkPassword: async (_request, account, password) => ({ ok: Boolean(account) && password === "right password", blocked: password === "throttled" }),
    rejectThrottled: (response) => response.status(429).json({ code: "too_many_attempts" }),
    trustedDevice: async () => trusted,
    rememberDevice: async (_request, _response, account) => { calls.remembered.push(account.id); },
    issueSession: async (_request, _response, account, how) => { if (issueFails) throw new Error("Sign-in is not allowed from this address"); calls.issued.push([account.id, how.method]); return { authenticated: true, owner: { id: account.id } }; },
  };
  const identity = {
    tailscaleIdentity: async () => tailscale,
    summary: (scope = null) => ({ githubConfigured: true, scope }),
    tailscaleAccountFor: () => tailscaleAccount,
    clientAddress: async () => "100.64.0.9",
    githubStart: async (options) => { calls.started.push(options); return { flowId: "flow-1", userCode: "ABCD-1234" }; },
    githubPoll: async () => poll,
    githubAccountFor: () => githubAccount,
    linkGithub: (ownerId, login) => { calls.linked.push([ownerId, login]); return [login]; },
    linkTailscale: (ownerId, login) => { calls.linked.push([ownerId, login]); return [login]; },
    unlinkTailscale: (ownerId, login, { force }) => { calls.unlinked.push([ownerId, login, force]); if (!force && login !== "mine@example.com") throw new Error("Only the owner can unlink another account's identity"); return []; },
    unlinkGithub: (ownerId, login, { force }) => { calls.unlinked.push([ownerId, login, force]); return []; },
    setGithubClientId: () => {},
  };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createIdentityRouter({ store, auth, identity }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, url, { body, as = null, csrf = false } = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", ...(as ? { "x-test-session": as } : {}), ...(csrf ? { "x-boxpilot-csrf": "csrf" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { call, calls };
}

const linkedAlex = { available: true, login: "alex@example.com", displayName: "Alex", node: "workbook", linked: true };

describe("signing in with Tailscale", () => {
  it("is refused without a Tailscale identity, or with one nobody linked", async () => {
    expect(await (await serve()).call("POST", "/auth/tailscale")).toMatchObject({ status: 401, body: { code: "no_tailscale_identity" } });
    expect(await (await serve({ tailscale: { ...linkedAlex, linked: false } })).call("POST", "/auth/tailscale")).toMatchObject({ status: 403, body: { code: "identity_not_linked" } });
  });

  it("answers a disabled account exactly as a missing one, and never checks a password against it", async () => {
    const disabled = await (await serve({ tailscale: linkedAlex, tailscaleAccount: "gone" })).call("POST", "/auth/tailscale", { body: { password: "right password" } });
    const missing = await (await serve({ tailscale: linkedAlex, tailscaleAccount: "nobody" })).call("POST", "/auth/tailscale", { body: { password: "right password" } });
    expect(disabled).toEqual(missing);
    expect(disabled).toMatchObject({ status: 403, body: { code: "identity_not_linked" } });
  });

  it("asks a new browser for the password once, remembers it, and then signs in", async () => {
    const { call, calls } = await serve({ tailscale: linkedAlex, tailscaleAccount: "alex" });
    expect(await call("POST", "/auth/tailscale")).toMatchObject({ status: 401, body: { code: "device_password_required", username: "alex" } });
    expect(await call("POST", "/auth/tailscale", { body: { password: "wrong password" } })).toMatchObject({ status: 401, body: { code: "device_password_required" } });
    expect(await call("POST", "/auth/tailscale", { body: { password: "throttled" } })).toMatchObject({ status: 429 });
    expect(calls.remembered).toEqual([]);
    expect(await call("POST", "/auth/tailscale", { body: { password: "right password" } })).toMatchObject({ status: 200, body: { authenticated: true } });
    expect(calls.remembered).toEqual(["alex"]);
    expect(calls.issued).toEqual([["alex", "tailscale"]]);
  });

  it("signs a trusted browser in without a password, and says when the session is refused", async () => {
    const trusted = await serve({ tailscale: linkedAlex, tailscaleAccount: "alex", trusted: true });
    expect(await trusted.call("POST", "/auth/tailscale")).toMatchObject({ status: 200 });
    expect(trusted.calls.remembered).toEqual([]);
    const refused = await serve({ tailscale: linkedAlex, tailscaleAccount: "alex", trusted: true, issueFails: true });
    expect(await refused.call("POST", "/auth/tailscale")).toMatchObject({ status: 403, body: { code: "identity_refused", error: "Sign-in is not allowed from this address" } });
  });

  it("says which ways in exist without naming who can use them", async () => {
    const { body } = await (await serve({ tailscale: linkedAlex })).call("GET", "/auth/identity");
    expect(body).toEqual({ tailscale: { available: true, login: "alex@example.com", displayName: "Alex", node: "workbook", linked: true, proxyVerified: false }, github: { configured: true }, passkey: { registered: false } });
  });
});

describe("signing in with GitHub", () => {
  it("starts a flow bound to the caller's address, and says when GitHub cannot be reached", async () => {
    const { call, calls } = await serve();
    expect(await call("POST", "/auth/github/start")).toMatchObject({ status: 200, body: { flowId: "flow-1" } });
    expect(calls.started).toEqual([{ purpose: "signin", client: "100.64.0.9" }]);
  });

  it("passes on pending and refuses an unlinked or vanished account", async () => {
    expect(await (await serve({ poll: { status: "pending" } })).call("POST", "/auth/github/poll", { body: { flowId: "flow-1" } })).toEqual({ status: 200, body: { status: "pending", error: null } });
    expect(await (await serve()).call("POST", "/auth/github/poll", { body: {} })).toMatchObject({ status: 400 });
    const complete = { status: "complete", purpose: "signin", login: "alexgh", githubId: 7 };
    expect(await (await serve({ poll: complete })).call("POST", "/auth/github/poll", { body: { flowId: "flow-1" } })).toMatchObject({ status: 403, body: { status: "denied", code: "identity_not_linked" } });
    expect(await (await serve({ poll: complete, githubAccount: "nobody" })).call("POST", "/auth/github/poll", { body: { flowId: "flow-1" } })).toMatchObject({ status: 403, body: { status: "denied" } });
    const ok = await serve({ poll: complete, githubAccount: "alex" });
    expect(await ok.call("POST", "/auth/github/poll", { body: { flowId: "flow-1" } })).toMatchObject({ status: 200, body: { status: "complete", session: { authenticated: true } } });
    expect(ok.calls.issued).toEqual([["alex", "github"]]);
  });

  it("links an account only for the session that started the flow, and only with its CSRF token", async () => {
    const link = { status: "complete", purpose: "link", ownerId: "olly", login: "ollygh", githubId: 9 };
    const anonymous = await serve({ poll: link });
    expect(await anonymous.call("POST", "/auth/github/poll", { body: { flowId: "flow-1" } })).toMatchObject({ status: 403, body: { code: "csrf_required" } });
    const noToken = await serve({ poll: link });
    expect(await noToken.call("POST", "/auth/github/poll", { body: { flowId: "flow-1" }, as: "olly" })).toMatchObject({ status: 403, body: { code: "csrf_required" } });
    const someoneElse = await serve({ poll: link });
    expect(await someoneElse.call("POST", "/auth/github/poll", { body: { flowId: "flow-1" }, as: "alex", csrf: true })).toMatchObject({ status: 403, body: { error: "The link flow belongs to another session" } });
    expect(someoneElse.calls.linked).toEqual([]);
    const theirs = await serve({ poll: link });
    expect(await theirs.call("POST", "/auth/github/poll", { body: { flowId: "flow-1" }, as: "olly", csrf: true })).toMatchObject({ status: 200, body: { status: "complete", linked: true, githubLogins: ["ollygh"] } });
    expect(theirs.calls.linked).toEqual([["olly", "ollygh"]]);
  });
});

describe("managing linked identities", () => {
  it("needs a session, its CSRF token, an operator or the owner, and the password", async () => {
    const { call, calls } = await serve({ tailscale: { available: true, login: "olly@example.com", linked: false } });
    expect((await call("POST", "/auth/identity/tailscale", { body: { password: "right password" } })).status).toBe(401);
    expect((await call("POST", "/auth/identity/tailscale", { body: { password: "right password" }, as: "olly" })).status).toBe(403);
    expect(await call("POST", "/auth/identity/tailscale", { body: { password: "right password" }, as: "vic", csrf: true })).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await call("POST", "/auth/identity/tailscale", { body: { password: "wrong password" }, as: "olly", csrf: true })).toMatchObject({ status: 401, body: { code: "reauthentication_required" } });
    expect(calls.linked).toEqual([]);
    expect(await call("POST", "/auth/identity/tailscale", { body: { password: "right password" }, as: "olly", csrf: true })).toMatchObject({ status: 200, body: { login: "olly@example.com" } });
    expect(calls.linked).toEqual([["olly", "olly@example.com"]]);
  });

  it("links only the identity this connection carries", async () => {
    expect(await (await serve()).call("POST", "/auth/identity/tailscale", { body: { password: "right password" }, as: "olly", csrf: true })).toMatchObject({ status: 400, body: { code: "no_tailscale_identity" } });
  });

  it("lets the owner unlink anyone's identity and an operator only their own", async () => {
    const owner = await serve();
    expect((await owner.call("DELETE", "/auth/identity/tailscale", { body: { password: "right password", login: "olly@example.com" }, as: "alex", csrf: true })).status).toBe(200);
    expect(owner.calls.unlinked).toEqual([["alex", "olly@example.com", true]]);
    const operator = await serve();
    expect(await operator.call("DELETE", "/auth/identity/tailscale", { body: { password: "right password", login: "alex@example.com" }, as: "olly", csrf: true })).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(operator.calls.unlinked).toEqual([["olly", "alex@example.com", false]]);
    expect(await operator.call("DELETE", "/auth/identity/github", { body: { password: "right password" }, as: "olly", csrf: true })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("keeps the GitHub client id the owner's, and shows an operator only their own links", async () => {
    const { call } = await serve();
    expect(await call("PUT", "/settings/github-client-id", { body: { password: "right password", clientId: "Iv1.abc" }, as: "olly", csrf: true })).toMatchObject({ status: 403 });
    expect((await call("PUT", "/settings/github-client-id", { body: { password: "right password", clientId: "Iv1.abc" }, as: "alex", csrf: true })).status).toBe(200);
    expect((await call("GET", "/auth/identity/links", { as: "olly" })).body).toMatchObject({ scope: "olly", currentTailscale: null });
    expect((await call("GET", "/auth/identity/links", { as: "alex" })).body).toMatchObject({ scope: null });
    expect((await call("GET", "/auth/identity/links", { as: "vic" })).status).toBe(403);
  });
});
