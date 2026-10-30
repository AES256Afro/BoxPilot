import { describe, expect, it, vi } from "vitest";
import { createLaneQueues, laneFor } from "./helper-lanes.mjs";
import { resumeInterruptedBackups } from "./interrupted-backups.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * After a power cut with Docker down, the helper held Jellyfin's lane while it tried `compose start`
 * 40 times, 15 seconds apart, each try up to three minutes. The Docker lane waits for every app lane,
 * so the owner's own fix - starting docker.service from Services, a package repair, installing
 * Docker - queued behind it for ten minutes, and up to two hours.
 */
describe("putting right a backup a power cut cut off", () => {
  const entry = { id: "jellyfin", restart: true, partial: "20260929T031500Z.tar.gz.partial", startedAt: "2026-09-29T03:15:00.000Z" };

  it("waits for Docker outside the app's lane, so starting Docker is not queued behind it", async () => {
    const lanes = createLaneQueues();
    let dockerUp;
    const order = [];
    const apps = {
      waitForDocker: vi.fn(() => new Promise((resolve) => { dockerUp = () => { order.push("docker answers"); resolve(true); }; })),
      resumeInterruptedBackup: vi.fn(async ({ id }) => { order.push(`start ${id}`); return { id, removedPartial: true, restarted: true }; }),
    };
    const log = vi.fn();
    const done = resumeInterruptedBackups([entry], { apps, lanes, log });
    await tick();
    expect(apps.waitForDocker).toHaveBeenCalledTimes(1);
    // While it waits, the owner's start of Docker is not held up.
    const startDocker = laneFor("service.action", { unit: "docker.service", action: "start" });
    expect(lanes.busy(startDocker)).toBe(false);
    await lanes.run(startDocker, async () => { order.push("owner starts docker"); dockerUp(); });
    await done;
    expect(order).toEqual(["owner starts docker", "docker answers", "start jellyfin"]);
    expect(apps.resumeInterruptedBackup).toHaveBeenCalledWith(entry);
    expect(log.mock.calls.some(([line]) => /Started jellyfin again/.test(line))).toBe(true);
  });

  it("starts the app under its own lane, so nothing else reaches it at the same moment", async () => {
    const lanes = createLaneQueues();
    let release;
    const apps = {
      waitForDocker: vi.fn(async () => true),
      resumeInterruptedBackup: vi.fn(() => new Promise((resolve) => { release = () => resolve({ id: "jellyfin", removedPartial: false, restarted: true }); })),
    };
    const done = resumeInterruptedBackups([entry], { apps, lanes, log: vi.fn() });
    await tick(); await tick();
    expect(apps.resumeInterruptedBackup).toHaveBeenCalled();
    expect(lanes.busy(laneFor("app.action", { id: "jellyfin", action: "stop" }))).toBe(true);
    release();
    await done;
  });

  it("does not wait for Docker for an app the backup had not stopped, and says so when Docker never came up", async () => {
    const lanes = createLaneQueues();
    const apps = {
      waitForDocker: vi.fn(async () => false),
      resumeInterruptedBackup: vi.fn(async ({ id, restart }) => ({ id, removedPartial: true, restarted: false, ...(restart ? { error: "Cannot connect to the Docker daemon" } : {}) })),
    };
    const log = vi.fn();
    await resumeInterruptedBackups([{ ...entry, id: "immich", restart: false }, entry], { apps, lanes, log });
    expect(apps.waitForDocker).toHaveBeenCalledTimes(1);
    expect(apps.resumeInterruptedBackup).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.some(([line, level]) => level === "error" && /jellyfin .*could not be started again: Cannot connect/.test(line))).toBe(true);
    expect(log.mock.calls.some(([line]) => /Removed the unfinished backup archive .* of immich/.test(line))).toBe(true);
  });
});
