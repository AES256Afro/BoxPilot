/**
 * Passkey (WebAuthn) routes: sign-in, recovery-code sign-in, and management (M19.1). Mounted at
 * /api/v1. The sign-in routes are open (they are for people who are not signed in yet); the rest
 * state their own session requirement, since this router is mounted before the global role policy.
 *
 * Removing a passkey and minting recovery codes each re-check the account password, because both
 * weaken or bypass the passkey factor and a session cookie alone should not be enough to do that.
 * Registering and renaming do not: the WebAuthn gesture (a biometric or PIN) is itself the consent,
 * and a passkey you did not intend costs nothing.
 */
import { Router } from "express";
import { createLoginThrottle } from "./../login-throttle.mjs";

export function createPasskeyRouter({ store, auth, passkeys, identity = null }) {
  const router = Router();
  const manage = [auth.requireSession, auth.requireCsrf];
  // A gentle throttle on recovery-code guesses. The codes are ~99 bits, so this is hygiene against
  // request spam more than a real brute-force defence, and it never hard-locks the honest owner for long.
  const recoveryThrottle = createLoginThrottle({ maxFailures: 10, baseDelayMs: 2_000, maxDelayMs: 60_000 });

  async function callerKey(request) {
    const address = identity ? await identity.clientAddress(request).catch(() => null) : null;
    return `recovery:${address ?? request.socket?.remoteAddress ?? request.ip ?? "unknown"}`;
  }

  async function ownerWithPassword(request, response) {
    const session = request.boxpilotSession;
    const owner = session ? store.findOwnerById(session.owner.id) : null;
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
    if (verdict.blocked) { auth.rejectThrottled(response, verdict); return null; }
    if (!verdict.ok) { response.status(401).json({ error: "Your password is needed to change passkeys", code: "reauthentication_required" }); return null; }
    return owner;
  }

  // ---- Sign in with a passkey (open) ---------------------------------------------------------
  router.post("/auth/passkey/options", (request, response) => {
    try {
      response.json(passkeys.authenticateOptions({ origin: request.body?.origin }));
    } catch (error) {
      response.status(400).json({ error: error.message, code: "passkey_unavailable" });
    }
  });

  router.post("/auth/passkey/verify", (request, response) => {
    let result;
    try {
      result = passkeys.authenticateVerify({ origin: request.body?.origin, response: request.body?.response });
    } catch (error) {
      return response.status(401).json({ error: error.message, code: "passkey_rejected" });
    }
    try {
      return response.json(auth.issueSession(request, response, result.owner, { method: "passkey", detail: result.credential.label }));
    } catch (error) {
      return response.status(403).json({ error: error.message, code: "identity_refused" });
    }
  });

  // ---- Sign in with a recovery code (open) ---------------------------------------------------
  router.post("/auth/passkey/recovery", async (request, response) => {
    const key = [await callerKey(request)];
    const gate = recoveryThrottle.check(key);
    if (gate.blocked) { response.setHeader("Retry-After", String(Math.ceil(gate.retryAfterMs / 1000))); return response.status(429).json({ error: `Too many attempts; try again in ${Math.ceil(gate.retryAfterMs / 1000)} s`, code: "too_many_attempts" }); }
    const owner = passkeys.useRecoveryCode(request.body?.code);
    recoveryThrottle.record(key, Boolean(owner));
    if (!owner) return response.status(401).json({ error: "That recovery code is not valid", code: "recovery_rejected" });
    // The code being spent is audited in consumeRecoveryCode, and issueSession audits session.created.
    try {
      return response.json({ ...auth.issueSession(request, response, owner, { method: "recovery-code" }), recoveryCodesRemaining: store.countRecoveryCodes(owner.id) });
    } catch (error) {
      return response.status(403).json({ error: error.message, code: "identity_refused" });
    }
  });

  // ---- Manage your own passkeys (signed in) --------------------------------------------------
  router.get("/auth/passkey", auth.requireSession, (request, response) => {
    response.json(passkeys.status(request.boxpilotSession.owner.id));
  });

  router.post("/auth/passkey/register/options", auth.requireSession, auth.requireCsrf, (request, response) => {
    const owner = store.findOwnerById(request.boxpilotSession.owner.id);
    try {
      response.json(passkeys.registerOptions({ owner, origin: request.body?.origin }));
    } catch (error) {
      response.status(400).json({ error: error.message, code: "passkey_unavailable" });
    }
  });

  router.post("/auth/passkey/register/verify", auth.requireSession, auth.requireCsrf, (request, response) => {
    const owner = store.findOwnerById(request.boxpilotSession.owner.id);
    try {
      const stored = passkeys.registerVerify({ owner, origin: request.body?.origin, credential: request.body?.credential });
      response.status(201).json({ registered: true, passkey: { id: stored.id, label: stored.label, rpId: stored.rpId, createdAt: stored.createdAt } });
    } catch (error) {
      response.status(400).json({ error: error.message, code: "passkey_registration_failed" });
    }
  });

  router.put("/auth/passkey/:id", ...manage, (request, response) => {
    try {
      passkeys.rename(request.boxpilotSession.owner.id, request.params.id, request.body?.label);
      response.json(passkeys.status(request.boxpilotSession.owner.id));
    } catch (error) {
      response.status(400).json({ error: error.message, code: "passkey_rename_failed" });
    }
  });

  router.delete("/auth/passkey/:id", ...manage, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    try {
      passkeys.remove(owner.id, request.params.id);
      response.json(passkeys.status(owner.id));
    } catch (error) {
      response.status(404).json({ error: error.message, code: "passkey_not_found" });
    }
  });

  // ---- Recovery codes (signed in, password re-checked) ---------------------------------------
  router.post("/auth/passkey/recovery-codes", ...manage, async (request, response) => {
    const owner = await ownerWithPassword(request, response); if (!owner) return;
    const { codes, count } = passkeys.generateRecoveryCodes(owner.id, { actorId: owner.id });
    response.json({ codes, count });
  });

  return router;
}
