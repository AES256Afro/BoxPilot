/**
 * Identity routes: Tailscale and GitHub sign-in/linking. Mounted at /api/v1.
 * Unauthenticated: GET /auth/identity, POST /auth/tailscale, POST /auth/github/start, POST /auth/github/poll.
 * Authenticated (+CSRF): POST/DELETE /auth/identity/tailscale, POST /auth/identity/github/start, DELETE /auth/identity/github, PUT /settings/github-client-id.
 */
import { Router } from "express";
import { verifyPassword } from "../security.mjs";

export function createIdentityRouter({ store, auth, identity }) {
  const router = Router();

  async function ownerWithPassword(request, response) {
    const session = request.boxpilotSession;
    const owner = session ? store.findOwnerById(session.owner.id) : null;
    const password = request.body?.password;
    if (!owner || typeof password !== "string" || !(await verifyPassword(password, owner.passwordHash))) {
      response.status(401).json({ error: "Owner password required", code: "reauthentication_required" });
      return null;
    }
    return owner;
  }

  // What sign-in methods are available for *this* request (called by the sign-in screen).
  router.get("/auth/identity", async (request, response) => {
    const tailscale = await identity.tailscaleIdentity(request);
    const summary = identity.summary();
    response.json({ tailscale: { available: tailscale.available, login: tailscale.login, displayName: tailscale.displayName, node: tailscale.node, linked: tailscale.linked }, github: { configured: summary.githubConfigured, linkedLogins: summary.githubLogins } });
  });

  router.post("/auth/tailscale", async (request, response) => {
    const tailscale = await identity.tailscaleIdentity(request);
    if (!tailscale.available) return response.status(401).json({ error: "This connection does not carry a Tailscale identity", code: "no_tailscale_identity" });
    if (!tailscale.linked) return response.status(403).json({ error: `${tailscale.login} is not linked to this BoxPilot. Sign in with your password and link it in Settings.`, code: "identity_not_linked" });
    const owner = store.findFirstOwner();
    if (!owner) return response.status(409).json({ error: "Owner bootstrap is required first", code: "bootstrap_required" });
    return response.json(auth.issueSession(request, response, owner, { method: "tailscale", detail: tailscale.login }));
  });

  router.post("/auth/github/start", async (request, response) => {
    try {
      const flow = await identity.githubStart({ purpose: "signin" });
      return response.json(flow);
    } catch (error) {
      return response.status(503).json({ error: error.message, code: "github_start_failed" });
    }
  });

  // Poll works for both sign-in flows (anonymous) and link flows (authenticated, ownerId bound at start).
  router.post("/auth/github/poll", async (request, response) => {
    const flowId = request.body?.flowId;
    if (typeof flowId !== "string") return response.status(400).json({ error: "flowId is required", code: "invalid_request" });
    let result;
    try { result = await identity.githubPoll(flowId); } catch (error) { return response.status(503).json({ status: "error", error: error.message }); }
    if (result.status !== "complete") return response.json({ status: result.status, error: result.error ?? null });
    if (result.purpose === "link") {
      const session = auth.requestSession(request);
      if (!session || session.owner.id !== result.ownerId) return response.status(403).json({ status: "error", error: "The link flow belongs to another session" });
      const linked = identity.linkGithub(session.owner.id, result.login);
      return response.json({ status: "complete", linked: true, login: result.login, githubLogins: linked });
    }
    if (!identity.githubLinked(result.login)) return response.status(403).json({ status: "denied", error: `GitHub account ${result.login} is not linked to this BoxPilot. Sign in with your password and link it in Settings.`, code: "identity_not_linked" });
    const owner = store.findFirstOwner();
    if (!owner) return response.status(409).json({ status: "error", error: "Owner bootstrap is required first" });
    return response.json({ status: "complete", session: auth.issueSession(request, response, owner, { method: "github", detail: result.login }) });
  });

  // ---- authenticated management --------------------------------------------------------------
  router.get("/auth/identity/links", auth.requireSession, async (request, response) => {
    const tailscale = await identity.tailscaleIdentity(request);
    response.json({ ...identity.summary(), currentTailscale: tailscale.available ? { login: tailscale.login, displayName: tailscale.displayName, node: tailscale.node, linked: tailscale.linked } : null });
  });

  router.post("/auth/identity/tailscale", auth.requireSession, auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    const tailscale = await identity.tailscaleIdentity(request);
    if (!tailscale.available) return response.status(400).json({ error: "Open BoxPilot over Tailscale to link the identity you are connecting with", code: "no_tailscale_identity" });
    response.json({ tailscaleLogins: identity.linkTailscale(owner.id, tailscale.login), login: tailscale.login });
  });

  router.delete("/auth/identity/tailscale", auth.requireSession, auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    const login = request.body?.login;
    if (typeof login !== "string") return response.status(400).json({ error: "login is required", code: "invalid_request" });
    response.json({ tailscaleLogins: identity.unlinkTailscale(owner.id, login) });
  });

  router.put("/settings/github-client-id", auth.requireSession, auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    try {
      identity.setGithubClientId(owner.id, request.body?.clientId ?? "");
      response.json(identity.summary());
    } catch (error) {
      response.status(400).json({ error: error.message, code: "invalid_setting" });
    }
  });

  router.post("/auth/identity/github/start", auth.requireSession, auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    try {
      response.json(await identity.githubStart({ purpose: "link", ownerId: owner.id }));
    } catch (error) {
      response.status(503).json({ error: error.message, code: "github_start_failed" });
    }
  });

  router.delete("/auth/identity/github", auth.requireSession, auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    const login = request.body?.login;
    if (typeof login !== "string") return response.status(400).json({ error: "login is required", code: "invalid_request" });
    response.json({ githubLogins: identity.unlinkGithub(owner.id, login) });
  });

  return router;
}
