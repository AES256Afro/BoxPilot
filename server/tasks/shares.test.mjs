import { describe, expect, it, vi } from "vitest";
import { buildShareEntry, credentialsPath, explainMountError, shareMount, shareUnmount, validateShare } from "./shares.mjs";

const BASE_FSTAB = "# /etc/fstab\nUUID=root-uuid / ext4 defaults 0 1\n";

function fakeFiles(fstab = BASE_FSTAB) {
  const state = { fstab, written: {}, unlinked: [] };
  return {
    state,
    readFile: vi.fn(async (path) => { if (path === "/etc/fstab") return state.fstab; throw new Error("ENOENT"); }),
    writeFile: vi.fn(async (path, content, options) => { if (path === "/etc/fstab") state.fstab = content; else state.written[path] = { content, options }; }),
    mkdir: vi.fn(async () => {}),
    unlink: vi.fn(async (path) => { state.unlinked.push(path); if (!state.written[path]) throw new Error("ENOENT"); delete state.written[path]; }),
  };
}

function fakeRun({ mountFails = null, mountedAt = {} } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("findmnt") && args[0] === "--verify") return { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("findmnt")) { const target = args.at(-1); return mountedAt[target] ? { ok: true, stdout: mountedAt[target], stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
    if (binary.endsWith("systemd-escape")) return { ok: true, stdout: "mnt-nas\\x2dmedia.automount\n", stderr: "" };
    if (binary.endsWith("/mount")) { if (mountFails) return { ok: false, stdout: "", stderr: mountFails }; mountedAt[args[0]] = `//nas/media cifs 1000 500`; return { ok: true, stdout: "", stderr: "" }; }
    if (binary.endsWith("umount")) { delete mountedAt[args[0]]; return { ok: true, stdout: "", stderr: "" }; }
    return { ok: true, stdout: "", stderr: "" };
  });
}
const toolsPresent = async () => true;

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

    expect(buildShareEntry({ kind: "smb", host: "nas", share: "My Files", name: "nas-files", guest: false }).entry)
      .toBe("//nas/My\\040Files /mnt/nas-files cifs credentials=/etc/boxpilot/secrets/share-nas-files.cred,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=300,x-systemd.mount-timeout=30 0 0");
    expect(buildShareEntry({ kind: "smb", host: "nas", share: "Public", name: "pub", guest: true, readOnly: true }).entry).toContain("cifs guest,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,ro,nofail");
    expect(buildShareEntry({ kind: "nfs", host: "nas", share: "/volume1/media", name: "media" }).entry).toBe("nas:/volume1/media /mnt/media nfs rw,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=300,x-systemd.mount-timeout=30 0 0");
  });

  it("explains mount failures in plain words", () => {
    expect(explainMountError("smb", "mount error(13): Permission denied")).toContain("My Cloud Home");
    expect(explainMountError("smb", "mount error(112): Host is down")).toContain("did not answer");
    expect(explainMountError("smb", "mount error(2): No such file or directory")).toContain("share does not exist");
    expect(explainMountError("nfs", "mount.nfs: access denied by server")).toContain("export allows");
    expect(explainMountError("smb", "something odd\nlast line")).toBe("something odd last line");
  });

  it("stores credentials root-only, adds the fstab entry, mounts, and starts the automount", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    const result = await shareMount({ kind: "smb", host: "mycloud", share: "Public", name: "nas-media", username: "jamie", password: "s3cret pass", domain: null }, { run, files, exists: toolsPresent });
    expect(result).toMatchObject({ mounted: true, kind: "smb", source: "//mycloud/Public", mountpoint: "/mnt/nas-media", credentialsStored: true, sizeBytes: 1000, availableBytes: 500 });
    expect(files.state.written[credentialsPath("nas-media")]).toEqual({ content: "username=jamie\npassword=s3cret pass\n", options: { mode: 0o600 } });
    expect(files.mkdir).toHaveBeenCalledWith("/etc/boxpilot/secrets", { recursive: true, mode: 0o700 });
    expect(files.state.fstab).toContain("# boxpilot:share-nas-media\n//mycloud/Public /mnt/nas-media cifs credentials=/etc/boxpilot/secrets/share-nas-media.cred,");
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain("systemctl daemon-reload");
    expect(calls).toContain("mount /mnt/nas-media");
    expect(calls).toContain("systemctl start mnt-nas\\x2dmedia.automount");
    expect(calls.some((call) => call.includes("s3cret"))).toBe(false); // never on a command line
  });

  it("rolls back fstab and credentials when the first mount fails, with a readable reason", async () => {
    const files = fakeFiles();
    const run = fakeRun({ mountFails: "mount error(13): Permission denied" });
    await expect(shareMount({ kind: "smb", host: "mycloud", share: "Private", name: "nas-private", username: "jamie", password: "nope" }, { run, files, exists: toolsPresent })).rejects.toThrow(/refused the credentials.*fstab entry was removed/);
    expect(files.state.fstab).toBe(BASE_FSTAB);
    expect(files.state.written[credentialsPath("nas-private")]).toBeUndefined();
  });

  it("refuses when the client tools are missing, and mounts NFS exports as guest", async () => {
    const files = fakeFiles();
    await expect(shareMount({ kind: "smb", host: "nas", share: "Public", name: "pub" }, { run: fakeRun(), files, exists: async () => false })).rejects.toThrow("cifs-utils is not installed");
    const run = fakeRun();
    const result = await shareMount({ kind: "nfs", host: "nas", share: "/volume1/media", name: "media", readOnly: true }, { run, files, exists: toolsPresent });
    expect(result).toMatchObject({ mounted: true, kind: "nfs", source: "nas:/volume1/media", credentialsStored: false, readOnly: true });
    expect(files.state.fstab).toContain("nas:/volume1/media /mnt/media nfs ro,nofail,_netdev,x-systemd.automount");
  });

  it("unmounts, removes the entry and the credentials, and refuses foreign entries", async () => {
    const files = fakeFiles(`${BASE_FSTAB}# boxpilot:share-nas-media\n//mycloud/Public /mnt/nas-media cifs credentials=/etc/boxpilot/secrets/share-nas-media.cred,nofail 0 0\n`);
    files.state.written[credentialsPath("nas-media")] = { content: "x" };
    const run = fakeRun({ mountedAt: { "/mnt/nas-media": "mounted" } });
    await expect(shareUnmount({ name: "nas-media" }, { run, files })).resolves.toMatchObject({ unmounted: true, credentialsRemoved: true, directoryKept: true });
    expect(files.state.fstab).toBe(BASE_FSTAB);
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain("systemctl stop mnt-nas\\x2dmedia.automount");
    expect(calls).toContain("umount /mnt/nas-media");
    await expect(shareUnmount({ name: "other" }, { run, files })).rejects.toThrow("not a BoxPilot-managed share");
  });
});
