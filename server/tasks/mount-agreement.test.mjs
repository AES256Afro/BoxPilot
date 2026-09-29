import { describe, expect, it, vi } from "vitest";
import { agrees, hostMountsAt, mountedFrom, realMount, startMountUnit, unitState, waitForSystemd } from "./mount-agreement.mjs";
import { laggingSystemd as laggingHost } from "../../test/lagging-systemd.mjs";

const UNIT = "mnt-the\\x2ddump.mount";
const MNT = "/mnt/the-dump";

describe("reading PID 1's mount table and a mount unit's state", () => {
  it("lists PID 1's table instead of looking the path up, and takes the filesystem over an automount", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "/ ext4 8:1 rw /dev/sda1\n/mnt/nas autofs 0:40 rw,fd=5 systemd-1\n/mnt/nas cifs 0:55 rw,vers=3.1.1 //nas/Public\n/mnt/nas-2 cifs 0:56 ro //nas/Other", stderr: "" }));
    const mounts = await hostMountsAt(run, "/mnt/nas");
    expect(run).toHaveBeenCalledWith("/usr/bin/findmnt", ["--task", "1", "-rn", "-o", "TARGET,FSTYPE,MAJ:MIN,OPTIONS,SOURCE"], expect.anything());
    expect(mounts.map((mount) => mount.fstype)).toEqual(["autofs", "cifs"]);
    expect(realMount(mounts)).toEqual({ source: "//nas/Public", fstype: "cifs", majMin: "0:55", options: "rw,vers=3.1.1", readOnly: false });
    expect(realMount([{ fstype: "autofs" }])).toBeNull();
    expect(realMount(null)).toBeNull();
    await expect(hostMountsAt(vi.fn(async () => ({ ok: false, stdout: "", stderr: "no" })), "/mnt/nas")).resolves.toBeNull();
  });

  it("reads the unit's state, and calls it agreed only when it says what the table says", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "ActiveState=active\nSubState=mounted", stderr: "" }));
    await expect(unitState(run, UNIT)).resolves.toEqual({ active: "active", sub: "mounted" });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["show", UNIT, "--property=ActiveState,SubState"], expect.anything());
    await expect(unitState(vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })), UNIT)).resolves.toBeNull();
    expect(agrees({ active: "active" }, true)).toBe(true);
    expect(agrees({ active: "inactive" }, false)).toBe(true);
    expect(agrees({ active: "failed" }, false)).toBe(true);
    // The race itself: the drive is gone and the unit still says it is mounted.
    expect(agrees({ active: "active" }, false)).toBe(false);
    expect(agrees({ active: "inactive" }, true)).toBe(false);
    expect(agrees({ active: "deactivating" }, false)).toBe(false);
    expect(agrees(null, false)).toBe(false);
  });

  it("says a mount is there only from the device expected", async () => {
    const host = laggingHost({ mounted: "/dev/sdb2" });
    await expect(mountedFrom(host.run, MNT, ["/dev/sdb2"])).resolves.toMatchObject({ ok: true, mount: { source: "/dev/sdb2" } });
    await expect(mountedFrom(host.run, MNT, ["/dev/sda2", null])).resolves.toMatchObject({ ok: false, reason: "/mnt/the-dump is mounted from /dev/sdb2, not from /dev/sda2" });
    await expect(mountedFrom(host.run, MNT)).resolves.toMatchObject({ ok: true });
    await expect(mountedFrom(laggingHost().run, MNT, ["/dev/sda2"])).resolves.toMatchObject({ ok: false, mount: null, reason: "nothing is mounted at /mnt/the-dump" });
  });
});

describe("waiting for systemd to see an unmount made outside it", () => {
  it("waits until the unit stops saying mounted, and says how long it took", async () => {
    const host = laggingHost({ mounted: null, unitActive: true, lagMs: 400 });
    const look = await waitForSystemd(host.run, UNIT, MNT, host);
    expect(look).toMatchObject({ agreed: true, mount: null, state: { active: "inactive" } });
    expect(look.waitedMs).toBeGreaterThanOrEqual(400);
    expect(host.log).toHaveBeenCalledWith(`systemd took ${look.waitedMs} ms to see /mnt/the-dump unmounted`, "stdout");
    // Short sleeps first: the lag seen on real systemd was 115-444 ms.
    expect(host.sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100, 200, 250]);
  });

  it("does not wait, or say anything, when they already agree", async () => {
    const host = laggingHost({ mounted: "/dev/sda2" });
    await expect(waitForSystemd(host.run, UNIT, MNT, host)).resolves.toMatchObject({ agreed: true, waitedMs: 0 });
    expect(host.sleep).not.toHaveBeenCalled();
    expect(host.log).not.toHaveBeenCalled();
    // The look itself takes time on a real host (7 ms on the 22.04 runner); that is not a wait.
    const slow = laggingHost({ mounted: null, unitActive: false });
    const run = async (...args) => { slow.state.now += 7; return slow.run(...args); };
    await expect(waitForSystemd(run, UNIT, MNT, slow)).resolves.toMatchObject({ agreed: true, waitedMs: 0 });
    expect(slow.log).not.toHaveBeenCalled();
  });

  it("gives up at the bound and says so, rather than holding everything up", async () => {
    const host = laggingHost({ mounted: null, unitActive: true, lagMs: 60_000 });
    const look = await waitForSystemd(host.run, UNIT, MNT, { ...host, timeoutMs: 5_000 });
    expect(look.agreed).toBe(false);
    expect(look.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(look.waitedMs).toBeLessThan(5_300);
    expect(host.log).toHaveBeenCalledWith(expect.stringMatching(/^mnt-the\\x2ddump\.mount still says active \d+ ms on, with \/mnt\/the-dump unmounted; going ahead$/), "stderr");
  });

  it("has nothing to wait for when systemd or the table cannot be asked", async () => {
    for (const host of [laggingHost({ systemd: false }), laggingHost({ table: false })]) {
      await expect(waitForSystemd(host.run, UNIT, MNT, host)).resolves.toMatchObject({ agreed: false, known: false, waitedMs: 0 });
      expect(host.sleep).not.toHaveBeenCalled();
    }
  });
});

describe("starting a mount unit and proving it mounted", () => {
  it("shows the hazard: a start while systemd lags exits 0 and mounts nothing", async () => {
    // What resumeAfterCancelledReboot used to do, and then log "Mounted ... again".
    const host = laggingHost({ mounted: null, unitActive: true, lagMs: 400 });
    const started = await host.run("/usr/bin/systemctl", ["start", UNIT]);
    expect(started.ok).toBe(true);
    expect(host.state.mounted).toBeNull();
  });

  it("waits for systemd to see the drive gone, then starts it once, and it mounts", async () => {
    const host = laggingHost({ mounted: null, unitActive: true, lagMs: 400 });
    const result = await startMountUnit(host.run, UNIT, MNT, { ...host, sources: ["/dev/sda2"] });
    expect(result).toMatchObject({ ok: true, started: true, tries: 1, mount: { source: "/dev/sda2" } });
    expect(host.calls.filter((call) => call.startsWith("systemctl start"))).toEqual([`systemctl start ${UNIT}`]);
    // The start came only after systemd said the unit was inactive.
    expect(host.calls.indexOf(`systemctl start ${UNIT}`)).toBeGreaterThan(host.calls.lastIndexOf(`systemctl show ${UNIT} --property=ActiveState,SubState`));
    expect(host.log).toHaveBeenCalledWith(expect.stringMatching(/^systemd took \d+ ms to see \/mnt\/the-dump unmounted$/), "stdout");
  });

  it("makes a start that exited 0 with nothing mounted once more, after systemd has caught up", async () => {
    // Longer than one wait: the first start is made while systemd still lags, and does nothing.
    const host = laggingHost({ mounted: null, unitActive: true, lagMs: 500 });
    const result = await startMountUnit(host.run, UNIT, MNT, { ...host, sources: ["/dev/sda2"], timeoutMs: 300 });
    expect(result).toMatchObject({ ok: true, tries: 2, mount: { source: "/dev/sda2" } });
    expect(host.calls.filter((call) => call.startsWith("systemctl start"))).toHaveLength(2);
    expect(host.log).toHaveBeenCalledWith(`systemctl start ${UNIT} exited 0 with nothing mounted at /mnt/the-dump; waiting for systemd to catch up, then starting it once more`, "stderr");
  });

  it("fails, in a sentence, when systemd says started twice and nothing is mounted", async () => {
    const host = laggingHost({ mounted: null, unitActive: true, lagMs: 60_000 });
    const result = await startMountUnit(host.run, UNIT, MNT, { ...host, sources: ["/dev/sda2"], timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, mount: null, tries: 2, reason: `systemd said ${UNIT} started, twice, but nothing is mounted at /mnt/the-dump` });
  });

  it("does not retry a start that failed, and says why", async () => {
    const host = laggingHost({ mounted: null, unitActive: false, starts: [{ fails: "A dependency job for mnt-the\\x2ddump.mount failed. See 'journalctl -xe' for details." }] });
    const result = await startMountUnit(host.run, UNIT, MNT, { ...host, sources: ["/dev/sda2"] });
    expect(result).toMatchObject({ ok: false, tries: 1, reason: `systemctl start ${UNIT} failed: A dependency job for mnt-the\\x2ddump.mount failed. See 'journalctl -xe' for details.` });
    expect(host.calls.filter((call) => call.startsWith("systemctl start"))).toHaveLength(1);
  });

  it("does not count a mount from another device, and does not retry it", async () => {
    const host = laggingHost({ mounted: null, unitActive: false, starts: [{ mounts: "/dev/sdc1" }] });
    const result = await startMountUnit(host.run, UNIT, MNT, { ...host, sources: ["/dev/sda2"] });
    expect(result).toMatchObject({ ok: false, tries: 1, reason: "/mnt/the-dump is mounted from /dev/sdc1, not from /dev/sda2" });
  });

  it("starts nothing when the drive is mounted already", async () => {
    const host = laggingHost({ mounted: "/dev/sda2" });
    const result = await startMountUnit(host.run, UNIT, MNT, { ...host, sources: ["/dev/sda2"] });
    expect(result).toMatchObject({ ok: true, started: false, tries: 0 });
    expect(host.calls.some((call) => call.startsWith("systemctl start"))).toBe(false);
  });
});
