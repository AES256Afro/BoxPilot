import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationService } from "./notifications.mjs";
import { holds, isQuiet, normalizeQuietHours, quietHoursProblem, summaryOf } from "./quiet-hours.mjs";
import { createStateStore } from "./state.mjs";

const at = (time) => new Date(`2026-10-19T${time}:00.000Z`);
const night = { enabled: true, start: "22:00", end: "07:00", holdHigh: false };

describe("when quiet hours are", () => {
  it("wrap past midnight, and a daytime window does not", () => {
    expect(isQuiet(night, at("23:30"), "UTC")).toBe(true);
    expect(isQuiet(night, at("03:00"), "UTC")).toBe(true);
    expect(isQuiet(night, at("07:00"), "UTC")).toBe(false);
    expect(isQuiet(night, at("21:59"), "UTC")).toBe(false);
    const lunch = { enabled: true, start: "12:00", end: "13:30" };
    expect(isQuiet(lunch, at("12:45"), "UTC")).toBe(true);
    expect(isQuiet(lunch, at("13:30"), "UTC")).toBe(false);
    expect(isQuiet({ ...night, enabled: false }, at("03:00"), "UTC")).toBe(false);
    // On the server's own clock, unless a zone is given.
    expect(isQuiet(night, at("03:00"), "Asia/Tokyo")).toBe(false);   // noon there
  });

  it("let urgent pushes through unless the owner holds those too", () => {
    expect(holds(night, "default", at("03:00"), "UTC")).toBe(true);
    expect(holds(night, "high", at("03:00"), "UTC")).toBe(false);
    expect(holds({ ...night, holdHigh: true }, "high", at("03:00"), "UTC")).toBe(true);
    expect(holds(night, "default", at("12:00"), "UTC")).toBe(false);
  });

  it("read back with defaults and refuse what is not a setting", () => {
    expect(normalizeQuietHours(null)).toEqual({ enabled: false, start: "22:00", end: "07:00", holdHigh: false });
    expect(normalizeQuietHours({ enabled: true, start: "25:00", end: "06:30" })).toEqual({ enabled: true, start: "22:00", end: "06:30", holdHigh: false });
    expect(quietHoursProblem(night)).toBeNull();
    expect(quietHoursProblem({ ...night, start: "7:00" })).toContain("times like");
    expect(quietHoursProblem({ ...night, end: "22:00" })).toContain("differ");
    expect(quietHoursProblem({ ...night, enabled: "yes" })).toContain("enabled");
  });

  it("sum up what waited in one push, urgent if any of it was", () => {
    const summary = summaryOf([{ title: "BoxPilot: A reboot is required", priority: "default" }, { title: "BoxPilot: Backup failed", priority: "high" }]);
    expect(summary.title).toBe("BoxPilot: 2 notifications during quiet hours");
    expect(summary.message).toContain("- A reboot is required\n- Backup failed");
    expect(summary.priority).toBe("high");
    expect(summaryOf(Array.from({ length: 15 }, (_, index) => ({ title: `n${index}` }))).message).toContain("…and 3 earlier");
  });
});

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-quiet-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  let clock = at("23:00");
  let up = true;
  const sent = [];
  const fetcher = vi.fn(async (_url, options) => { if (!up) return { ok: false, status: 503 }; sent.push(options); return { ok: true, status: 200 }; });
  const service = createNotificationService({ store, fetcher, now: () => clock, timeZone: "UTC", lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  service.setTarget({ kind: "ntfy", url: "http://127.0.0.1:8093", topic: "boxpilot" });
  store.setSetting("notificationQuietHours", night);
  return { store, service, sent, setClock: (time) => { clock = at(time); }, setUp: (value) => { up = value; } };
}

describe("pushes during quiet hours", () => {
  it("hold until the quiet ends, then go as one summary; urgent ones and the test button go at once", async () => {
    const { service, sent, setClock } = await setup();
    expect(await service.send({ title: "BoxPilot: A reboot is required", message: "m" })).toMatchObject({ sent: false, held: true });
    expect(await service.send({ title: "BoxPilot: Disk failing", message: "m", priority: "high" })).toMatchObject({ sent: true });
    expect(await service.send({ title: "BoxPilot test notification", message: "m" }, { immediate: true })).toMatchObject({ sent: true });
    expect(sent.map((options) => options.headers.Title)).toEqual(["BoxPilot: Disk failing", "BoxPilot test notification"]);
    expect(service.quietHours()).toMatchObject({ enabled: true, held: 1, quietNow: true });

    // Still quiet: nothing goes.
    setClock("06:59");
    expect(await service.flushHeld()).toEqual({ sent: false, count: 0 });
    setClock("07:00");
    expect(await service.flushHeld()).toEqual({ sent: true, count: 1 });
    expect(sent.at(-1).headers.Title).toBe("BoxPilot: 1 notification during quiet hours");
    expect(sent.at(-1).body).toContain("- A reboot is required");
    expect(service.quietHours().held).toBe(0);
    expect(await service.flushHeld()).toEqual({ sent: false, count: 0 });
  });

  it("keeps what waited when the summary cannot be sent, and sends it a minute later", async () => {
    const { service, sent, setClock, setUp } = await setup();
    await service.send({ title: "BoxPilot: one", message: "m" });
    await service.send({ title: "BoxPilot: two", message: "m" });
    setClock("07:05");
    setUp(false);
    expect(await service.flushHeld()).toEqual({ sent: false, count: 2 });
    expect(service.quietHours().held).toBe(2);
    setUp(true);
    expect(await service.flushHeld()).toEqual({ sent: true, count: 2 });
    expect(sent.at(-1).body).toContain("- one\n- two");
  });

  it("holds urgent pushes too when the owner asks", async () => {
    const { store, service, sent } = await setup();
    store.setSetting("notificationQuietHours", { ...night, holdHigh: true });
    expect(await service.send({ title: "BoxPilot: Disk failing", message: "m", priority: "high" })).toMatchObject({ held: true });
    expect(sent).toEqual([]);
  });
});
