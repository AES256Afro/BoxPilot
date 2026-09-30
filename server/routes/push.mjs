/**
 * Push approval routes (M25.2), mounted at /api/v1 behind the session and the role policy:
 *
 *   GET    /push                    the key a browser subscribes with, this account's devices, the owner's choices
 *   POST   /push/subscriptions      turn pushes on for this device (owner or operator)
 *   DELETE /push/subscriptions/:id  turn them off for one of this account's devices
 *   POST   /push/test               a test push to this account's devices
 *   PUT    /settings/push           the owner's choices: which tiers push, quiet hours, ntfy as fallback
 *
 * Nothing here approves anything: a push only opens BoxPilot at an approval, where the ordinary
 * dialog asks what that tier asks. The subscription's endpoint must be a browser's push service,
 * and the address pushes link to is the Origin the browser sent, so neither can be pointed elsewhere.
 */
import { Router } from "express";

const approvers = new Set(["owner", "operator"]);

export function createPushRouter({ push, auth }) {
  const router = Router();
  const account = (request) => request.boxpilotSession?.owner ?? null;
  const fail = (response, error, fallback = 400) => response.status(Number.isInteger(error?.status) ? error.status : fallback).json({ error: error?.message ?? "That could not be done", code: "push_failed" });

  router.get("/push", (request, response) => {
    const person = account(request);
    const canSubscribe = approvers.has(person?.role);
    let publicKey = null;
    let problem = null;
    if (canSubscribe) { try { publicKey = push.publicKey(); } catch (error) { problem = error.message; } }
    const settings = push.describeSettings();
    response.json({
      canSubscribe,
      publicKey,
      problem,
      devices: canSubscribe ? push.devicesOf(person.id) : [],
      // Where pushes link to is the owner's to see; everyone may read which tiers push and when it is quiet.
      settings: person?.role === "owner" ? settings : { ...settings, openAt: null },
    });
  });

  router.post("/push/subscriptions", auth.requireCsrf, (request, response) => {
    try {
      const device = push.subscribe(account(request), { subscription: request.body?.subscription, origin: request.get("origin") ?? null, label: request.body?.label });
      response.status(201).json({ device });
    } catch (error) { fail(response, error); }
  });

  router.delete("/push/subscriptions/:id", auth.requireCsrf, (request, response) => {
    try { response.json(push.unsubscribe(account(request), request.params.id)); } catch (error) { fail(response, error, 404); }
  });

  router.post("/push/test", auth.requireCsrf, async (request, response) => {
    try { response.json(await push.test(account(request))); } catch (error) { fail(response, error, 502); }
  });

  router.put("/settings/push", auth.requireCsrf, auth.requireRole("owner"), (request, response) => {
    try { response.json(push.saveSettings(request.body ?? {}, { actorId: account(request)?.id ?? null, origin: request.get("origin") ?? null })); } catch (error) { fail(response, error); }
  });

  return router;
}
