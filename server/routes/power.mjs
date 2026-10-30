/**
 * Power routes (web process): detect a UPS on USB so the System page can offer one-click
 * monitoring setup, and the power panel's facts (M39): the UPS as NUT on localhost reports it, the
 * power-event log, what BoxPilot set up for the UPS, and how to make the server start by itself
 * after an outage. Reads sysfs, files any user can read and upsc on loopback; no privileges. Also
 * the times this server went down without shutting down (server/power-loss.mjs), which Home says
 * once until someone has seen it.
 */
import { Router } from "express";
import { access } from "node:fs/promises";
import { detectUsbUps } from "../ups-detect.mjs";
import { readPowerEvents, readPowerPolicy } from "../power-events.mjs";
import { powerOnGuidance, readBoardVendor } from "../power-on-guidance.mjs";
import { createUpsService, unavailableUpsEvidence } from "../ups.mjs";
import { acknowledgeOutage, outagesSetting } from "../power-loss.mjs";
import { callerId, withOwnActors } from "./access.mjs";

const outageIdPattern = /^[0-9a-f]{32}$/;

export function createPowerRouter({
  detect = detectUsbUps,
  exists = (file) => access(file).then(() => true, () => false),
  events = () => readPowerEvents({ limit: 50 }),
  policy = () => readPowerPolicy(),
  boardVendor = () => readBoardVendor(),
  ups = createUpsService(),
  state = null,
  alerts = null,
  auth = null,
} = {}) {
  const router = Router();
  router.get("/power/ups/detect", async (_request, response) => {
    const [devices, nutInstalled] = await Promise.all([detect().catch(() => []), exists("/usr/bin/upsc")]);
    response.json({ devices, nutInstalled });
  });
  // Above the `if (!state) return router;` below: it needs no state, and below an early return it
  // would not be registered at all.
  router.get("/power/overview", async (_request, response) => {
    const [reading, log, setup, vendor] = await Promise.all([
      ups.inspect().catch(() => unavailableUpsEvidence()),
      events().catch(() => ({ available: "unreadable", events: [] })),
      policy().catch(() => null),
      boardVendor().catch(() => null),
    ]);
    response.json({ ups: reading, events: log.events, eventsAvailable: log.available, policy: setup, guidance: powerOnGuidance({ boardVendor: vendor, upsConfigured: Boolean(setup) }) });
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
