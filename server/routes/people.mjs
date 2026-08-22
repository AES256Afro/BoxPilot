/**
 * People (M5.4): the owner adds operators and viewers, changes roles, and disables accounts.
 * Owner-only (enforced in index.mjs); every change re-asks the owner's password.
 */
import { Router } from "express";
import { hashPassword } from "../security.mjs";

const usernamePattern = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function createPeopleRouter({ state, auth }) {
  const router = Router();

  async function ownerWithPassword(request, response) {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
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
    if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 256) return response.status(400).json({ error: "The new account's password must be 12 to 256 characters", code: "invalid_password" });
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
