/**
 * Power routes (web process): detect a UPS on USB so the System page can offer one-click
 * monitoring setup (reads sysfs only; no privileges, no network), and the times this server went
 * down without shutting down (server/power-loss.mjs), which Home says once until someone has seen it.
 */
import { Router } from "express";
import { access } from "node:fs/promises";
import { detectUsbUps } from "../ups-detect.mjs";
import { acknowledgeOutage, outagesSetting } from "../power-loss.mjs";
import { callerId, withOwnActors } from "./access.mjs";

const outageIdPattern = /^[0-9a-f]{32}$/;

export function createPowerRouter({ detect = detectUsbUps, exists = (file) => access(file).then(() => true, () => false), state = null, alerts = null, auth = null } = {}) {
  const router = Router();
  router.get("/power/ups/detect", async (_request, response) => {
    const [devices, nutInstalled] = await Promise.all([detect().catch(() => []), exists("/usr/bin/upsc")]);
    response.json({ devices, nutInstalled });
  });
  if (!state) return router;

  // Every role may read when the server went down and for how long; who said "Got it" is the owner's.
  router.get("/power/outages", (request, response) => {
    const outages = (state.getSetting(outagesSetting, []) ?? []).filter((entry) => entry && typeof entry.id === "string");
    response.json(withOwnActors(request, { outages, unacknowledged: outages.filter((entry) => !entry.acknowledged).length }));
  });

  // "Got it" on Home: the outage stays on record and stops being said. Viewers are refused by the role policy.
  router.post("/power/outages/:id/acknowledge", auth?.requireCsrf ?? ((_request, _response, next) => next()), async (request, response) => {
    const id = String(request.params.id ?? "");
    if (!outageIdPattern.test(id)) return response.status(400).json({ error: "Name the outage", code: "outage_rejected" });
    const outage = await acknowledgeOutage({ store: state, alerts, id, by: callerId(request) });
    if (!outage) return response.status(404).json({ error: "No such outage is on record", code: "outage_not_found" });
    state.recordAudit?.("power.outage.acknowledged", { actorId: callerId(request), subjectId: id, details: { stoppedAt: outage.stoppedAt ?? null } });
    return response.json(withOwnActors(request, { outage }));
  });
  return router;
}
