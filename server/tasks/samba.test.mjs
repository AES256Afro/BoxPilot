import { describe, expect, it, vi } from "vitest";
import { discoveryState, parseSmbConf, renderSmbConf, sambaApply, sambaDiagnose, sambaDiscoverySet, sambaRecycleEmpty, sambaShareWritable, sambaUserRemove, sambaUserSet, validateSambaConfig } from "./samba.mjs";

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
    const conf = renderSmbConf({ scope: "lan", lanInterface: "eno1", shares: [{ name: "dump", path: "/mnt/the-dump", readOnly: false, guest: false, users: ["homebox"], recycle: true }], forceUsers: { dump: "homebox" } });
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
  it("turns Windows discovery on: installs wsdd only when missing, then enables it and opens the discovery ports", async () => {
    // The reason a healthy share is invisible in File Explorer: Windows browses with WS-Discovery,
    // which Samba does not speak. wsdd answers it, and the multicast needs the two ports open.
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("apt-get")) { installed = true; return { ok: true, stdout: "", stderr: "" }; }
      if (args?.[0] === "is-active") return { ok: true, stdout: "active\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const files = { access: async (target) => { if (target.includes("wsdd-server") || (target.includes("wsdd") && !installed)) throw new Error("ENOENT"); }, readFile: async () => "# Managed by BoxPilot\n[global]\n   interfaces = lo tailscale0 eno1\n" };

    const first = await sambaDiscoverySet({ enabled: true }, { run, files });
    expect(first).toMatchObject({ enabled: true, installed: true, running: true, allowed: ["3702/udp", "5357/tcp"] });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "-y", "--no-install-recommends", "wsdd"], expect.anything());   // the env is pinned by its own test below
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["enable", "--now", "wsdd"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "3702/udp", "comment", "BoxPilot WS-Discovery"], expect.anything());

    // Already installed: no second apt-get, the service is just (re-)enabled.
    run.mockClear();
    await sambaDiscoverySet({ enabled: true }, { run, files });
    expect(run.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);
  });

  it("installs and starts wsdd-server where the release split the service out of wsdd (Ubuntu 26.04)", async () => {
    // wsdd 0.8 ships the tool in wsdd and the service in wsdd-server. A server with only the tool
    // has /usr/bin/wsdd but no unit, and starting "wsdd" failed with "Unit wsdd.service does not
    // exist" - what the owner's server did before this.
    let serverInstalled = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "wsdd-server:\n  Installed: (none)\n  Candidate: 2:0.8-5ubuntu1\n", stderr: "" };
      if (binary.endsWith("apt-get")) { serverInstalled = args.includes("wsdd-server"); return { ok: true, stdout: "", stderr: "" }; }
      if (args?.[0] === "is-active") return { ok: true, stdout: "active\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    // The wsdd tool is already there; only wsdd-server brings a unit.
    const files = { access: async (target) => { if (target === "/usr/bin/wsdd") return; if (target.endsWith("wsdd-server.service") && serverInstalled) return; throw new Error("ENOENT"); }, readFile: async () => "# Managed by BoxPilot\n[global]\n   interfaces = lo tailscale0 eno1\n" };

    const result = await sambaDiscoverySet({ enabled: true }, { run, files });
    expect(result).toMatchObject({ enabled: true, installed: true, running: true, unit: "wsdd-server" });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "-y", "--no-install-recommends", "wsdd-server"], expect.anything());
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["enable", "--now", "wsdd-server"], expect.anything());
    expect(run).not.toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["enable", "--now", "wsdd"], expect.anything());
  });

  it("counts the wsdd tool without a service as not installed", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const files = { access: async (target) => { if (target === "/usr/bin/wsdd") return; throw new Error("ENOENT"); } };
    await expect(discoveryState(run, files)).resolves.toEqual({ installed: false, running: false, unit: null });
  });

  it("turns Windows discovery off by stopping wsdd and withdrawing the discovery rules", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "inactive\n", stderr: "" }));
    const files = { access: async () => { throw new Error("ENOENT"); }, readFile: async () => "# Managed by BoxPilot\n[global]\n   interfaces = lo tailscale0 eno1\n" };
    await expect(sambaDiscoverySet({ enabled: false }, { run, files })).resolves.toMatchObject({ enabled: false, installed: false });
    // Whichever unit this release has is disabled; the one it lacks is simply not there.
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["disable", "--now", "wsdd-server"], expect.anything());
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["disable", "--now", "wsdd"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "3702/udp"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "5357/tcp"], expect.anything());
  });

  it("reports a clear failure when wsdd cannot be installed", async () => {
    const run = vi.fn(async (binary) => (binary.endsWith("apt-get") ? { ok: false, stdout: "", stderr: "E: Unable to locate package wsdd" } : { ok: true, stdout: "", stderr: "" }));
    const files = { access: async () => { throw new Error("ENOENT"); }, readFile: async () => "# Managed by BoxPilot\n[global]\n   interfaces = lo tailscale0 eno1\n" };
    await expect(sambaDiscoverySet({ enabled: true }, { run, files })).rejects.toThrow("Could not install wsdd");
  });
  describe("sambaDiagnose", () => {
    const CONF = [
      "# Managed by BoxPilot", "[global]", "   workgroup = WORKGROUP", "   interfaces = lo tailscale0 eno1",
      "[the-dump]", "   path = /mnt/the-dump", "   read only = no", "   guest ok = no", "   valid users = chris",
    ].join("\n");
    // A server where everything that can be right, is: running, valid, listening, discoverable.
    function healthyRun({ discovery = true, ufw = "Status: active\n445/tcp ALLOW Anywhere\n", listen = "LISTEN 0 50 0.0.0.0:445 0.0.0.0:*" } = {}) {
      return vi.fn(async (binary, args) => {
        if (args?.[0] === "is-active" && args?.[1] === "smbd") return { ok: true, stdout: "active\n", stderr: "" };
        if (args?.[0] === "is-active" && args?.[1] === "wsdd") return { ok: true, stdout: discovery ? "active\n" : "inactive\n", stderr: "" };
        if (binary.endsWith("testparm")) return { ok: true, stdout: "", stderr: "" };
        if (binary.endsWith("/ss")) return { ok: true, stdout: listen, stderr: "" };
        if (binary.endsWith("ufw")) return { ok: true, stdout: ufw, stderr: "" };
        if (args?.[0] === "group") return { ok: true, stdout: "sambashare:x:1001:chris\n", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      });
    }
    const filesFor = ({ uid = 1000, exists = true, isDir = true, wsdd = true } = {}) => ({
      readFile: async () => CONF,
      stat: async () => { if (!exists) throw new Error("ENOENT"); return { uid, isDirectory: () => isDir }; },
      access: async (target) => { if (target.includes("wsdd-server") || (target.includes("wsdd") && !wsdd)) throw new Error("ENOENT"); },
    });
    const byId = (result) => Object.fromEntries(result.checks.map((check) => [check.id, check]));

    it("reports a healthy server as ok across the board", async () => {
      const result = await sambaDiagnose({}, { run: healthyRun(), files: filesFor() });
      expect(result.ok).toBe(true);
      const checks = byId(result);
      expect(checks.running.state).toBe("ok");
      expect(checks.config.state).toBe("ok");
      expect(checks.listening.detail).toContain("0.0.0.0:445");
      expect(checks.discovery.state).toBe("ok");
      expect(checks["share.the-dump.write"].state).toBe("ok");
    });

    it("names the silent failure: a root-owned folder nobody can write to", async () => {
      // The qBittorrent/the-dump class of problem - connecting works, writing fails, no error anywhere.
      const result = await sambaDiagnose({}, { run: healthyRun(), files: filesFor({ uid: 0 }) });
      const write = byId(result)["share.the-dump.write"];
      expect(result.ok).toBe(false);
      expect(write.state).toBe("problem");
      expect(write.detail).toContain("owned by root");
      expect(write.hint).toContain("Hand the folder to a user");
    });

    it("explains an invisible-but-working server, and does not call it broken", async () => {
      const result = await sambaDiagnose({}, { run: healthyRun({ discovery: false }), files: filesFor({ wsdd: false }) });
      const discovery = byId(result).discovery;
      expect(discovery.state).toBe("warn");            // a warning, not a problem: the share does work
      expect(result.ok).toBe(true);                     // so the overall verdict stays ok
      expect(discovery.detail).toContain("WS-Discovery");
      expect(discovery.hint).toContain("type the address");
    });

    it("catches a missing folder, a blocking firewall, and users that do not exist", async () => {
      const gone = await sambaDiagnose({}, { run: healthyRun(), files: filesFor({ exists: false }) });
      expect(byId(gone)["share.the-dump.path"].state).toBe("problem");

      const blocked = await sambaDiagnose({}, { run: healthyRun({ ufw: "Status: active\n22/tcp ALLOW Anywhere\n" }), files: filesFor() });
      expect(byId(blocked).firewall.state).toBe("problem");

      const noUser = vi.fn(async (binary, args) => (args?.[0] === "group" ? { ok: true, stdout: "sambashare:x:1001:\n", stderr: "" } : healthyRun()(binary, args)));
      const missing = await sambaDiagnose({}, { run: noUser, files: filesFor() });
      expect(byId(missing)["share.the-dump.users"].detail).toContain("chris");
    });

    it("stops at the first thing that makes the rest moot", async () => {
      const result = await sambaDiagnose({}, { run: healthyRun(), files: { ...filesFor(), access: async () => { throw new Error("ENOENT"); } } });
      expect(result.ok).toBe(false);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].id).toBe("installed");
    });
  });
  it("refuses to open LAN ports when the shares are tailnet-only", async () => {
    // wsdd multicasts this server's name to the LAN and the two rules are LAN-facing. On a
    // tailnet-only server that is the opposite of what the scope asked for. The UI hides the
    // button in that scope, but a hidden button is not a check.
    const tailnetOnly = "# Managed by BoxPilot\n[global]\n   interfaces = lo tailscale0\n";
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const files = { access: async () => {}, readFile: async () => tailnetOnly };   // wsdd present
    await expect(sambaDiscoverySet({ enabled: true }, { run, files })).rejects.toThrow("Tailscale only");
    expect(run.mock.calls.some(([binary]) => binary.endsWith("ufw") || binary.endsWith("apt-get"))).toBe(false);
    // Turning it off is always allowed: there is no reason to refuse to close ports.
    await expect(sambaDiscoverySet({ enabled: false }, { run, files })).resolves.toMatchObject({ enabled: false });
  });

  it("suspends needrestart while installing, so apt cannot restart BoxPilot mid-job", async () => {
    let installed = false;
    const run = vi.fn(async (binary) => { if (binary.endsWith("apt-get")) installed = true; return { ok: true, stdout: "active\n", stderr: "" }; });
    const files = { access: async (target) => { if (target.includes("wsdd-server") || (target.includes("wsdd") && !installed)) throw new Error("ENOENT"); }, readFile: async () => "# Managed by BoxPilot\n[global]\n   interfaces = lo tailscale0 eno1\n" };
    await sambaDiscoverySet({ enabled: true }, { run, files });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", expect.anything(), expect.objectContaining({ env: { DEBIAN_FRONTEND: "noninteractive", NEEDRESTART_SUSPEND: "1" } }));
  });
});

describe("letting people write to a share nobody can write to (M35)", () => {
  // Samba writes as the folder's owner; a root-owned folder leaves it nobody to write as, so every
  // client is read-only however the share is set. Repair used to say "hand the folder to a user".
  const conf = renderSmbConf({ shares: [{ name: "Documents", path: "/srv/documents" }, { name: "Media", path: "/mnt/media", readOnly: true, guest: true }] });
  function rig({ fstype = "ext4", users = { 1000: "alex:x:1000:1000::/home/alex:/bin/bash" } } = {}) {
    const files = fakeFiles({ existing: conf });
    const owner = { uid: 0 };
    files.stat = vi.fn(async () => ({ isDirectory: () => true, uid: owner.uid }));
    const base = fakeRun({ users });
    const run = vi.fn(async (binary, args, options) => (binary.endsWith("findmnt") ? { ok: true, stdout: `${fstype} ${fstype === "exfat" ? "/mnt/the-dump" : "/"}\n`, stderr: "" } : base(binary, args, options)));
    const chown = vi.fn(async (_path, uid) => { owner.uid = uid; });
    return { files, run, chown, owner };
  }

  it("hands that one folder to the user apps run as, and applies the shares so it writes as them", async () => {
    const { files, run, chown } = rig();
    const result = await sambaShareWritable({ share: "Documents" }, { run, files, chown });
    expect(result).toEqual({ writable: true, share: "Documents", path: "/srv/documents", owner: "alex", forceUser: "alex" });
    expect(chown).toHaveBeenCalledWith("/srv/documents", 1000, 1000);
    expect(chown).toHaveBeenCalledTimes(1);   // the folder itself, never what is inside it
    expect(parseSmbConf(files.state.conf).shares.find((share) => share.name === "Documents").forceUser).toBe("alex");
    // The read-only share is applied again as it was.
    expect(parseSmbConf(files.state.conf).shares.find((share) => share.name === "Media")).toMatchObject({ readOnly: true, guest: true });
  });

  it("refuses a folder on an exFAT drive, which keeps no owners, and names the fix that works, before changing anything", async () => {
    const { files, run, chown } = rig({ fstype: "exfat" });
    await expect(sambaShareWritable({ share: "Documents" }, { run, files, chown })).rejects.toThrow('keeps no owners, so the folder cannot be handed to anyone; the drive\'s mount decides. Use "Let apps write to the drive"');
    expect(chown).not.toHaveBeenCalled();
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("refuses a read-only share, one that is not there, and a server with no user to hand it to", async () => {
    const { files, run, chown } = rig();
    await expect(sambaShareWritable({ share: "Media" }, { run, files, chown })).rejects.toThrow("read-only on purpose");
    await expect(sambaShareWritable({ share: "Nope" }, { run, files, chown })).rejects.toThrow("There is no share named Nope");
    await expect(sambaShareWritable({ share: "../x" }, { run, files, chown })).rejects.toThrow("Share name is invalid");
    const nobody = rig({ users: {} });
    await expect(sambaShareWritable({ share: "Documents" }, { run: nobody.run, files: nobody.files, chown: nobody.chown })).rejects.toThrow("There is no user 1000");
    expect(chown).not.toHaveBeenCalled();
  });
});
