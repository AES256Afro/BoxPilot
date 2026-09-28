import { describe, expect, it } from "vitest";
import { moveBackupMount, planBackupMountMove, relocateEntry, undoBackupMountMove } from "./backup-mount-move.mjs";

/**
 * The move runs against real systemd in tests/ubuntu/helper-automount.sh. Here a small host stands
 * in for it: fstab, the mount table, and systemctl starting and stopping the units fstab defines,
 * so each step of the move and each way back can be checked on its own.
 */
const share = "//nas.local/backups /mnt/boxpilot-backup cifs credentials=/etc/boxpilot/secrets/share-boxpilot-backup.cred,uid=1000,gid=1000,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=300,x-systemd.mount-timeout=30 0 0";
const drive = "UUID=0000-1111 /mnt/boxpilot-backup ext4 defaults,nofail 0 2";
const fstabWith = (line, marker = "share-boxpilot-backup") => `UUID=aaaa / ext4 defaults 0 1\n# boxpilot:media\nUUID=bbbb /mnt/media ext4 defaults,nofail 0 2\n${marker ? `# boxpilot:${marker}\n` : ""}${line}\n`;
const now = () => new Date("2026-09-28T12:00:00.000Z");
const copy = "/etc/fstab.boxpilot-20260928T120000Z";

function fakeHost({ fstab, mounts = [], busy = false, verify = () => true, inside = [] }) {
  const state = { files: new Map([["/etc/fstab", fstab]]), mounts: [...mounts], calls: [], made: [], removed: [] };
  const escape = (target) => target.slice(1).replaceAll("-", "\\x2d").replaceAll("/", "-");
  const targetOf = (unit) => `/${unit.replace(/\.(auto)?mount$/, "").replaceAll("-", "/").replaceAll("\\x2d", "-")}`;
  const entryAt = (target) => state.files.get("/etc/fstab").split("\n").map((line) => line.trim().split(/\s+/)).find((fields) => !fields[0]?.startsWith("#") && fields[1] === target);
  const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
  const run = async (binary, args) => {
    const name = binary.split("/").pop();
    state.calls.push([name, ...args].join(" "));
    if (name === "systemd-escape") return ok(escape(args.at(-1)));
    if (name === "findmnt" && args[0] === "--verify") return verify(state.files.get("/etc/fstab")) ? ok() : { ok: false, code: 1, stdout: "", stderr: "parse error at line 5" };
    if (name === "findmnt") return ok(state.mounts.map((mount) => `${mount.target} ${mount.fstype}`).join("\n"));
    const [verb, ...units] = args.filter((arg) => arg !== "--no-block");
    for (const unit of units) {
      const target = targetOf(unit);
      const entry = entryAt(target);
      if (verb === "stop" && unit.endsWith(".mount")) {
        if (busy && state.mounts.some((mount) => mount.target === target && mount.fstype !== "autofs")) return { ok: false, code: 1, stdout: "", stderr: `umount: ${target}: target is busy.` };
        state.mounts = state.mounts.filter((mount) => mount.target !== target || mount.fstype === "autofs");
      }
      if (verb === "stop" && unit.endsWith(".automount")) state.mounts = state.mounts.filter((mount) => mount.target !== target);
      if (verb === "start" && unit.endsWith(".automount")) {
        if (!entry?.[3]?.includes("x-systemd.automount")) return { ok: false, code: 5, stdout: "", stderr: `Unit ${unit} not found.` };
        state.mounts.push({ target, fstype: "autofs" });
      }
      if (verb === "start" && unit.endsWith(".mount")) {
        if (!entry) return { ok: false, code: 5, stdout: "", stderr: `Unit ${unit} not found.` };
        state.mounts.push({ target, fstype: entry[2] });
      }
    }
    return ok();
  };
  const files = {
    readFile: async (file) => { if (!state.files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" }); return state.files.get(file); },
    writeFile: async (file, content) => { state.files.set(file, content); },
    mkdir: async (directory) => { state.made.push(directory); },
    readdir: async () => inside,
    rmdir: async (directory) => { state.removed.push(directory); },
  };
  return { state, run, files };
}

describe("planning the move", () => {
  it("changes the mount point of that one entry and not a byte more", () => {
    const plan = planBackupMountMove(fstabWith(share));
    expect(plan).toMatchObject({ action: "move", automount: true, managedName: "share-boxpilot-backup", fstype: "cifs" });
    expect(plan.content).toBe(fstabWith(share.replace(" /mnt/boxpilot-backup ", " /mnt/boxpilot/backup ")));
    expect(relocateEntry("  a\t/b  c", 0, "/d")).toBe("  a\t/d  c");
    expect(planBackupMountMove(fstabWith(drive, "boxpilot-backup"))).toMatchObject({ action: "move", automount: false, managedName: "boxpilot-backup" });
    expect(planBackupMountMove(fstabWith(share, null))).toMatchObject({ action: "move", managedName: null });   // a line the owner wrote
  });

  it("does nothing when there is nothing to move, and refuses what it cannot move cleanly", () => {
    expect(planBackupMountMove("UUID=aaaa / ext4 defaults 0 1\n")).toMatchObject({ action: "none" });
    expect(planBackupMountMove(fstabWith(share.replace("/mnt/boxpilot-backup", "/mnt/boxpilot/backup")))).toMatchObject({ action: "none", reason: expect.stringContaining("already") });
    expect(planBackupMountMove(`${fstabWith(share)}${drive}\n`)).toMatchObject({ action: "refuse", reason: expect.stringContaining("2 entries") });
    expect(planBackupMountMove(`${fstabWith(share)}UUID=cccc /mnt/boxpilot ext4 defaults 0 2\n`)).toMatchObject({ action: "refuse", reason: expect.stringContaining("/mnt/boxpilot") });
    expect(planBackupMountMove(`# //nas/old /mnt/boxpilot-backup cifs guest 0 0\n`)).toMatchObject({ action: "none" });   // a comment is not an entry
  });
});

describe("moving the backup destination", () => {
  it("moves a NAS share's automount, idle or mounted, and keeps the fstab it replaced", async () => {
    const host = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }, { target: "/mnt/boxpilot-backup", fstype: "cifs" }] });
    const result = await moveBackupMount({}, { run: host.run, files: host.files, now });
    expect(result).toMatchObject({ moved: true, to: "/mnt/boxpilot/backup", automount: true, managedName: "share-boxpilot-backup", fstabCopy: copy });
    expect(host.state.files.get(copy)).toBe(fstabWith(share));
    expect(host.state.files.get("/etc/fstab")).toContain(" /mnt/boxpilot/backup cifs credentials=/etc/boxpilot/secrets/share-boxpilot-backup.cred,");
    expect(host.state.mounts).toEqual([{ target: "/mnt/boxpilot/backup", fstype: "autofs" }]);
    expect(host.state.made).toEqual(expect.arrayContaining(["/mnt/boxpilot", "/mnt/boxpilot/backup"]));
    expect(host.state.removed).toEqual(["/mnt/boxpilot-backup"]);
    // The old mount is released before fstab changes, while its units still exist.
    const order = (text) => host.state.calls.findIndex((call) => call.includes(text));
    expect(order("stop mnt-boxpilot\\x2dbackup.mount")).toBeLessThan(order("stop mnt-boxpilot\\x2dbackup.automount"));
    expect(order("stop mnt-boxpilot\\x2dbackup.automount")).toBeLessThan(order("daemon-reload"));
    expect(order("daemon-reload")).toBeLessThan(order("start mnt-boxpilot-backup.automount"));
  });

  it("moves a drive and mounts it again at the new place when it was mounted", async () => {
    const host = fakeHost({ fstab: fstabWith(drive, "boxpilot-backup"), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "ext4" }] });
    await expect(moveBackupMount({}, { run: host.run, files: host.files, now })).resolves.toMatchObject({ moved: true, automount: false, remounted: true });
    expect(host.state.mounts).toEqual([{ target: "/mnt/boxpilot/backup", fstype: "ext4" }]);
  });

  it("leaves a destination that is in use exactly where it is, fstab untouched", async () => {
    const host = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }, { target: "/mnt/boxpilot-backup", fstype: "cifs" }], busy: true });
    await expect(moveBackupMount({}, { run: host.run, files: host.files, now })).rejects.toThrow(/in use, so it was left where it is/);
    expect(host.state.files.get("/etc/fstab")).toBe(fstabWith(share));
    expect(host.state.files.has(copy)).toBe(false);
    expect(host.state.mounts.map((mount) => mount.target)).toEqual(["/mnt/boxpilot-backup", "/mnt/boxpilot-backup"]);
  });

  it("puts fstab and the old automount back when the new one does not check out", async () => {
    const host = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }], verify: (content) => !content.includes("/mnt/boxpilot/backup") });
    await expect(moveBackupMount({}, { run: host.run, files: host.files, now })).rejects.toThrow(/fstab was restored from \/etc\/fstab\.boxpilot-20260928T120000Z/);
    expect(host.state.files.get("/etc/fstab")).toBe(fstabWith(share));
    expect(host.state.mounts).toEqual([{ target: "/mnt/boxpilot-backup", fstype: "autofs" }]);
  });

  it("does not blame the move for a warning fstab already had", async () => {
    const host = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }], verify: () => false });
    await expect(moveBackupMount({}, { run: host.run, files: host.files, now })).resolves.toMatchObject({ moved: true });
  });

  it("will not hide files already in the new folder, and does nothing when there is nothing to move", async () => {
    const crowded = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }], inside: ["restic-vm"] });
    await expect(moveBackupMount({}, { run: crowded.run, files: crowded.files, now })).rejects.toThrow(/already has files in it \(restic-vm\)/);
    expect(crowded.state.files.get("/etc/fstab")).toBe(fstabWith(share));
    const empty = fakeHost({ fstab: "UUID=aaaa / ext4 defaults 0 1\n" });
    await expect(moveBackupMount({}, { run: empty.run, files: empty.files, now })).resolves.toMatchObject({ moved: false });
    expect(empty.state.made).toEqual(["/mnt/boxpilot"]);   // the folder the helper is given exists either way
    expect(empty.state.calls).toEqual([]);
  });
});

describe("putting a move back for a rolled-back upgrade", () => {
  it("restores the fstab the move saved and the old automount", async () => {
    const host = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }] });
    await moveBackupMount({}, { run: host.run, files: host.files, now });
    await expect(undoBackupMountMove({ fstabCopy: copy }, { run: host.run, files: host.files })).resolves.toMatchObject({ restored: true });
    expect(host.state.files.get("/etc/fstab")).toBe(fstabWith(share));
    expect(host.state.mounts).toEqual([{ target: "/mnt/boxpilot-backup", fstype: "autofs" }]);
  });

  it("leaves fstab alone if it changed after the move, and takes only its own copies", async () => {
    const host = fakeHost({ fstab: fstabWith(share), mounts: [{ target: "/mnt/boxpilot-backup", fstype: "autofs" }] });
    await moveBackupMount({}, { run: host.run, files: host.files, now });
    const edited = `${host.state.files.get("/etc/fstab")}UUID=dddd /mnt/new ext4 defaults,nofail 0 2\n`;
    host.state.files.set("/etc/fstab", edited);
    await expect(undoBackupMountMove({ fstabCopy: copy }, { run: host.run, files: host.files })).rejects.toThrow(/changed after the move/);
    expect(host.state.files.get("/etc/fstab")).toBe(edited);
    await expect(undoBackupMountMove({ fstabCopy: "/etc/passwd" }, { run: host.run, files: host.files })).rejects.toThrow(/fstab\.boxpilot-<stamp>/);
  });
});
