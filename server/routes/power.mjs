/**
 * Power routes (web process): detect a UPS on USB so the System page can offer one-click
 * monitoring setup. Reads sysfs only; no privileges, no network.
 */
import { Router } from "express";
import { access } from "node:fs/promises";
import { detectUsbUps } from "../ups-detect.mjs";

export function createPowerRouter({ detect = detectUsbUps, exists = (file) => access(file).then(() => true, () => false) } = {}) {
  const router = Router();
  router.get("/power/ups/detect", async (_request, response) => {
    const [devices, nutInstalled] = await Promise.all([detect().catch(() => []), exists("/usr/bin/upsc")]);
    response.json({ devices, nutInstalled });
  });
  return router;
}
