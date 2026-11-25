import { describe, expect, it } from "vitest";
import { alertDestination } from "./alertDestination";

describe("where an alert leads (M88)", () => {
  // Each family goes where its own message says the fix is (server/health-alerts.mjs and friends).
  it.each([
    ["storage.root.full", "system", "housekeeping", "Open Housekeeping"],
    ["storage.mount.full", "storage", "mounts", "Open Mounts"],
    ["storage.mount.detached", "repairs", undefined, "Open Repair"],
    ["storage.mount.readonly", "repairs", undefined, "Open Repair"],
    ["storage.smart", "storage", undefined, "Open Storage"],
    ["smart.errors", "storage", undefined, "Open Storage"],
    ["drive.reconnected", "storage", undefined, "Open Storage"],
    ["docker.unhealthy", "catalog", undefined, "Open Apps"],
    ["docker.restarting", "catalog", undefined, "Open Apps"],
    ["system.services", "services", undefined, "Open Services"],
    ["boxpilot.restart", "services", undefined, "Open Services"],
    ["system.reboot", "system", "power", "Open the Power tab"],
    ["power.ups", "system", "power", "Open the Power tab"],
    ["power.lost", "system", "power", "Open the Power tab"],
    ["schedule.overdue", "automations", "schedules", "Open Schedules"],
    ["schedule.failed", "system", "schedules", "Open Schedules"],
    ["flow.failed", "automations", undefined, "Open Automations"],
    ["release.available", "system", "updates", "Open the BoxPilot update"],
    ["signin.new", "settings", "account", "Open Settings"],
    ["report.weekly", "settings", "notifications", "Open Settings"],
    ["hosted.down", "hosted", undefined, "Open Hosted domains"],
    ["hosted.cert", "hosted", undefined, "Open Hosted domains"],
    ["agent.important", "agents", undefined, "Open Agents"],
    ["joblog.unreadable", "repairs", undefined, "Open Repair"],
  ])("%s opens %s", (family, view, tab, label) => {
    expect(alertDestination(family)).toEqual({ view, ...(tab ? { tab } : {}), label });
  });

  it("reads a whole key as its family", () => {
    expect(alertDestination("storage.mount.full:/mnt/media")).toMatchObject({ view: "storage", tab: "mounts" });
    expect(alertDestination("agent.important:a1:risk")).toMatchObject({ view: "agents" });
  });
});
