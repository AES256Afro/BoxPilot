import { describe, expect, it, vi } from "vitest";
import { storageWritable, withOwnerOptions } from "./drive-writable.mjs";

/**
 * "Let apps write to the drive" (M35): Repair's old "Remount it" for an exFAT drive mounted without
 * an owner mounted the same fstab line again and changed nothing. This changes the line.
 */
const BASE = "# /etc/fstab\nUUID=root-uuid / ext4 defaults 0 1\n";
const line = (options, fstype = "exfat") => `# boxpilot:the-dump\nUUID=0023-7927 /mnt/the-dump ${fstype} ${options} 0 0\n`;

function rig({ options = "defaults,nofail,x-systemd.before=docker.service", fstype = "exfat", refuseNewEntry = false, verifyRejects = false } = {}) {
  const calls = [];
  const state = { fstab: `${BASE}${line(options, fstype)}`, candidate: null, backups: {}, mounted: "/dev/sdb2", owner: 0 };
  const files = {
    readFile: vi.fn(async (file) => (file === "/etc/fstab" ? state.fstab : "")),
    writeFile: vi.fn(async (file, content, options_ = {}) => {
      if (file === "/etc/fstab.boxpilot-new") state.candidate = content;
      else if (file.startsWith("/etc/fstab.boxpilot-")) { if (options_.flag === "wx" && state.backups[file]) throw new Error("EEXIST"); state.backups[file] = content; }
      else if (file === "/etc/fstab") state.fstab = content;
    }),
    rename: vi.fn(async (from, to) => { if (from === "/etc/fstab.boxpilot-new" && to === "/etc/fstab") { state.fstab = state.candidate; state.candidate = null; calls.push("rename fstab"); } }),
    unlink: vi.fn(async () => { state.candidate = null; }),
    readable: async () => true,
    stat: async () => ({ uid: state.owner, gid: state.owner }),
  };
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").pop(); calls.push(`${name} ${args.join(" ")}`);
    if (name === "findmnt" && args[0] === "--verify") {
      const candidate = args.at(-1) === "/etc/fstab.boxpilot-new";
      return verifyRejects && candidate ? { ok: false, stdout: "", stderr: "/etc/fstab.boxpilot-new: parse error at line 3\n1 parse error, 0 errors, 0 warnings" } : { ok: true, stdout: "0 parse errors, 0 errors, 0 warnings", stderr: "" };
    }
    if (name === "findmnt") return state.mounted ? { ok: true, stdout: `${state.mounted} ${fstype} 8:18 rw,relatime\n`, stderr: "" } : { ok: false, stdout: "", stderr: "" };
    if (name === "blkid") return { ok: true, stdout: "/dev/sdb2\n", stderr: "" };
    if (name === "docker" && args[0] === "ps") return { ok: true, stdout: "aaa\n", stderr: "" };
    if (name === "docker" && args[0] === "inspect") return { ok: true, stdout: "/bp-plex\t/mnt/the-dump\t\n", stderr: "" };
    if (name === "umount") { state.mounted = null; return { ok: true, stdout: "", stderr: "" }; }
    if (name === "mount") {
      const owned = /uid=1000/.test(state.fstab);
      if (owned && refuseNewEntry) return { ok: false, stdout: "", stderr: "mount: /mnt/the-dump: wrong fs type, bad option." };
      state.mounted = "/dev/sdb2"; state.owner = owned ? 1000 : 0; return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  return { run, files, calls, state, now: () => new Date("2026-09-29T12:00:00.000Z") };
}

describe("letting apps write to a drive that keeps no owners (M35)", () => {
  it("adds uid and gid to the drive's entry, with the drive unmounted, reconnects it, and proves the new owner", async () => {
    const fakes = rig();
    const result = await storageWritable({ name: "the-dump" }, { run: fakes.run, files: fakes.files, now: fakes.now, sleep: async () => {} });
    expect(result).toMatchObject({ writable: true, mountpoint: "/mnt/the-dump", owner: "1000:1000", options: "defaults,nofail,x-systemd.before=docker.service,uid=1000,gid=1000", restarted: ["bp-plex"] });
    expect(fakes.state.fstab).toBe(`${BASE}${line("defaults,nofail,x-systemd.before=docker.service,uid=1000,gid=1000")}`);
    // Copied beside itself first, and only then replaced, by a rename, after the drive let go.
    expect(fakes.state.backups["/etc/fstab.boxpilot-20260929T120000Z"]).toBe(`${BASE}${line("defaults,nofail,x-systemd.before=docker.service")}`);
    const { calls } = fakes;
    expect(calls.indexOf("docker stop bp-plex")).toBeLessThan(calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump")).toBeLessThan(calls.indexOf("rename fstab"));
    expect(calls.indexOf("rename fstab")).toBeLessThan(calls.indexOf("mount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(calls).toContain("systemctl daemon-reload");
    expect(result.rewritten).toMatchObject({ changed: true, previousOptions: "defaults,nofail,x-systemd.before=docker.service" });
  });

  it("keeps every other option in its order and replaces an owner that was there", () => {
    expect(withOwnerOptions("rw,uid=0,nofail,gid=0,x-systemd.device-timeout=30s")).toBe("rw,nofail,x-systemd.device-timeout=30s,uid=1000,gid=1000");
    expect(withOwnerOptions("defaults", 1001, 1002)).toBe("defaults,uid=1001,gid=1002");
  });

  it("puts the old entry back and mounts the drive as it was when mount refuses the new one", async () => {
    const fakes = rig({ refuseNewEntry: true });
    await expect(storageWritable({ name: "the-dump" }, { run: fakes.run, files: fakes.files, now: fakes.now, sleep: async () => {} }))
      .rejects.toThrow(/mount refused the changed entry .*, so the old entry was put back and \/mnt\/the-dump mounted as it was, with bp-plex started again/);
    expect(fakes.state.fstab).toBe(`${BASE}${line("defaults,nofail,x-systemd.before=docker.service")}`);
    expect(fakes.state.mounted).toBe("/dev/sdb2");
    expect(fakes.calls).toContain("docker start bp-plex");
  });

  it("changes nothing in fstab when findmnt --verify rejects the new entry, and mounts the drive back", async () => {
    const fakes = rig({ verifyRejects: true });
    await expect(storageWritable({ name: "the-dump" }, { run: fakes.run, files: fakes.files, now: fakes.now, sleep: async () => {} })).rejects.toThrow("findmnt --verify rejected the new entry, so fstab was left as it was");
    expect(fakes.state.fstab).toBe(`${BASE}${line("defaults,nofail,x-systemd.before=docker.service")}`);
    expect(fakes.state.mounted).toBe("/dev/sdb2");
    expect(fakes.calls).toContain("docker start bp-plex");
  });

  it("refuses a Linux filesystem, which keeps owners on the drive itself, and a read-only entry, before stopping anything", async () => {
    const ext = rig({ fstype: "ext4" });
    await expect(storageWritable({ name: "the-dump" }, { run: ext.run, files: ext.files })).rejects.toThrow("is ext4, which keeps the owner of each file on the drive itself");
    const readOnly = rig({ options: "ro,nofail" });
    await expect(storageWritable({ name: "the-dump" }, { run: readOnly.run, files: readOnly.files })).rejects.toThrow("mounted read-only on purpose");
    for (const fakes of [ext, readOnly]) expect(fakes.calls.some((call) => call.startsWith("docker stop") || call.startsWith("umount"))).toBe(false);
  });

  it("refuses a share or the swap file by its marker name", async () => {
    const fakes = rig();
    await expect(storageWritable({ name: "share-nas" }, { run: fakes.run, files: fakes.files })).rejects.toThrow("network share");
    await expect(storageWritable({ name: "swap" }, { run: fakes.run, files: fakes.files })).rejects.toThrow("swap file");
  });
});
