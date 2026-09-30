/**
 * Power routes (web process): detect a UPS on USB so the System page can offer one-click
 * monitoring setup, and the power panel's facts (M39): the UPS as NUT on localhost reports it, the
 * power-event log, what BoxPilot set up for the UPS, and how to make the server start by itself
 * after an outage. Reads sysfs, files any user can read and upsc on loopback; no privileges.
 */
import { Router } from "express";
import { access } from "node:fs/promises";
import { detectUsbUps } from "../ups-detect.mjs";
import { readPowerEvents, readPowerPolicy } from "../power-events.mjs";
import { powerOnGuidance, readBoardVendor } from "../power-on-guidance.mjs";
import { createUpsService, unavailableUpsEvidence } from "../ups.mjs";

export function createPowerRouter({
  detect = detectUsbUps,
  exists = (file) => access(file).then(() => true, () => false),
  events = () => readPowerEvents({ limit: 50 }),
  policy = () => readPowerPolicy(),
  boardVendor = () => readBoardVendor(),
  ups = createUpsService(),
} = {}) {
  const router = Router();
  router.get("/power/ups/detect", async (_request, response) => {
    const [devices, nutInstalled] = await Promise.all([detect().catch(() => []), exists("/usr/bin/upsc")]);
    response.json({ devices, nutInstalled });
  });
  router.get("/power/overview", async (_request, response) => {
    const [state, log, setup, vendor] = await Promise.all([
      ups.inspect().catch(() => unavailableUpsEvidence()),
      events().catch(() => ({ available: "unreadable", events: [] })),
      policy().catch(() => null),
      boardVendor().catch(() => null),
    ]);
    response.json({ ups: state, events: log.events, eventsAvailable: log.available, policy: setup, guidance: powerOnGuidance({ boardVendor: vendor, upsConfigured: Boolean(setup) }) });
  });
  return router;
}
