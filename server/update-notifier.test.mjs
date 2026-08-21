import { describe, expect, it, vi } from "vitest";
import { createUpdateNotifier } from "./update-notifier.mjs";

function fixture({ updateAvailable = true, target = { kind: "ntfy" }, notifiedTag = null } = {}) {
  const settings = new Map(notifiedTag ? [["updateNotifiedTag", notifiedTag]] : []);
  const store = { getSetting: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback), setSetting: vi.fn((key, value) => settings.set(key, value)), recordAudit: vi.fn() };
  const releaseUpdates = { inspect: vi.fn(async () => ({ current: { version: "0.62.5" }, latest: updateAvailable ? { tag: "v0.62.7", version: "0.62.7" } : null, updateAvailable, error: null })) };
  const notifications = { getTarget: () => target, send: vi.fn(async () => ({ sent: true })) };
  return { store, releaseUpdates, notifications, notifier: createUpdateNotifier({ releaseUpdates, notifications, store, now: () => new Date("2026-08-21T15:00:00.000Z") }) };
}

describe("update notifier", () => {
  it("notifies once per newer release and remembers it", async () => {
    const { notifier, notifications, store, releaseUpdates } = fixture();
    await expect(notifier.check()).resolves.toEqual({ notified: true, reason: "sent", latest: "v0.62.7" });
    expect(releaseUpdates.inspect).toHaveBeenCalledWith({ refresh: true });
    expect(notifications.send).toHaveBeenCalledWith(expect.objectContaining({ title: "BoxPilot v0.62.7 is available", message: expect.stringContaining("System → BoxPilot updates") }));
    expect(store.setSetting).toHaveBeenCalledWith("updateNotifiedTag", "v0.62.7", expect.anything());
    await expect(notifier.check()).resolves.toMatchObject({ notified: false, reason: "already-notified" });
    expect(notifications.send).toHaveBeenCalledOnce();
  });

  it("stays quiet when up to date or when no notification target exists", async () => {
    await expect(fixture({ updateAvailable: false }).notifier.check()).resolves.toMatchObject({ notified: false, reason: "up-to-date" });
    const silent = fixture({ target: null });
    await expect(silent.notifier.check()).resolves.toMatchObject({ notified: false, reason: "no-target" });
    expect(silent.notifications.send).not.toHaveBeenCalled();
  });

  it("schedules an initial check and a recurring one, both unref'd and stoppable", () => {
    const handles = [];
    const fake = () => { const handle = { unref: vi.fn() }; handles.push(handle); return handle; };
    const clearInterval = vi.fn(); const clearTimeout = vi.fn();
    const { releaseUpdates, notifications, store } = fixture();
    const notifier = createUpdateNotifier({ releaseUpdates, notifications, store, setInterval: fake, setTimeout: fake, clearInterval, clearTimeout });
    const stop = notifier.start();
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle.unref.mock.calls.length === 1)).toBe(true);
    stop();
    expect(clearTimeout).toHaveBeenCalledWith(handles[0]);
    expect(clearInterval).toHaveBeenCalledWith(handles[1]);
  });
});
