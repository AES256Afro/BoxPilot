import { describe, expect, it, vi } from "vitest";
import { buildShareEntry, credentialsPath, explainMountError, shareMount, shareReconnect, shareUnmount, validateShare } from "./shares.mjs";

const BASE_FSTAB = "# /etc/fstab\nUUID=root-uuid / ext4 defaults 0 1\n";
const MANAGED_FSTAB = `${BASE_FSTAB}# boxpilot:share-nas-media\n//mycloud/Public /mnt/nas-media cifs credentials=/etc/boxpilot/secrets/share-nas-media.cred,nofail,x-systemd.automount 0 0\n`;
const now = () => new Date("2026-09-28T12:00:00Z");

function fakeFiles(fstab = BASE_FSTAB, { smbConf = "" } = {}) {
  const state = { fstab, written: {}, unlinked: [], made: [], removedDirs: [] };
  return {
    state,
    readFile: vi.fn(async (path) => { if (path === "/etc/fstab") return state.fstab; if (path === "/etc/samba/smb.conf" && smbConf) return smbConf; throw new Error("ENOENT"); }),
    writeFile: vi.fn(async (path, content, options) => { if (path === "/etc/fstab") state.fstab = content; else state.written[path] = { content, options }; }),
    // Node's mkdir with recursive returns the first path it created, or undefined when the
    // directory already existed. The rollback depends on telling those apart.
    mkdir: vi.fn(async (path) => { state.made.push(path); return path; }),
    rmdir: vi.fn(async (path) => { state.removedDirs.push(path); }),
    unlink: vi.fn(async (path) => { state.unlinked.push(path); if (!state.written[path]) throw new Error("ENOENT"); delete state.written[path]; }),
  };
}

// systemd-escape -p, and back, for the paths these tests use.
const escape = (path) => path.slice(1).replaceAll("-", "\\x2d").replaceAll("/", "-");
const pathOf = (unit) => `/${unit.replace(/\.(auto)?mount$/, "").replaceAll("-", "/").replaceAll("\\x2d", "-")}`;

/**
 * The host as the share tasks see it: PID 1's mount table, which only systemctl changes. `busy`
 * refuses the mount unit's stop until something lets go (Samba's close-share when `samba` is set);
 * `retrigger` has a client mount the share again through the automount between the two stops.
 */
function fakeHost({ mounts = {}, fstype = "cifs", mountFails = null, startsButNothing = false, noopStarts = 0, busy = false, samba = false, retrigger = false, containers = [], binds = {}, journal = "", readOnly = false } = {}) {
  const state = { mounts: structuredClone(mounts), busy, journal, retriggered: false, noopStarts };
  const calls = [];
  const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
  const at = (target) => (state.mounts[target] ??= []);
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").at(-1);
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "findmnt" && args[0] === "--verify") return ok();
    if (name === "findmnt" && args.includes("FSTYPE,FS-OPTIONS")) return ok(at(args.at(-1)).map((type) => (type === "autofs" ? "autofs rw" : `${type} ${readOnly ? "ro" : "rw"},vers=3.1.1`)).join("\n"));
    if (name === "findmnt" && args.includes("--mountpoint")) return ok(at(args.at(-1)).map((type) => (type === "autofs" ? "autofs 0 0" : `${type} 1000 500`)).join("\n"));
    if (name === "findmnt") {
      const rows = Object.entries(state.mounts).flatMap(([target, types]) => types.map((type) => `${target} ${type} ${type === "autofs" ? "0:40" : "0:55"}`));
      return ok(["/ ext4 8:2", ...rows].join("\n"));
    }
    if (name === "systemd-escape") return ok(escape(args.at(-1)));
    if (name === "journalctl") return ok(args[0] === "--sync" ? "" : state.journal);
    if (name === "docker" && args[0] === "ps") return ok(containers.length ? "c0ffee" : "");
    if (name === "docker" && args[0] === "inspect") return ok(containers.map((container) => `/${container}\t${binds[container] ?? "/mnt/nas-media/films"}\t`).join("\n"));
    if (name === "smbstatus") return ok(JSON.stringify({ tcons: { 1: { service: "Everything", machine: "192.168.1.40" } } }));
    if (name === "smbcontrol") { if (samba) state.busy = false; return ok(); }
    if (name !== "systemctl") return ok();
    const [verb, ...units] = args;
    if (verb === "start" && units[0].endsWith(".automount")) { if (!at(pathOf(units[0])).includes("autofs")) at(pathOf(units[0])).push("autofs"); return ok(); }
    if (verb === "start") {
      if (mountFails) { state.journal = mountFails; return { ok: false, code: 1, stdout: "", stderr: `Job for ${units[0]} failed because the control process exited with error code.` }; }
      // A start systemd took as done already: exit 0, nothing mounted (mount-agreement.mjs).
      if (state.noopStarts > 0) { state.noopStarts -= 1; return ok(); }
      if (!startsButNothing) at(pathOf(units[0])).push(fstype);
      return ok();
    }
    if (verb === "stop" && units.length === 1 && units[0].endsWith(".mount")) {
      if (state.busy) { state.journal = `umount: ${pathOf(units[0])}: target is busy.\n${units[0]}: Mount process exited, code=exited, status=32/n/a`; return { ok: false, code: 1, stdout: "", stderr: `Job for ${units[0]} failed.` }; }
      state.mounts[pathOf(units[0])] = at(pathOf(units[0])).filter((type) => type === "autofs");
      return ok();
    }
    if (verb === "stop" && units.length === 1) {
      state.mounts[pathOf(units[0])] = [];
      if (retrigger && !state.retriggered) { state.retriggered = true; state.mounts[pathOf(units[0])] = [fstype]; }
      return ok();
    }
    if (verb === "stop") for (const unit of units) state.mounts[pathOf(unit)] = [];
    return ok();
  });
  return { run, calls, state };
}
const toolsPresent = async () => true;
const holdingShell = { fs: { readdir: async (dir) => (dir === "/proc" ? ["4242"] : []), stat: async (target) => ({ dev: target.endsWith("/cwd") ? 55 : 2049 }) } };

describe("network share tasks", () => {
  it("validates shares and builds fstab entries that never block boot", () => {
    expect(validateShare({ kind: "smb", host: "mycloud.local", share: "Public", name: "nas-public" })).toBeNull();
    expect(validateShare({ kind: "nfs", host: "192.168.1.20", share: "/volume1/media", name: "media" })).toBeNull();
    expect(validateShare({ kind: "ftp", host: "x", share: "y", name: "z" })).toContain("kind");
    expect(validateShare({ kind: "smb", host: "bad host", share: "Public", name: "n" })).toContain("host");
    expect(validateShare({ kind: "smb", host: "nas", share: "../etc", name: "n" })).toContain("share name");
    expect(validateShare({ kind: "nfs", host: "nas", share: "media", name: "n" })).toContain("absolute path");
    expect(validateShare({ kind: "nfs", host: "nas", share: "/media", name: "n", username: "u" })).toContain("NFS");
    expect(validateShare({ kind: "smb", host: "nas", share: "Public", name: "n", username: "a=b" })).toContain("username");
    // /mnt/boxpilot is the folder the backup destination lives in; nothing is mounted over it.
    expect(validateShare({ kind: "smb", host: "nas", share: "Public", name: "boxpilot" })).toContain("reserved");

    expect(buildShareEntry({ kind: "smb", host: "nas", share: "My Files", name: "nas-files", guest: false }).entry)
      .toBe("//nas/My\\040Files /mnt/nas-files cifs credentials=/etc/boxpilot/secrets/share-nas-files.cred,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=300,x-systemd.mount-timeout=30 0 0");
    expect(buildShareEntry({ kind: "smb", host: "nas", share: "Public", name: "pub", guest: true, readOnly: true }).entry).toContain("cifs guest,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,ro,nofail");
    expect(buildShareEntry({ kind: "nfs", host: "nas", share: "/volume1/media", name: "media" }).entry).toBe("nas:/volume1/media /mnt/media nfs rw,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=300,x-systemd.mount-timeout=30 0 0");
  });

  it("explains mount failures in plain words", () => {
    expect(explainMountError("smb", "mount error(13): Permission denied")).toContain("My Cloud Home");
    expect(explainMountError("smb", "mount error(112): Host is down")).toContain("did not answer");
    // cifs-utils 7.0 (Ubuntu 24.04) on a NAS address where nothing answers.
    expect(explainMountError("smb", "mount error(115): Operation now in progress\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)")).toContain("did not answer");
    expect(explainMountError("smb", "mount error(2): No such file or directory")).toContain("share does not exist");
    expect(explainMountError("nfs", "mount.nfs: access denied by server")).toContain("export allows");
    expect(explainMountError("smb", "something odd\nlast line")).toBe("something odd last line");
    // What systemd says when the NAS never answers inside x-systemd.mount-timeout.
    expect(explainMountError("smb", "mnt-nas.mount: Mounting timed out. Terminating.\nmnt-nas.mount: Failed with result 'timeout'.")).toContain("did not answer");
    // Unrecognised: quote the helper's words, not systemd's lines saying the unit failed.
    expect(explainMountError("smb", "mount error(95): odd\nmnt-nas.mount: Failed with result 'exit-code'.", "mount error(95): odd")).toBe("mount error(95): odd");
  });
});

describe("share.mount, on the host through the share's own units", () => {
  it("stores credentials root-only, adds the entry, and mounts the share on the host by starting its units", async () => {
    const files = fakeFiles();
    const host = fakeHost();
    const result = await shareMount({ kind: "smb", host: "mycloud", share: "Public", name: "nas-media", username: "jamie", password: "s3cret pass", domain: null }, { run: host.run, files, exists: toolsPresent, now });
    expect(result).toMatchObject({ mounted: true, kind: "smb", source: "//mycloud/Public", mountpoint: "/mnt/nas-media", credentialsStored: true, sizeBytes: 1000, availableBytes: 500 });
    expect(files.state.written[credentialsPath("nas-media")]).toEqual({ content: "username=jamie\npassword=s3cret pass\n", options: { mode: 0o600 } });
    expect(files.mkdir).toHaveBeenCalledWith("/etc/boxpilot/secrets", { recursive: true, mode: 0o700 });
    expect(files.state.fstab).toContain("# boxpilot:share-nas-media\n//mycloud/Public /mnt/nas-media cifs credentials=/etc/boxpilot/secrets/share-nas-media.cred,");
    // On the host: the automount, and the share over it.
    expect(host.state.mounts["/mnt/nas-media"]).toEqual(["autofs", "cifs"]);
    // PID 1 mounts it, in its own namespace; a mount run from the task's namespace never reached the host.
    expect(host.calls.some((call) => /^u?mount /.test(call))).toBe(false);
    const order = ["systemctl daemon-reload", "systemctl start mnt-nas\\x2dmedia.automount", "systemctl start mnt-nas\\x2dmedia.mount"].map((call) => host.calls.indexOf(call));
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]))).toBe(true);
    // Whether it is mounted, and how big it is, comes from PID 1's table.
    expect(host.calls.filter((call) => call.startsWith("findmnt") && !call.includes("--verify")).every((call) => call.startsWith("findmnt --task 1 "))).toBe(true);
    expect(host.calls.some((call) => call.includes("s3cret"))).toBe(false); // never on a command line
  });

  it("refuses before changing anything when the host already has something at the mount point", async () => {
    for (const mounted of [["autofs"], ["cifs"]]) {
      const files = fakeFiles();
      const host = fakeHost({ mounts: { "/mnt/nas-media": mounted } });
      await expect(shareMount({ kind: "smb", host: "mycloud", share: "Public", name: "nas-media" }, { run: host.run, files, exists: toolsPresent, now })).rejects.toThrow("/mnt/nas-media is already mounted");
      expect(files.state.fstab).toBe(BASE_FSTAB);
      expect(host.calls.some((call) => call.startsWith("systemctl"))).toBe(false);
    }
  });

  it("rolls back fstab, credentials, units and folder when the first mount fails, with the helper's reason", async () => {
    const files = fakeFiles();
    const host = fakeHost({ mountFails: "Mounting mnt-nas\\x2dprivate.mount - /mnt/nas-private...\nmount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)\nmnt-nas\\x2dprivate.mount: Mount process exited, code=exited, status=32/n/a\nmnt-nas\\x2dprivate.mount: Failed with result 'exit-code'." });
    await expect(shareMount({ kind: "smb", host: "mycloud", share: "Private", name: "nas-private", username: "jamie", password: "nope" }, { run: host.run, files, exists: toolsPresent, now })).rejects.toThrow(/refused the credentials.*were removed again/);
    expect(files.state.fstab).toBe(BASE_FSTAB);
    expect(files.state.written[credentialsPath("nas-private")]).toBeUndefined();
    // The empty mountpoint used to survive, so repeated attempts left directories under /mnt that
    // looked like working mounts. rmdir refuses a non-empty directory, so real data is never at risk.
    expect(files.state.removedDirs).toContain("/mnt/nas-private");
    // Nothing is left on the host, and no failed unit is left listed.
    expect(host.state.mounts["/mnt/nas-private"]).toEqual([]);
    expect(host.calls).toContain("journalctl --no-pager -o cat -u mnt-nas\\x2dprivate.mount --since=@1790596800.000");
    expect(host.calls).toContain("systemctl stop mnt-nas\\x2dprivate.mount mnt-nas\\x2dprivate.automount");
    // Cleared while its fstab line still loads it; the reload then lets it go.
    const order = ["systemctl stop mnt-nas\\x2dprivate.mount mnt-nas\\x2dprivate.automount", "systemctl reset-failed mnt-nas\\x2dprivate.mount"].map((call) => host.calls.indexOf(call));
    expect(order.every((index) => index >= 0) && order[0] < order[1] && order[1] < host.calls.lastIndexOf("systemctl daemon-reload")).toBe(true);
  });

  it("says the host did not answer when systemd gave up waiting for it", async () => {
    const host = fakeHost({ mountFails: "mnt-nas.mount: Mounting timed out. Terminating.\nmnt-nas.mount: Mount process exited, code=killed, status=15/TERM\nmnt-nas.mount: Failed with result 'timeout'." });
    await expect(shareMount({ kind: "nfs", host: "192.0.2.1", share: "/volume1/media", name: "nas" }, { run: host.run, files: fakeFiles(), exists: toolsPresent, now })).rejects.toThrow(/did not answer.*removed again/);
  });

  it("explains a failure by this attempt's words, never by a refusal the share's unit logged just before", async () => {
    // Seen in CI (tests/ubuntu/share-mount-host.sh 4b): share.mount of a NAS that does not answer,
    // started in the same second as a wrong password for the same share was refused. Read from the
    // whole second, the journal held that refusal too, and the host was said to refuse the credentials.
    const refused = "Mounting mnt-nas\\x2dmedia.mount - /mnt/nas-media...\nmount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)\nmnt-nas\\x2dmedia.mount: Mount process exited, code=exited, status=32/n/a\nmnt-nas\\x2dmedia.mount: Failed with result 'exit-code'.\nFailed to mount mnt-nas\\x2dmedia.mount - /mnt/nas-media.";
    const unanswered = "Mounting mnt-nas\\x2dmedia.mount - /mnt/nas-media...\nmount error(115): Operation now in progress\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)\nmnt-nas\\x2dmedia.mount: Mount process exited, code=exited, status=32/n/a\nmnt-nas\\x2dmedia.mount: Failed with result 'exit-code'.\nFailed to mount mnt-nas\\x2dmedia.mount - /mnt/nas-media.";
    const began = () => new Date("2026-09-29T10:36:09.880Z");
    const host = fakeHost({ mountFails: `${refused}\n${unanswered}` });
    await expect(shareMount({ kind: "smb", host: "192.0.2.1", share: "media", name: "nas-media", username: "nasuser", password: "right" }, { run: host.run, files: fakeFiles(), exists: toolsPresent, now: began }))
      .rejects.toThrow(/^The host did not answer\..*were removed again\.$/);
    // The journal is read from the moment the attempt began, not from the start of its second.
    expect(host.calls).toContain("journalctl --no-pager -o cat -u mnt-nas\\x2dmedia.mount --since=@1790678169.880");
    // The other way round, a refusal after a host that did not answer is still a refusal.
    const again = fakeHost({ mountFails: `${unanswered}\n${refused}` });
    await expect(shareMount({ kind: "smb", host: "127.0.0.1", share: "media", name: "nas-media", username: "nasuser", password: "wrong" }, { run: again.run, files: fakeFiles(), exists: toolsPresent, now: began }))
      .rejects.toThrow(/^The NAS refused the credentials\./);
  });

  it("does not take systemd's word that it mounted: nothing on the host is a failure", async () => {
    const files = fakeFiles();
    const host = fakeHost({ startsButNothing: true });
    await expect(shareMount({ kind: "smb", host: "mycloud", share: "Public", name: "nas-media" }, { run: host.run, files, exists: toolsPresent, now })).rejects.toThrow("systemd started mnt-nas\\x2dmedia.mount but nothing is mounted at /mnt/nas-media. The fstab entry and the empty mount folder were removed again.");
    expect(files.state.fstab).toBe(BASE_FSTAB);
    expect(host.state.mounts["/mnt/nas-media"]).toEqual([]);
  });

  it("mounts a folder inside a share, and refuses one that climbs out of it", async () => {
    // Some NAS boxes cannot create shares at all — a WD My Cloud Home offers Public,
    // TimeMachineBackup and one per user, permanently — so pointing at a folder inside a share is
    // the only way to keep backups out of the root of somebody's personal files.
    const files = fakeFiles();
    const host = fakeHost();
    await shareMount({ kind: "smb", host: "mycloud", share: "alex/BoxPilot-Backup", name: "boxpilot-backup", username: "alex", password: "s3cret" }, { run: host.run, files, exists: toolsPresent, now });
    // The backup destination goes under /mnt/boxpilot, the folder the helper's sandbox is given,
    // never on an automount point of its own (deploy/boxpilot-helper.service).
    expect(files.state.fstab).toContain("//mycloud/alex/BoxPilot-Backup /mnt/boxpilot/backup cifs");
    expect(files.state.fstab).toContain("# boxpilot:share-boxpilot-backup\n");
    expect(host.calls).toContain("systemctl start mnt-boxpilot-backup.automount");
    expect(host.state.mounts["/mnt/boxpilot/backup"]).toEqual(["autofs", "cifs"]);

    for (const share of ["../etc", "alex/../../etc", "/leading", "trailing/", "a//b", "alex/.."]) {
      await expect(shareMount({ kind: "smb", host: "mycloud", share, name: "nope" }, { run: fakeHost().run, files: fakeFiles(), exists: toolsPresent, now }))
        .rejects.toThrow(/share name/);
    }
  });

  it("leaves a mountpoint alone when it already existed", async () => {
    const files = fakeFiles();
    files.mkdir = vi.fn(async () => undefined); // already there: nothing was created, nothing to undo
    const host = fakeHost({ mountFails: "mount error(13): Permission denied" });
    await expect(shareMount({ kind: "smb", host: "mycloud", share: "Private", name: "existing", username: "jamie", password: "nope" }, { run: host.run, files, exists: toolsPresent, now })).rejects.toThrow();
    expect(files.state.removedDirs).toEqual([]);
  });

  it("refuses when the client tools are missing, and mounts NFS exports as guest", async () => {
    const files = fakeFiles();
    await expect(shareMount({ kind: "smb", host: "nas", share: "Public", name: "pub" }, { run: fakeHost().run, files, exists: async () => false, now })).rejects.toThrow("cifs-utils is not installed");
    const host = fakeHost({ fstype: "nfs4" });
    const result = await shareMount({ kind: "nfs", host: "nas", share: "/volume1/media", name: "media", readOnly: true }, { run: host.run, files, exists: toolsPresent, now });
    expect(result).toMatchObject({ mounted: true, kind: "nfs", source: "nas:/volume1/media", credentialsStored: false, readOnly: true, sizeBytes: 1000 });
    expect(files.state.fstab).toContain("nas:/volume1/media /mnt/media nfs ro,nofail,_netdev,x-systemd.automount");
    expect(host.state.mounts["/mnt/media"]).toEqual(["autofs", "nfs4"]);
  });
});

describe("share.unmount, on the host, and not while something uses the share", () => {
  it("unmounts on the host, then removes the automount, the entry and the credentials", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    files.state.written[credentialsPath("nas-media")] = { content: "x" };
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] } });
    await expect(shareUnmount({ name: "nas-media" }, { run: host.run, files, now })).resolves.toMatchObject({ unmounted: true, credentialsRemoved: true, directoryKept: true, sharingClosedFor: [] });
    expect(files.state.fstab).toBe(BASE_FSTAB);
    expect(host.state.mounts["/mnt/nas-media"]).toEqual([]);
    // The share first, while stopping it can still be refused; the automount only after it.
    const order = ["systemctl stop mnt-nas\\x2dmedia.mount", "systemctl stop mnt-nas\\x2dmedia.automount", "systemctl reset-failed mnt-nas\\x2dmedia.mount mnt-nas\\x2dmedia.automount", "systemctl daemon-reload"].map((call) => host.calls.indexOf(call));
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]))).toBe(true);
    expect(host.calls.some((call) => /^u?mount /.test(call))).toBe(false);
    await expect(shareUnmount({ name: "other" }, { run: host.run, files, now })).rejects.toThrow("not a BoxPilot-managed share");
  });

  it("only stops the automount when the share had already gone idle", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs"] } });
    await shareUnmount({ name: "nas-media" }, { run: host.run, files, now });
    expect(host.calls).not.toContain("systemctl stop mnt-nas\\x2dmedia.mount");
    expect(host.calls).toContain("systemctl stop mnt-nas\\x2dmedia.automount");
    expect(files.state.fstab).toBe(BASE_FSTAB);
  });

  it("names the apps that have the share and changes nothing", async () => {
    // Unmounting the host's copy would succeed underneath them: each container has a mount of its own.
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, containers: ["bp-plex", "bp-sonarr"] });
    await expect(shareUnmount({ name: "nas-media" }, { run: host.run, files, now })).rejects.toThrow("/mnt/nas-media is in use by bp-plex, bp-sonarr, so the share was left mounted and in fstab. Stop those apps or take the folder out of them, then try again.");
    expect(host.calls.some((call) => call.startsWith("systemctl stop"))).toBe(false);
    expect(files.state.fstab).toBe(MANAGED_FSTAB);
    expect(host.state.mounts["/mnt/nas-media"]).toEqual(["autofs", "cifs"]);
  });

  it("names an app bound to a folder above the share, and forgets nothing", async () => {
    // Kopia with /mnt carries the share into its own namespace: forgetting the share and its
    // credentials under it would leave Kopia writing to the NAS through a mount nobody can see.
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, containers: ["bp-kopia", "bp-nas-media-old"], binds: { "bp-kopia": "/mnt", "bp-nas-media-old": "/mnt/nas-media-old" } });
    await expect(shareUnmount({ name: "nas-media" }, { run: host.run, files, now })).rejects.toThrow("/mnt/nas-media is in use by bp-kopia, so the share was left mounted and in fstab.");
    expect(host.calls.some((call) => call.startsWith("systemctl stop"))).toBe(false);
    expect(files.state.fstab).toBe(MANAGED_FSTAB);
  });

  it("names what holds the share and leaves it mounted, automount and all", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    files.state.written[credentialsPath("nas-media")] = { content: "x" };
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, busy: true });
    await expect(shareUnmount({ name: "nas-media" }, { run: host.run, files, now, processes: holdingShell }))
      .rejects.toThrow(/^\/mnt\/nas-media is still in use by .* \(4242\), so the share was left mounted and in fstab: umount: \/mnt\/nas-media: target is busy\. Stop whatever/);
    // Stopping the automount would have taken the share away lazily, busy or not.
    expect(host.calls).not.toContain("systemctl stop mnt-nas\\x2dmedia.automount");
    expect(host.state.mounts["/mnt/nas-media"]).toEqual(["autofs", "cifs"]);
    expect(files.state.fstab).toBe(MANAGED_FSTAB);
    expect(files.state.written[credentialsPath("nas-media")]).toBeDefined();
  });

  it("gets file-sharing clients off the share first, as for a drive, and says whom", async () => {
    // A Samba share of /mnt reaches into every mount under it, network shares included.
    const smbConf = "[global]\n   workgroup = WORKGROUP\n[Everything]\n   path = /mnt\n";
    const files = fakeFiles(MANAGED_FSTAB, { smbConf });
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, busy: true, samba: true });
    const log = vi.fn();
    const result = await shareUnmount({ name: "nas-media" }, { run: host.run, files, log, now, sleep: async () => {} });
    expect(result.sharingClosedFor).toEqual(["192.168.1.40"]);
    const close = host.calls.indexOf("smbcontrol smbd close-share Everything");
    expect(close).toBeGreaterThan(host.calls.indexOf("systemctl stop mnt-nas\\x2dmedia.mount"));
    expect(host.calls[close + 1]).toBe("systemctl stop mnt-nas\\x2dmedia.mount");   // straight after the close
    expect(log).toHaveBeenCalledWith("Closed file-sharing connections from 192.168.1.40 to Everything so /mnt/nas-media could be unmounted", "stdout");
    expect(host.state.mounts["/mnt/nas-media"]).toEqual([]);
    expect(files.state.fstab).toBe(BASE_FSTAB);
  });

  it("releases the share again when something mounted it through the automount between the two stops", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, retrigger: true });
    await shareUnmount({ name: "nas-media" }, { run: host.run, files, now });
    expect(host.calls.filter((call) => call === "systemctl stop mnt-nas\\x2dmedia.mount")).toHaveLength(2);
    expect(host.calls.lastIndexOf("systemctl stop mnt-nas\\x2dmedia.mount")).toBeGreaterThan(host.calls.indexOf("systemctl stop mnt-nas\\x2dmedia.automount"));
    expect(host.state.mounts["/mnt/nas-media"]).toEqual([]);
    expect(files.state.fstab).toBe(BASE_FSTAB);
  });
});

describe("share.reconnect, the share's own remount", () => {
  const mountUnit = "systemctl stop mnt-nas\\x2dmedia.mount";

  it("unmounts and mounts the share again on the host, keeps its entry and credentials, and restarts the apps using it", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    files.state.written[credentialsPath("nas-media")] = { content: "x" };
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, containers: ["bp-plex"] });
    const result = await shareReconnect({ name: "nas-media" }, { run: host.run, files, now });
    expect(result).toEqual({ reconnected: true, name: "nas-media", mountpoint: "/mnt/nas-media", restarted: ["bp-plex"], restartFailed: [] });
    const order = [mountUnit, "systemctl start mnt-nas\\x2dmedia.automount", "systemctl start mnt-nas\\x2dmedia.mount", "docker restart bp-plex"].map((call) => host.calls.indexOf(call));
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]))).toBe(true);
    // Never the automount's stop, which takes the share away lazily; never mount or umount here.
    expect(host.calls).not.toContain("systemctl stop mnt-nas\\x2dmedia.automount");
    expect(host.calls.some((call) => /^u?mount /.test(call))).toBe(false);
    expect(host.state.mounts["/mnt/nas-media"]).toEqual(["autofs", "cifs"]);
    expect(files.state.fstab).toBe(MANAGED_FSTAB);
    expect(files.state.written[credentialsPath("nas-media")]).toBeDefined();
  });

  it("starts the share once more when systemd's first start mounted nothing, and restarts the apps only once it is there", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, containers: ["bp-plex"], noopStarts: 1 });
    const log = vi.fn();
    await expect(shareReconnect({ name: "nas-media" }, { run: host.run, files, now, log, sleep: async () => {} })).resolves.toMatchObject({ reconnected: true, restarted: ["bp-plex"] });
    const starts = host.calls.flatMap((call, index) => (call === "systemctl start mnt-nas\\x2dmedia.mount" ? [index] : []));
    expect(starts).toHaveLength(2);
    expect(host.calls.indexOf("docker restart bp-plex")).toBeGreaterThan(starts[1]);
    expect(log).toHaveBeenCalledWith("systemctl start mnt-nas\\x2dmedia.mount exited 0 with nothing mounted at /mnt/nas-media; waiting for systemd to catch up, then starting it once more", "stderr");
  });

  it("restarts no app when systemd says the share started and nothing is there", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, containers: ["bp-plex"], startsButNothing: true });
    await expect(shareReconnect({ name: "nas-media" }, { run: host.run, files, now, sleep: async () => {} }))
      .rejects.toThrow("systemd started mnt-nas\\x2dmedia.mount but nothing is mounted at /mnt/nas-media. /mnt/nas-media is not mounted now; its fstab entry is kept, so it mounts by itself once the NAS answers.");
    expect(host.calls.some((call) => call.startsWith("docker restart"))).toBe(false);
  });

  it("mounts a share that had gone idle without unmounting anything first", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs"] } });
    await expect(shareReconnect({ name: "nas-media" }, { run: host.run, files, now })).resolves.toMatchObject({ reconnected: true, restarted: [] });
    expect(host.calls).not.toContain(mountUnit);
    expect(host.state.mounts["/mnt/nas-media"]).toEqual(["autofs", "cifs"]);
  });

  it("leaves a share something other than an app is using as it was, naming the holder", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, busy: true });
    await expect(shareReconnect({ name: "nas-media" }, { run: host.run, files, now, processes: holdingShell }))
      .rejects.toThrow(/^\/mnt\/nas-media is in use by .* \(4242\), so it was left as it was: umount: \/mnt\/nas-media: target is busy\. Stop whatever/);
    expect(host.calls.some((call) => call.startsWith("systemctl start"))).toBe(false);
    expect(host.state.mounts["/mnt/nas-media"]).toEqual(["autofs", "cifs"]);
  });

  it("says why when the share does not come back, and keeps its entry so it mounts once the NAS answers", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, mountFails: "mount error(112): Host is down\nmnt-nas\\x2dmedia.mount: Mount process exited, code=exited, status=32/n/a" });
    await expect(shareReconnect({ name: "nas-media" }, { run: host.run, files, now }))
      .rejects.toThrow(/^The host did not answer\..* \/mnt\/nas-media is not mounted now; its fstab entry is kept, so it mounts by itself once the NAS answers\.$/);
    expect(files.state.fstab).toBe(MANAGED_FSTAB);
    // An earlier attempt's refusal in the journal read does not decide it either.
    const stale = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, mountFails: "Mounting mnt-nas\\x2dmedia.mount - /mnt/nas-media...\nmount error(13): Permission denied\nMounting mnt-nas\\x2dmedia.mount - /mnt/nas-media...\nmount error(112): Host is down\nmnt-nas\\x2dmedia.mount: Mount process exited, code=exited, status=32/n/a" });
    await expect(shareReconnect({ name: "nas-media" }, { run: stale.run, files: fakeFiles(MANAGED_FSTAB), now })).rejects.toThrow(/^The host did not answer\./);
  });

  it("fails, after restarting the apps, when the share comes back read-only again", async () => {
    const files = fakeFiles(MANAGED_FSTAB);
    const host = fakeHost({ mounts: { "/mnt/nas-media": ["autofs", "cifs"] }, containers: ["bp-plex"], readOnly: true });
    await expect(shareReconnect({ name: "nas-media" }, { run: host.run, files, now }))
      .rejects.toThrow("/mnt/nas-media was mounted again but is still read-only, so the NAS is serving it read-only to this server. Check the share's permissions for this user on the NAS. bp-plex was restarted.");
    expect(host.calls).toContain("docker restart bp-plex");
  });

  it("refuses a name that is not one of BoxPilot's shares", async () => {
    const host = fakeHost();
    await expect(shareReconnect({ name: "other" }, { run: host.run, files: fakeFiles(MANAGED_FSTAB), now })).rejects.toThrow("other is not a BoxPilot-managed share");
    await expect(shareReconnect({ name: "../etc" }, { run: host.run, files: fakeFiles(MANAGED_FSTAB), now })).rejects.toThrow("Name is invalid");
    expect(host.calls).toEqual([]);
  });
});
