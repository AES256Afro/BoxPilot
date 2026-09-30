import { describe, expect, it, vi } from "vitest";
import { acknowledgeOutage, clockWords, createPowerLossWatch, durationWords, inspectBoots, judgePreviousBoot, outageKey, outageMessage, outageTitle, parseJournalJson, parseListBoots, shutdownMarkerIn } from "./power-loss.mjs";

const previousBoot = "7a0b2f1c3d4e5f60718293a4b5c6d7e8";
const currentBoot = "3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c";

/** One line of `journalctl -o json`, as systemd writes it. */
const line = (at, identifier, message, { pid = 1, kernel = false, boot = previousBoot } = {}) => JSON.stringify({
  __REALTIME_TIMESTAMP: String(Date.parse(at) * 1000), _BOOT_ID: boot, MESSAGE: message,
  ...(kernel ? { _TRANSPORT: "kernel", SYSLOG_IDENTIFIER: "kernel" } : { _TRANSPORT: "journal", SYSLOG_IDENTIFIER: identifier, _PID: String(pid) }),
});
const journal = (lines) => lines.join("\n");

// The end of a normal Ubuntu reboot's journal: units stop, the shutdown targets are reached, PID 1
// hands over to systemd-shutdown, which stops journald last.
const cleanReboot = journal([
  line("2026-09-27T03:10:01Z", "systemd", "Stopping docker.service - Docker Application Container Engine..."),
  line("2026-09-27T03:10:02Z", "dockerd", "time=\"2026-09-27T03:10:02Z\" level=info msg=\"Processing signal 'terminated'\"", { pid: 1203 }),
  line("2026-09-27T03:10:04Z", "systemd", "docker.service: Deactivated successfully."),
  line("2026-09-27T03:10:04Z", "systemd", "Stopped docker.service - Docker Application Container Engine."),
  line("2026-09-27T03:10:05Z", "systemd", "Unmounting boot-efi.mount - /boot/efi..."),
  line("2026-09-27T03:10:05Z", "systemd", "Unmounted boot-efi.mount - /boot/efi."),
  line("2026-09-27T03:10:05Z", "systemd", "Reached target umount.target - Unmount All Filesystems."),
  line("2026-09-27T03:10:05Z", "systemd", "Reached target shutdown.target - System Shutdown."),
  line("2026-09-27T03:10:05Z", "systemd", "Reached target final.target - Late Shutdown Services."),
  line("2026-09-27T03:10:05Z", "systemd", "Finished systemd-reboot.service - System Reboot."),
  line("2026-09-27T03:10:05Z", "systemd", "Reached target reboot.target - System Reboot."),
  line("2026-09-27T03:10:05Z", "systemd", "Shutting down."),
  line("2026-09-27T03:10:05Z", "systemd-shutdown", "Syncing filesystems and block devices."),
  line("2026-09-27T03:10:05Z", "systemd-shutdown", "Sending SIGTERM to remaining processes..."),
  line("2026-09-27T03:10:05Z", "systemd-journald", "Received SIGTERM from PID 1 (systemd-shutdown).", { pid: 389 }),
  line("2026-09-27T03:10:05Z", "systemd-journald", "Journal stopped", { pid: 389 }),
]);

// The owner's server on 2026-09-29: an ordinary afternoon, and then nothing.
const powerCutTail = journal([
  line("2026-09-29T18:39:58Z", "systemd", "Started session-41.scope - Session 41 of User alex."),
  line("2026-09-29T18:40:12Z", "tailscaled", "magicsock: disco: node [AbCdE] d:0123456789abcdef now using 192.0.2.30:41641", { pid: 1010 }),
  line("2026-09-29T18:40:31Z", "pihole-FTL", "Resizing \"FTL-queries\" from 4194304 to 8388608", { pid: 2020 }),
  line("2026-09-29T18:41:02Z", "CRON", "(root) CMD (command -v debian-sa1 > /dev/null && debian-sa1 1 1)", { pid: 3030 }),
]);
// What the boot after it said about it, in its first minutes.
const powerCutSigns = journal([
  line("2026-09-29T22:18:01Z", null, "x86/amd: Previous system reset reason [0x00200800]: ACPI power state transition occurred", { kernel: true, boot: currentBoot }),
  line("2026-09-29T22:18:04Z", null, "EXT4-fs (dm-0): orphan cleanup on readonly fs", { kernel: true, boot: currentBoot }),
  line("2026-09-29T22:18:05Z", "systemd-journald", "File /var/log/journal/0123456789abcdef0123456789abcdef/system.journal corrupted or uncleanly shut down, renaming and replacing.", { pid: 412, boot: currentBoot }),
  line("2026-09-29T22:18:07Z", null, "FAT-fs (nvme0n1p1): Volume was not properly unmounted. Some data may be corrupt. Please run fsck.", { kernel: true, boot: currentBoot }),
]);
const boots = [
  { index: -2, bootId: "00112233445566778899aabbccddeeff", firstAt: "2026-09-20T09:00:00.000Z", lastAt: "2026-09-27T03:10:05.000Z" },
  { index: -1, bootId: previousBoot, firstAt: "2026-09-27T03:10:40.000Z", lastAt: "2026-09-29T18:41:02.000Z" },
  { index: 0, bootId: currentBoot, firstAt: "2026-09-29T22:18:00.000Z", lastAt: "2026-09-29T22:40:00.000Z" },
];

describe("reading the journal", () => {
  it("reads -o json lines, including a message that is not UTF-8", () => {
    const [entry, bytes] = parseJournalJson(`${line("2026-09-29T18:41:02Z", "CRON", "hello", { pid: 30 })}\n${JSON.stringify({ __REALTIME_TIMESTAMP: "1790000000000000", SYSLOG_IDENTIFIER: "odd", MESSAGE: [104, 105] })}\nnot json\n`);
    expect(entry).toEqual({ at: "2026-09-29T18:41:02.000Z", identifier: "CRON", pid: 30, kernel: false, bootId: previousBoot, message: "hello" });
    expect(bytes.message).toBe("hi");
  });

  it("reads --list-boots as JSON, and as the table older systemd prints", () => {
    const json = JSON.stringify([{ index: -1, boot_id: previousBoot, first_entry: 1790000000000000, last_entry: 1790003600000000 }, { index: 0, boot_id: currentBoot, first_entry: 1790010000000000, last_entry: 1790010600000000 }]);
    expect(parseListBoots(json)).toEqual([
      { index: -1, bootId: previousBoot, firstAt: new Date(1790000000000).toISOString(), lastAt: new Date(1790003600000).toISOString() },
      { index: 0, bootId: currentBoot, firstAt: new Date(1790010000000).toISOString(), lastAt: new Date(1790010600000).toISOString() },
    ]);
    const table = `IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n -1 ${previousBoot} Sun 2026-09-27 03:10:40 UTC Tue 2026-09-29 18:41:02 UTC\n  0 ${currentBoot} Tue 2026-09-29 22:18:00 UTC Tue 2026-09-29 22:40:00 UTC\n`;
    expect(parseListBoots(table)).toEqual([boots[1], boots[2]]);
    // systemd 249 joins the two times with an em dash.
    expect(parseListBoots(`-1 ${previousBoot} Sun 2026-09-27 03:10:40 UTC—Tue 2026-09-29 18:41:02 UTC`)[0].lastAt).toBe("2026-09-29T18:41:02.000Z");
  });
});

describe("how the previous boot ended", () => {
  it("calls a normal reboot clean, and so a healthy server says nothing", () => {
    const judged = judgePreviousBoot({ boots, tail: parseJournalJson(cleanReboot), signs: [], bootedAt: "2026-09-27T03:10:40Z" });
    expect(judged).toMatchObject({ state: "clean", marker: "systemd: Reached target shutdown.target - System Shutdown." });
  });

  it("calls a shutdown clean whatever part of it the journal kept", () => {
    const tail = parseJournalJson(cleanReboot);
    // journald killed before it could say "Journal stopped", or before PID 1 handed over, or all
    // but the very end lost: any part of the shutdown is enough.
    expect(shutdownMarkerIn(tail.slice(0, -2))).toBe("systemd: Reached target shutdown.target - System Shutdown.");
    expect(shutdownMarkerIn(tail.slice(0, 8))).toBe("systemd: Reached target shutdown.target - System Shutdown.");
    expect(shutdownMarkerIn(tail.slice(11, 12))).toBe("systemd: Shutting down.");
    expect(shutdownMarkerIn(tail.slice(12, 13))).toBe("systemd-shutdown ran");
    expect(shutdownMarkerIn(tail.slice(-2))).toBe("journald was stopped by systemd-shutdown");
    expect(shutdownMarkerIn(tail.slice(-1))).toBe("journald: Journal stopped");
    expect(shutdownMarkerIn(tail.slice(0, 4))).toBeNull();
    // A shutdown asked for through logind that hung before the targets: still on purpose. One only
    // scheduled is not: it may have been cancelled, and the power cut came after.
    expect(shutdownMarkerIn(parseJournalJson(line("2026-09-27T03:10:00Z", "systemd-logind", "System is rebooting.", { pid: 700 })))).toBe("systemd-logind: System is rebooting.");
    expect(shutdownMarkerIn(parseJournalJson(line("2026-09-27T03:10:00Z", "systemd-logind", "The system will reboot now!", { pid: 700 })))).toBe("systemd-logind: The system will reboot now!");
    expect(shutdownMarkerIn(parseJournalJson(line("2026-09-27T03:10:00Z", "systemd-logind", "The system will reboot at Sun 2026-09-27 04:00:00 UTC!", { pid: 700 })))).toBeNull();
    // Even with this boot saying the journal was not closed cleanly (journald killed at the end).
    expect(judgePreviousBoot({ boots, tail, signs: parseJournalJson(powerCutSigns) }).state).toBe("clean");
  });

  it("finds the owner's power cut: no shutdown, and the next boot finding everything left open", () => {
    const judged = judgePreviousBoot({ boots, tail: parseJournalJson(powerCutTail), signs: parseJournalJson(powerCutSigns), bootedAt: "2026-09-29T22:18:00.000Z" });
    expect(judged).toMatchObject({
      state: "unclean", cause: "power", previousBootId: previousBoot,
      stoppedAt: "2026-09-29T18:41:02.000Z", backAt: "2026-09-29T22:18:00.000Z", offForMs: (3 * 60 + 36) * 60_000 + 58_000,
      resetReason: { code: "0x00200800", text: "ACPI power state transition occurred" },
    });
    expect(judged.evidence).toEqual([
      "the journal of the boot before stops at 2026-09-29T18:41:02.000Z, with no shutdown in it",
      "its last entry: CRON: (root) CMD (command -v debian-sa1 > /dev/null && debian-sa1 1 1)",
      "kernel: EXT4-fs (dm-0): orphan cleanup on readonly fs",
      "systemd-journald: File /var/log/journal/0123456789abcdef0123456789abcdef/system.journal corrupted or uncleanly shut down, renaming and replacing.",
      "kernel: FAT-fs (nvme0n1p1): Volume was not properly unmounted. Some data may be corrupt. Please run fsck.",
      "the processor's reset reason: ACPI power state transition occurred (0x00200800)",
    ]);
  });

  it("names journald as the one speaking when its early lines come through the kernel's log", () => {
    // As the KVM guest in tests/ubuntu/power-loss-vm.sh logged it after its power cut.
    const early = JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.parse("2026-09-29T22:18:05Z") * 1000), _BOOT_ID: currentBoot, _TRANSPORT: "kernel", SYSLOG_IDENTIFIER: "systemd-journald", MESSAGE: "File /var/log/journal/0123/system.journal corrupted or uncleanly shut down, renaming and replacing." });
    const judged = judgePreviousBoot({ boots, tail: parseJournalJson(powerCutTail), signs: parseJournalJson(early), bootedAt: "2026-09-29T22:18:00.000Z" });
    expect(judged.evidence).toContain("systemd-journald: File /var/log/journal/0123/system.journal corrupted or uncleanly shut down, renaming and replacing.");
  });

  it("says nothing on a tail without a shutdown unless the next boot says it was not closed", () => {
    expect(judgePreviousBoot({ boots, tail: parseJournalJson(powerCutTail), signs: [] }).state).toBe("unknown");
    // The reset reason alone is no sign: a normal power-off reads the same.
    expect(judgePreviousBoot({ boots, tail: parseJournalJson(powerCutTail), signs: parseJournalJson(powerCutSigns).slice(0, 1) }).state).toBe("unknown");
    expect(judgePreviousBoot({ boots: [boots[2]], tail: [], signs: [] })).toEqual({ state: "none" });
  });

  it("is not fooled by journald restarting mid-boot, or a user's own systemd reaching its shutdown", () => {
    const restarted = journal([
      line("2026-09-29T15:00:00Z", "systemd-journald", "Received SIGTERM from PID 1 (systemd).", { pid: 389 }),
      line("2026-09-29T15:00:00Z", "systemd-journald", "Journal stopped", { pid: 389 }),
      line("2026-09-29T15:00:01Z", "systemd-journald", "Journal started", { pid: 5000 }),
      // An SSH user logging out: their manager (not PID 1) reaches its own shutdown target.
      line("2026-09-29T18:30:00Z", "systemd", "Reached target shutdown.target - Shutdown.", { pid: 4100 }),
      line("2026-09-29T18:41:02Z", "CRON", "(root) CMD (true)", { pid: 3030 }),
    ]);
    expect(judgePreviousBoot({ boots, tail: parseJournalJson(restarted), signs: parseJournalJson(powerCutSigns) }).state).toBe("unclean");
  });

  it("names an overheat or a held power button from the reset reason", () => {
    const reason = (text) => parseJournalJson(`${powerCutSigns}\n${line("2026-09-29T22:18:01Z", null, `x86/amd: Previous system reset reason [0x00000001]: ${text}`, { kernel: true, boot: currentBoot })}`).filter((entry) => !/0x00200800/.test(entry.message));
    expect(judgePreviousBoot({ boots, tail: parseJournalJson(powerCutTail), signs: reason("thermal pin BP_THERMTRIP_L was tripped") }).cause).toBe("overheated");
    expect(judgePreviousBoot({ boots, tail: parseJournalJson(powerCutTail), signs: reason("power button was pressed for 4 seconds") }).cause).toBe("power-button");
  });
});

describe("inspectBoots", () => {
  const listJson = JSON.stringify(boots.map((boot) => ({ index: boot.index, boot_id: boot.bootId, first_entry: Date.parse(boot.firstAt) * 1000, last_entry: Date.parse(boot.lastAt) * 1000 })));
  const fake = (tail) => vi.fn(async (_binary, args) => {
    if (args[0] === "--list-boots") return { ok: true, code: 0, stdout: listJson, stderr: "" };
    if (args[0] === "--boot=-1") return { ok: true, code: 0, stdout: tail, stderr: "" };
    if (args[0] === "--boot=0") return { ok: true, code: 0, stdout: powerCutSigns, stderr: "" };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const now = () => new Date("2026-09-29T22:40:00Z");

  it("reads only the list and the old boot's tail when that boot shut down", async () => {
    const run = fake(cleanReboot);
    const read = await inspectBoots({ run, now, uptimeSeconds: 22 * 60 });
    expect(read).toMatchObject({ available: true, bootedAt: "2026-09-29T22:18:00.000Z", judgement: { state: "clean" }, boots: 3 });
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(["--list-boots", "--boot=-1"]);
    expect(run.mock.calls[1][1]).toEqual(["--boot=-1", "-n", "300", "-o", "json", "--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_COMM,_PID,SYSLOG_PID,_TRANSPORT,_BOOT_ID", "--no-pager"]);
  });

  it("then reads the first twenty minutes of this boot, not all of it", async () => {
    const run = fake(powerCutTail);
    const read = await inspectBoots({ run, now, uptimeSeconds: 22 * 60 });
    expect(read.judgement).toMatchObject({ state: "unclean", stoppedAt: "2026-09-29T18:41:02.000Z", backAt: "2026-09-29T22:18:00.000Z" });
    const grep = run.mock.calls[2][1];
    expect(grep.slice(0, 3)).toEqual(["--boot=0", "--until", `@${Date.parse("2026-09-29T22:38:00Z") / 1000}`]);
    expect(grep).toContain("-g");
  });

  it("falls back to the table on a systemd without JSON, and says none when there is one boot", async () => {
    const run = vi.fn(async (_binary, args) => (args.includes("json") && args[0] === "--list-boots" ? { ok: false, code: 1, stdout: "", stderr: "unknown output" } : { ok: true, code: 0, stdout: ` 0 ${currentBoot} Tue 2026-09-29 22:18:00 UTC Tue 2026-09-29 22:40:00 UTC`, stderr: "" }));
    await expect(inspectBoots({ run, now, uptimeSeconds: 60 })).resolves.toMatchObject({ judgement: { state: "none" }, boots: 1 });
    expect(run.mock.calls[1][1]).toEqual(["--list-boots", "--no-pager"]);
    expect(run.mock.calls[1][2].env).toEqual({ TZ: "UTC" });
  });
});

describe("the words", () => {
  const outage = { id: previousBoot, stoppedAt: "2026-09-29T18:41:02.000Z", backAt: "2026-09-29T22:18:00.000Z", offForMs: (3 * 60 + 36) * 60_000 + 58_000, cause: "power", dnsApps: ["Pi-hole"], ups: false };

  it("say it in one sentence, in the owner's time", () => {
    expect(outageTitle(outage, { hostname: "homebox", now: new Date("2026-09-29T22:40:00Z"), timeZone: "America/Chicago" })).toBe("homebox lost power (or froze) at 1:41 PM and was off for 3 h 37 min.");
    // Seen the next day, it says which day.
    expect(outageTitle(outage, { hostname: "homebox", now: new Date("2026-09-30T15:00:00Z"), timeZone: "America/Chicago" })).toBe("homebox lost power (or froze) at 1:41 PM on Tue 29 Sep and was off for 3 h 37 min.");
    expect(outageTitle({ ...outage, cause: "overheated" }, { hostname: "homebox", now: new Date("2026-09-29T22:40:00Z"), timeZone: "UTC" })).toBe("homebox shut itself off because it overheated at 6:41 PM and was off for 3 h 37 min.");
    expect(clockWords("2026-09-29T18:41:02Z", { now: new Date("2026-09-29T19:00:00Z"), timeZone: "UTC" })).toBe("6:41 PM");
  });

  it("round an outage to what a person would say", () => {
    expect(durationWords(30_000)).toBe("less than a minute");
    expect(durationWords(12 * 60_000)).toBe("12 min");
    expect(durationWords(2 * 3_600_000)).toBe("2 h");
    expect(durationWords(50 * 3_600_000)).toBe("2 days 2 h");
  });

  it("say what went down with it, and what would help next time", () => {
    expect(outageMessage(outage, { hostname: "homebox" })).toBe([
      "Pi-hole was down with it, so devices using it had no DNS.",
      "In homebox's BIOS, set \"Restore on AC power loss\" to Power On, so it starts again by itself when the power comes back.",
      "A small UPS would keep it running through short cuts and shut it down cleanly in long ones; BoxPilot watches one plugged in by USB (System, Power).",
      "Consider a second DNS server in your router, so devices can still look names up while homebox is off; they will sometimes skip Pi-hole's blocking.",
    ].join(" "));
    const plain = outageMessage({ ...outage, dnsApps: [], ups: true }, { hostname: "homebox" });
    expect(plain).not.toMatch(/DNS/);
    expect(plain).toContain("It has a UPS, and still went down");
  });
});

/** A settings store and a health ledger, as far as the watch uses them. */
function fakeStore(initial = {}) {
  const settings = { ...initial };
  return {
    settings,
    getSetting: (key, fallback) => settings[key] ?? fallback,
    updateSetting: (key, fallback, update) => { settings[key] = update(settings[key] ?? fallback).value; },
  };
}

describe("createPowerLossWatch", () => {
  const judged = { available: true, judgement: { state: "unclean", previousBootId: previousBoot, stoppedAt: "2026-09-29T18:41:02.000Z", backAt: "2026-09-29T22:18:00.000Z", offForMs: 13_018_000, cause: "power", resetReason: null, evidence: ["the journal of the boot before stops"] } };
  const setup = (answer = judged, now = "2026-09-29T22:40:00Z") => {
    const store = fakeStore();
    const alerts = { raise: vi.fn(async () => ({ notified: false })), clear: vi.fn(async () => ({ cleared: true })) };
    const helper = { request: vi.fn(async () => answer) };
    const watch = createPowerLossWatch({ helper, store, alerts, hostname: "homebox", dnsApps: async () => ["Pi-hole"], ups: async () => false, now: () => new Date(now), timeZone: "America/Chicago" });
    return { store, alerts, helper, watch };
  };

  it("records an outage once, and raises it once in the health ledger", async () => {
    const { store, alerts, helper, watch } = setup();
    await expect(watch.check()).resolves.toMatchObject({ recorded: true });
    expect(helper.request).toHaveBeenCalledWith("system.boots.inspect", {}, { timeoutMs: 120_000 });
    expect(store.settings.powerOutages).toEqual([expect.objectContaining({ id: previousBoot, dnsApps: ["Pi-hole"], ups: false, acknowledged: null, detectedAt: "2026-09-29T22:40:00.000Z" })]);
    expect(alerts.raise).toHaveBeenCalledWith({
      key: `power.lost:${previousBoot.slice(0, 12)}`, priority: "high",
      title: "homebox lost power (or froze) at 1:41 PM and was off for 3 h 37 min.",
      message: expect.stringMatching(/^Pi-hole was down with it, so devices using it had no DNS\. In homebox's BIOS/),
    });
    // BoxPilot restarting later in the same boot finds the same outage: nothing more is said.
    await expect(watch.check()).resolves.toMatchObject({ recorded: false, known: true });
    expect(alerts.raise).toHaveBeenCalledTimes(1);
  });

  it("says nothing after a clean shutdown, a first boot, or an outage weeks old", async () => {
    for (const answer of [{ judgement: { state: "clean" } }, { judgement: { state: "none" } }, { judgement: { state: "unknown", previousBootId: previousBoot } }]) {
      const { store, alerts, watch } = setup(answer);
      await watch.check();
      expect(store.settings.powerOutages).toBeUndefined();
      expect(alerts.raise).not.toHaveBeenCalled();
    }
    const old = setup(judged, "2026-10-20T12:00:00Z");
    await expect(old.watch.check()).resolves.toMatchObject({ recorded: false, old: true });
    expect(old.alerts.raise).not.toHaveBeenCalled();
  });

  it("tries again while the helper is not up yet", async () => {
    const helper = { request: vi.fn(async () => judged) };
    helper.request.mockRejectedValueOnce(new Error("helper unavailable"));
    const timers = [];
    const alerts = { raise: vi.fn(async () => ({})) };
    createPowerLossWatch({ helper, store: fakeStore(), alerts, now: () => new Date("2026-09-29T22:40:00Z"), delay: (fn) => { timers.push(fn); return null; } }).start();
    timers.shift()();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers.shift()();
    await vi.waitFor(() => expect(alerts.raise).toHaveBeenCalledTimes(1));
    expect(helper.request).toHaveBeenCalledTimes(2);
  });

  it("keeps the outage on record when someone says Got it, and takes it out of the ledger", async () => {
    const { store, alerts, watch } = setup();
    await watch.check();
    const acknowledged = await acknowledgeOutage({ store, alerts, id: previousBoot, by: "owner-1", now: () => new Date("2026-09-29T23:00:00Z") });
    expect(acknowledged).toMatchObject({ id: previousBoot, acknowledged: { at: "2026-09-29T23:00:00.000Z", by: "owner-1" } });
    expect(store.settings.powerOutages[0].acknowledged).toEqual({ at: "2026-09-29T23:00:00.000Z", by: "owner-1" });
    expect(alerts.clear).toHaveBeenCalledWith(outageKey(previousBoot), { quietly: true });
    await expect(acknowledgeOutage({ store, alerts, id: "f".repeat(32) })).resolves.toBeNull();
  });
});
