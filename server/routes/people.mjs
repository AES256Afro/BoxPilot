/**
 * People (M5.4): the owner adds operators and viewers, changes roles, and disables accounts.
 * Owner-only (enforced in index.mjs); every change asks the owner's password, or is made inside
 * the short window a password already opened on this session (auth.checkPasswordOrElevation).
 */
import { Router } from "express";
import { hashPassword, newPasswordProblem } from "../security.mjs";

const usernamePattern = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function createPeopleRouter({ state, auth }) {
  const router = Router();

  async function ownerWithPassword(request, response) {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPasswordOrElevation(request, owner, request.body?.password);
    if (verdict.blocked) { auth.rejectThrottled(response, verdict); return null; }
    if (!verdict.ok) {
      response.status(401).json({ error: "Owner password required", code: "reauthentication_required" });
      return null;
    }
    return owner;
  }

  router.get("/people", (_request, response) => {
    response.json({ people: state.listOwners(), roles: ["owner", "operator", "viewer"] });
  });

  router.post("/people", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response);
    if (!owner) return undefined;
    const { username, newPassword, role } = request.body ?? {};
    if (typeof username !== "string" || !usernamePattern.test(username)) return response.status(400).json({ error: "User name must be 2-32 lower-case letters, digits, dots, dashes, or underscores", code: "invalid_username" });
    if (newPasswordProblem(newPassword)) return response.status(400).json({ error: newPasswordProblem(newPassword, "The new account's password"), code: "invalid_password" });
    try {
      const account = state.createOwnerAccount({ username, passwordHash: await hashPassword(newPassword), role, createdBy: owner.id });
      return response.status(201).json({ account });
    } catch (error) {
      return response.status(400).json({ error: error.message, code: "people_rejected" });
    }
  });

  router.put("/people/:id", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response);
    if (!owner) return undefined;
    if (request.params.id === owner.id && request.body?.role !== "owner") return response.status(400).json({ error: "Change your own role from another owner account", code: "people_rejected" });
    try {
      return response.json({ account: state.setOwnerRole(request.params.id, request.body?.role, { actorId: owner.id }) });
    } catch (error) {
      return response.status(error.message === "Account not found" ? 404 : 400).json({ error: error.message, code: "people_rejected" });
    }
  });

  // A member who forgot theirs: the owner sets a new one and tells them. Their sessions end, so the
  // old password's sign-ins go with it. The owner's own is changed in the Password panel, which
  // asks for the current one.
  router.post("/people/:id/password", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response);
    if (!owner) return undefined;
    if (request.params.id === owner.id) return response.status(400).json({ error: "Change your own password under Settings, Account & sign-in", code: "people_rejected" });
    const newPassword = request.body?.newPassword;
    if (newPasswordProblem(newPassword)) return response.status(400).json({ error: newPasswordProblem(newPassword), code: "invalid_password" });
    const account = state.findOwnerById(request.params.id);
    if (!account) return response.status(404).json({ error: "Account not found", code: "people_rejected" });
    if (account.role === "disabled") return response.status(400).json({ error: "That account is disabled, so it has no password to sign in with", code: "people_rejected" });
    const set = state.setOwnerPassword(account.id, await hashPassword(newPassword), { actorId: owner.id, auditType: "people.password.set" });
    return response.json({ account: { id: set.id, username: set.username, role: set.role }, sessionsEnded: set.sessionsEnded });
  });

  router.delete("/people/:id", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response);
    if (!owner) return undefined;
    if (request.params.id === owner.id) return response.status(400).json({ error: "You cannot disable the account you are signed in with", code: "people_rejected" });
    try {
      return response.json({ account: state.disableOwner(request.params.id, { actorId: owner.id }) });
    } catch (error) {
      return response.status(error.message === "Account not found" ? 404 : 400).json({ error: error.message, code: "people_rejected" });
    }
  });

  return router;
}
