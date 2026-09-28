import { describe, expect, it, vi } from "vitest";
import { createUpdateNotifier } from "./update-notifier.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";

function fixture({ updateAvailable = true, target = { kind: "ntfy" }, notifiedTag = null, send = vi.fn(async () => ({ sent: true })), latest = "v0.62.7" } = {}) {
  const settings = new Map(notifiedTag ? [["updateNotifiedTag", notifiedTag]] : []);
  const store = { getSetting: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback), setSetting: vi.fn((key, value) => settings.set(key, value)), recordAudit: vi.fn() };
  let release = { current: { version: "0.62.5" }, latest: updateAvailable ? { tag: latest, version: latest.slice(1) } : null, updateAvailable, error: null };
  const releaseUpdates = { inspect: vi.fn(async () => release) };
  let current = target;
  const notifications = { getTarget: () => current, send };
  let clock = new Date("2026-08-21T15:00:00.000Z");
  const now = () => clock;
  // The real ledger over the same settings, so what is kept is what the Overview would count.
  const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications, store, now });
  return {
    store, releaseUpdates, notifications, alerts, send,
    ledger: () => settings.get("healthAlertsState") ?? {},
    setTarget: (value) => { current = value; },
    setRelease: (value) => { release = { ...release, ...value }; },
    setClock: (value) => { clock = new Date(value); },
    notifier: createUpdateNotifier({ releaseUpdates, notifications, alerts, store, now }),
  };
}

describe("update notifier", () => {
  it("notifies once per newer release and remembers it", async () => {
    const { notifier, send, store, releaseUpdates, ledger } = fixture();
    await expect(notifier.check()).resolves.toEqual({ notified: true, reason: "sent", latest: "v0.62.7" });
    expect(releaseUpdates.inspect).toHaveBeenCalledWith({ refresh: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: "BoxPilot: Version 0.62.7 is available", message: expect.stringContaining("System → BoxPilot updates") }));
    expect(store.setSetting).toHaveBeenCalledWith("updateNotifiedTag", "v0.62.7", expect.anything());
    expect(ledger()).toEqual({}); // delivered news leaves nothing behind
    await expect(notifier.check()).resolves.toMatchObject({ notified: false, reason: "already-notified" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("stays quiet when up to date", async () => {
    const { notifier, send } = fixture({ updateAvailable: false });
    await expect(notifier.check()).resolves.toMatchObject({ notified: false, reason: "up-to-date" });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a release nobody was told about as one not-announced entry, sent once a target answers (M27.2)", async () => {
    const { notifier, send, ledger, alerts, setTarget } = fixture({ target: null });
    await expect(notifier.check()).resolves.toMatchObject({ notified: false, reason: "not-announced", latest: "v0.62.7" });
    expect(send).not.toHaveBeenCalled();
    expect(ledger()["release.available"]).toMatchObject({ title: "Version 0.62.7 is available", notified: false, since: "2026-08-21T15:00:00.000Z" });
    // The six-hourly check does not add it again: the ledger holds it now.
    await expect(notifier.check()).resolves.toMatchObject({ reason: "already-notified" });
    expect(Object.keys(ledger())).toEqual(["release.available"]);

    setTarget({ kind: "ntfy" });
    expect((await alerts.check()).sent).toEqual(["release.available"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: "BoxPilot: Version 0.62.7 is available" }));
    expect(ledger()).toEqual({});
  });

  it("keeps a release whose send failed, replaces it with a newer one, and drops it once applied", async () => {
    const send = vi.fn(async () => { throw new Error("The notification target answered 502"); });
    const { notifier, ledger, setRelease } = fixture({ send });
    await expect(notifier.check()).resolves.toMatchObject({ notified: false, reason: "not-announced" });
    expect(ledger()["release.available"]).toMatchObject({ notified: false });

    setRelease({ latest: { tag: "v0.62.9", version: "0.62.9" } });
    await notifier.check();
    expect(Object.keys(ledger())).toEqual(["release.available"]); // one entry, the newest release
    expect(ledger()["release.available"]).toMatchObject({ title: "Version 0.62.9 is available", since: "2026-08-21T15:00:00.000Z" });

    // Applied: nothing left to tell. A failed check proves nothing and leaves it alone.
    setRelease({ latest: null, updateAvailable: false, error: "GitHub did not answer" });
    await expect(notifier.check()).resolves.toMatchObject({ reason: "check-failed" });
    expect(Object.keys(ledger())).toEqual(["release.available"]);
    setRelease({ error: null });
    await expect(notifier.check()).resolves.toMatchObject({ reason: "up-to-date" });
    expect(ledger()).toEqual({});
  });

  it("still tells a newer release that replaced one kept for a month, once a target answers", async () => {
    // v0.62.7 is kept with nowhere to send it; three weeks later v0.62.9 replaces it. The ledger's
    // month is counted from v0.62.9, not from v0.62.7: dropping it as old news would lose the newer
    // release for good, since the notifier remembers it as told and never adds it again.
    const { notifier, send, ledger, alerts, setTarget, setRelease, setClock } = fixture({ target: null });
    await expect(notifier.check()).resolves.toMatchObject({ reason: "not-announced", latest: "v0.62.7" });
    setClock("2026-09-11T15:00:00.000Z");
    setRelease({ latest: { tag: "v0.62.9", version: "0.62.9" } });
    await expect(notifier.check()).resolves.toMatchObject({ reason: "not-announced", latest: "v0.62.9" });
    setClock("2026-09-21T15:00:00.000Z"); // 31 days after v0.62.7 was kept, 10 after v0.62.9
    await alerts.check();
    await expect(notifier.check()).resolves.toMatchObject({ reason: "already-notified" });
    setTarget({ kind: "ntfy" });
    expect((await alerts.check()).sent).toEqual(["release.available"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: "BoxPilot: Version 0.62.9 is available" }));
    expect(ledger()).toEqual({});
  });

  it("schedules an initial check and a recurring one, both unref'd and stoppable", () => {
    const handles = [];
    const fake = () => { const handle = { unref: vi.fn() }; handles.push(handle); return handle; };
    const clearInterval = vi.fn(); const clearTimeout = vi.fn();
    const { releaseUpdates, notifications, alerts, store } = fixture();
    const notifier = createUpdateNotifier({ releaseUpdates, notifications, alerts, store, setInterval: fake, setTimeout: fake, clearInterval, clearTimeout });
    const stop = notifier.start();
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle.unref.mock.calls.length === 1)).toBe(true);
    stop();
    expect(clearTimeout).toHaveBeenCalledWith(handles[0]);
    expect(clearInterval).toHaveBeenCalledWith(handles[1]);
  });
});
