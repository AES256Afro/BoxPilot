import { describe, expect, it, vi } from "vitest";
import { parseSmbConf, renderSmbConf, sambaApply, sambaRecycleEmpty, sambaUserRemove, sambaUserSet, validateSambaConfig } from "./samba.mjs";

function fakeRun({ testparmFails = false, lanDevice = "eno1", users = {} } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("testparm")) return testparmFails ? { ok: false, stdout: "", stderr: "Error loading services" } : { ok: true, stdout: "Loaded services file OK.", stderr: "" };
    if (binary.endsWith("/ip")) return { ok: true, stdout: JSON.stringify([{ dst: "default", dev: lanDevice }]), stderr: "" };
    if (binary.endsWith("getent") && args[0] === "group") return { ok: true, stdout: "sambashare:x:125:", stderr: "" };
    if (binary.endsWith("getent") && args[0] === "passwd") { const entry = users[args[1]]; return entry ? { ok: true, stdout: entry, stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
    // `ss -H -l -n -t`: State Recv-Q Send-Q Local:Port Peer:Port (no type column with a single -t)
    if (binary.endsWith("/ss")) return { ok: true, stdout: "LISTEN 0 50 100.64.0.5:445 0.0.0.0:*\nLISTEN 0 50 127.0.0.1:445 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:8787 0.0.0.0:*\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}
function fakeFiles({ existing = null, ownerUid = 1000 } = {}) {
  const state = { conf: existing, written: {}, backups: [] };
  return {
    state,
    readFile: vi.fn(async () => { if (state.conf === null) throw new Error("ENOENT"); return state.conf; }),
    writeFile: vi.fn(async (path, content) => { state.written[path] = content; if (path === "/etc/samba/smb.conf") state.conf = content; }),
    rename: vi.fn(async (from, to) => { state.written[to] = state.written[from]; state.conf = state.written[to]; delete state.written[from]; }),
    copyFile: vi.fn(async (from, to) => { state.backups.push(to); }),
    stat: vi.fn(async () => ({ isDirectory: () => true, uid: ownerUid })),
    access: vi.fn(async () => {}),
  };
}

describe("samba tasks", () => {
  it("validates the declarative configuration", () => {
    expect(validateSambaConfig({ shares: [{ name: "Media", path: "/mnt/nas-media", readOnly: true, guest: true }] })).toBeNull();
    expect(validateSambaConfig({ scope: "internet" })).toContain("scope");
    expect(validateSambaConfig({ workgroup: "bad group" })).toContain("workgroup");
    expect(validateSambaConfig({ shares: [{ name: "global", path: "/srv" }] })).toContain("invalid");
    expect(validateSambaConfig({ shares: [{ name: "A", path: "/srv/a" }, { name: "a", path: "/srv/b" }] })).toContain("twice");
    expect(validateSambaConfig({ shares: [{ name: "Etc", path: "/etc" }] })).toContain("system locations");
    expect(validateSambaConfig({ shares: [{ name: "Up", path: "/srv/../etc" }] })).toContain("system locations");
    expect(validateSambaConfig({ shares: [{ name: "X", path: "/srv/x", guest: true, users: ["jamie"] }] })).toContain("guest share");
    expect(validateSambaConfig({ shares: [{ name: "X", path: "/srv/x", users: ["Jamie!"] }] })).toContain("usernames");
  });

  it("renders a tailnet-only configuration and parses it back", () => {
    const text = renderSmbConf({ scope: "tailscale", shares: [{ name: "Media", path: "/mnt/nas-media/", comment: "Films", readOnly: true, guest: true }, { name: "Private", path: "/srv/private", users: ["jamie", "sam"] }], forceUsers: { Private: "homebox" } });
    expect(text.startsWith("# Managed by BoxPilot")).toBe(true);
    expect(text).toContain("   interfaces = lo tailscale0\n   bind interfaces only = yes\n   smb ports = 445\n   disable netbios = yes");
    expect(text).toContain("[Media]\n   comment = Films\n   path = /mnt/nas-media\n   browseable = yes\n   read only = yes\n   guest ok = yes\n   force group = sambashare");
    expect(text).toContain("[Private]\n   comment = Private\n   path = /srv/private\n   browseable = yes\n   read only = no\n   guest ok = no\n   valid users = jamie sam\n   force user = homebox");
    const parsed = parseSmbConf(text);
    expect(parsed).toMatchObject({ managed: true, workgroup: "WORKGROUP", scope: "tailscale", interfaces: ["lo", "tailscale0"] });
    expect(parsed.shares).toEqual([
      { name: "Media", path: "/mnt/nas-media", comment: "Films", readOnly: true, guest: true, users: [], forceUser: null, recycle: false },
      { name: "Private", path: "/srv/private", comment: "Private", readOnly: false, guest: false, users: ["jamie", "sam"], forceUser: "homebox", recycle: false },
    ]);
    expect(renderSmbConf({ scope: "lan", lanInterface: "eno1" })).toContain("   interfaces = lo tailscale0 eno1\n   bind interfaces only = yes\n   smb ports = 445\n   disable netbios = no");
    expect(parseSmbConf("[global]\n   workgroup = HOME\n[printers]\n   path = /var/spool/samba\n   printable = yes\n")).toMatchObject({ managed: false, workgroup: "HOME", scope: "lan", shares: [] });
  });

  it("renders a recycle bin for a share, and empties it by share name only", async () => {
    const conf = renderSmbConf({ scope: "lan", lanInterface: "eno1", shares: [{ name: "dump", path: "/mnt/the-dump", readOnly: false, guest: false, users: ["bigbox"], recycle: true }], forceUsers: { dump: "bigbox" } });
    expect(conf).toContain("vfs objects = fruit streams_xattr recycle");
    expect(conf).toContain("recycle:repository = .recycle");
    expect(parseSmbConf(conf).shares[0].recycle).toBe(true);

    const calls = [];
    const run = vi.fn(async (binary, args) => { calls.push([binary, ...args]); return binary.endsWith("/du") ? { ok: true, stdout: "5242880\t/mnt/the-dump/.recycle", stderr: "" } : { ok: true, stdout: "", stderr: "" }; });
    const files = { readFile: vi.fn(async () => conf) };

    const all = await sambaRecycleEmpty({ share: "dump" }, { run, files });
    expect(all).toMatchObject({ emptied: true, share: "dump", path: "/mnt/the-dump/.recycle", freedBytes: 5242880 });
    expect(calls.some(([bin, ...a]) => bin.endsWith("/rm") && a.includes("/mnt/the-dump/.recycle"))).toBe(true);

    calls.length = 0;
    await sambaRecycleEmpty({ share: "dump", olderThanDays: 30 }, { run, files });
    expect(calls.some(([bin, ...a]) => bin.endsWith("/find") && a.includes("-mtime") && a.includes("+30"))).toBe(true);
    expect(calls.some(([bin]) => bin.endsWith("/rm"))).toBe(false); // an age-based clean never wipes the whole bin

    await expect(sambaRecycleEmpty({ share: "nope" }, { run, files })).rejects.toThrow(/No share named/);
  });

  it("applies the configuration: backs up a foreign smb.conf, validates with testparm, reloads, and verifies listening", async () => {
    const files = fakeFiles({ existing: "[global]\n   workgroup = OLD\n" });
    const run = fakeRun({ users: { 1000: "homebox:x:1000:1000::/home/homebox:/bin/bash" } });
    const result = await sambaApply({ scope: "tailscale", shares: [{ name: "Media", path: "/mnt/nas-media", readOnly: true, guest: true }] }, { run, files });
    expect(result).toMatchObject({ applied: true, scope: "tailscale", shares: ["Media"], interfaces: ["lo", "tailscale0"], listening: ["100.64.0.5:445", "127.0.0.1:445"], forceUsers: { Media: "homebox" } });
    expect(files.state.backups).toEqual(["/etc/samba/smb.conf.before-boxpilot"]);
    expect(files.state.conf).toContain("[Media]");
    expect(files.state.conf).toContain("force user = homebox");
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain("testparm -s --suppress-prompt /etc/samba/smb.conf");
    expect(calls).toContain("systemctl enable --now smbd");
    expect(calls).toContain("systemctl reload-or-restart smbd");
    expect(calls).toContain("systemctl disable --now nmbd");
    // LAN scope resolves the default-route interface and keeps NetBIOS for discovery.
    const lan = await sambaApply({ scope: "lan", shares: [] }, { run: fakeRun(), files: fakeFiles() });
    expect(lan.interfaces).toEqual(["lo", "tailscale0", "eno1"]);
  });

  it("restores the previous smb.conf when testparm rejects the new one, and refuses without Samba", async () => {
    const files = fakeFiles({ existing: "# Managed by BoxPilot\n[global]\n" });
    await expect(sambaApply({ shares: [{ name: "X", path: "/srv/x" }] }, { run: fakeRun({ testparmFails: true }), files })).rejects.toThrow("restored the previous one");
    expect(files.state.conf).toBe("# Managed by BoxPilot\n[global]\n");
    expect(files.state.backups).toEqual([]); // already managed: no backup copy
    const missing = fakeFiles();
    missing.access = vi.fn(async () => { throw new Error("ENOENT"); });
    await expect(sambaApply({ shares: [] }, { run: fakeRun(), files: missing })).rejects.toThrow("not installed");
    await expect(sambaApply({ shares: [{ name: "Bad", path: "/etc" }] }, { run: fakeRun(), files: fakeFiles() })).rejects.toThrow("Invalid configuration");
  });

  it("creates shell-less accounts and feeds smbpasswd on stdin, never on the command line", async () => {
    const run = fakeRun();
    await expect(sambaUserSet({ username: "sam", password: "correct horse battery" }, { run })).resolves.toEqual({ username: "sam", created: true, updated: false });
    expect(run).toHaveBeenCalledWith("/usr/sbin/useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "--groups", "sambashare", "--comment", "BoxPilot Samba user", "sam"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/bin/smbpasswd", ["-s", "-a", "sam"], expect.objectContaining({ input: "correct horse battery\ncorrect horse battery\n" }));
    expect(run.mock.calls.every(([, args]) => !args.join(" ").includes("correct horse"))).toBe(true);
    const existing = fakeRun({ users: { homebox: "homebox:x:1000:1000::/home/homebox:/bin/bash" } });
    await expect(sambaUserSet({ username: "homebox", password: "another long one" }, { run: existing })).resolves.toMatchObject({ created: false, updated: true });
    expect(existing).toHaveBeenCalledWith("/usr/sbin/usermod", ["-a", "-G", "sambashare", "homebox"], expect.anything());
    await expect(sambaUserSet({ username: "sam", password: "short" }, { run })).rejects.toThrow("8 to 128");
    await expect(sambaUserSet({ username: "Bad Name", password: "long enough pw" }, { run })).rejects.toThrow("Username");
    await expect(sambaUserRemove({ username: "sam" }, { run })).resolves.toEqual({ username: "sam", removed: true, accountKept: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/smbpasswd", ["-x", "sam"], expect.anything());
  });
});
