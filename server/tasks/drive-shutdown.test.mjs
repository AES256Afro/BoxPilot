import { describe, expect, it, vi } from "vitest";
import { hostView, managedDriveEntries, mountUnitName, parseContainers, parseExtState, parseSystemdUtcTimestamp, parseVerifySummary, planDockerOrder, prepareDrivesForReboot, resumeAfterCancelledReboot, stopSignalOf, storageDockerOrder, storageVolumeState, verificationAllows } from "./drive-shutdown.mjs";
import { afterResume, systemReboot } from "./system.mjs";
import { exfatVolumeFlags, withDockerOrder } from "./storage.mjs";
import { laggingSystemd } from "../../test/lagging-systemd.mjs";

const ORDER = "x-systemd.before=docker.service,x-systemd.device-timeout=30s";
// The owner's line as it is on the server, under BoxPilot's marker, among lines BoxPilot never wrote.
const OWNER_FSTAB = [
  "# /etc/fstab: static file system information.",
  "/dev/disk/by-id/dm-uuid-LVM-root / ext4 defaults 0 1",
  "/dev/disk/by-uuid/1111-2222 /boot/efi vfat defaults 0 1",
  "# boxpilot:the-dump",
  "UUID=0023-7927 /mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000 0 0",
  "# boxpilot:share-nas",
  "//nas/media /mnt/nas cifs guest,uid=1000,gid=1000,nofail,_netdev,x-systemd.automount 0 0",
  "# boxpilot:swap",
  "/swap.boxpilot none swap sw,nofail 0 0",
  "UUID=aaaa-bbbb /mnt/hand-made ext4 defaults,nofail 0 2",
  "",
].join("\n");

describe("the Docker ordering in drive entries", () => {
  it("adds both options, keeping a device timeout the owner chose", () => {
    expect(withDockerOrder("defaults,nofail")).toBe(`defaults,nofail,${ORDER}`);
    expect(withDockerOrder(`defaults,nofail,${ORDER}`)).toBe(`defaults,nofail,${ORDER}`);
    expect(withDockerOrder("ro,nofail,x-systemd.device-timeout=2min")).toBe("ro,nofail,x-systemd.device-timeout=2min,x-systemd.before=docker.service");
  });

  it("names mount units the way systemd-escape does", () => {
    expect(mountUnitName("/mnt/the-dump")).toBe("mnt-the\\x2ddump.mount");
    expect(mountUnitName("/mnt/media")).toBe("mnt-media.mount");
    expect(mountUnitName("/mnt/My Disk")).toBe("mnt-My\\x20Disk.mount");
    expect(mountUnitName("/")).toBe("-.mount");
  });

  it("changes only the options of BoxPilot's drive lines, byte for byte everywhere else", () => {
    const plan = planDockerOrder(OWNER_FSTAB);
    expect(plan.changed).toBe(true);
    const before = OWNER_FSTAB.split("\n");
    const after = plan.content.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after[4]).toBe(`UUID=0023-7927 /mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000,${ORDER} 0 0`);
    for (const index of before.keys()) if (index !== 4) expect(after[index]).toBe(before[index]);
    expect(plan.drives).toEqual([
      { name: "the-dump", mountpoint: "/mnt/the-dump", status: "updated", previousOptions: "defaults,nofail,uid=1000,gid=1000", options: `defaults,nofail,uid=1000,gid=1000,${ORDER}` },
      { name: "share-nas", mountpoint: "/mnt/nas", status: "skipped", reason: "a network share" },
      { name: "swap", mountpoint: "none", status: "skipped", reason: "the swap file" },
    ]);
  });

  it("keeps tabs and runs of spaces between fields, and is idempotent", () => {
    const tabbed = "# boxpilot:media\nUUID=x\t/mnt/media   ext4\tdefaults,nofail\t0  2\n";
    const once = planDockerOrder(tabbed);
    expect(once.content).toBe(`# boxpilot:media\nUUID=x\t/mnt/media   ext4\tdefaults,nofail,${ORDER}\t0  2\n`);
    const twice = planDockerOrder(once.content);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
    expect(twice.drives).toEqual([{ name: "media", mountpoint: "/mnt/media", status: "current" }]);
  });

  it("leaves a marked entry alone when it is not a local drive at /mnt/<name>", () => {
    const content = [
      "# boxpilot:elsewhere", "UUID=a /srv/elsewhere ext4 defaults,nofail 0 2",
      "# boxpilot:nfsbox", "nas:/export /mnt/nfsbox nfs rw,nofail 0 0",
      "# boxpilot:netdev", "UUID=b /mnt/netdev ext4 defaults,nofail,_netdev 0 2",
      "# boxpilot:commented", "# UUID=c /mnt/commented ext4 defaults 0 2",
      "# boxpilot:short", "UUID=d /mnt/short",
      "",
    ].join("\n");
    const plan = planDockerOrder(content);
    expect(plan.changed).toBe(false);
    expect(plan.content).toBe(content);
    expect(plan.drives.map((drive) => [drive.name, drive.reason])).toEqual([
      ["elsewhere", "not mounted at /mnt/elsewhere"], ["nfsbox", "a network filesystem"], ["netdev", "a network filesystem"], ["commented", "not an fstab entry"], ["short", "not an fstab entry"],
    ]);
    expect(managedDriveEntries(content).every((entry) => entry.drive === false)).toBe(true);
  });

  it("reads findmnt --verify's count and lets through only what was already there", () => {
    expect(parseVerifySummary("...\n0 parse errors, 0 errors, 1 warning")).toEqual({ parseErrors: 0, errors: 0, warnings: 1 });
    expect(parseVerifySummary("1 parse error, 2 errors, 0 warnings")).toEqual({ parseErrors: 1, errors: 2, warnings: 0 });
    expect(parseVerifySummary("Success, no errors or warnings detected")).toBeNull();
    const clean = { ok: true, summary: { parseErrors: 0, errors: 0, warnings: 0 } };
    const unplugged = { ok: false, summary: { parseErrors: 0, errors: 1, warnings: 0 } };
    expect(verificationAllows(clean, clean)).toBe(true);
    expect(verificationAllows(unplugged, unplugged)).toBe(true);
    expect(verificationAllows(clean, unplugged)).toBe(false);
    expect(verificationAllows(unplugged, { ok: false, summary: { parseErrors: 0, errors: 2, warnings: 0 } })).toBe(false);
    expect(verificationAllows(unplugged, { ok: false, summary: { parseErrors: 1, errors: 0, warnings: 0 } })).toBe(false);
    expect(verificationAllows(unplugged, { ok: false, summary: null })).toBe(false);
  });
});

/** /etc/fstab and its neighbours in memory; rename is atomic like the real one. */
function fakeFiles(fstab = OWNER_FSTAB) {
  const disk = new Map([["/etc/fstab", fstab]]);
  const files = {
    disk,
    readFile: vi.fn(async (file) => { if (!disk.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return disk.get(file); }),
    writeFile: vi.fn(async (file, content, options) => { if (options?.flag === "wx" && disk.has(file)) throw new Error("EEXIST"); disk.set(file, content); }),
    rename: vi.fn(async (from, to) => { disk.set(to, disk.get(from)); disk.delete(from); }),
    unlink: vi.fn(async (file) => { disk.delete(file); }),
  };
  return files;
}

function systemdRun({ verify = {}, reloadFails = false, orderedUnits = null } = {}) {
  const calls = [];
  let reloads = 0;
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").pop();
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "findmnt" && args[0] === "--verify") {
      const outcome = verify[args[2]] ?? { ok: true, stdout: "0 parse errors, 0 errors, 0 warnings" };
      return { ok: outcome.ok, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
    }
    if (name === "systemctl" && args[0] === "daemon-reload") { reloads += 1; return reloadFails && reloads === 1 ? { ok: false, stdout: "", stderr: "Failed to reload" } : { ok: true, stdout: "", stderr: "" }; }
    if (name === "systemctl" && args[0] === "show") {
      const ordered = orderedUnits ?? [args.at(-1)];
      return { ok: true, stdout: ordered.includes(args.at(-1)) ? "docker.service umount.target" : "umount.target", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  return { run, calls };
}

const at = () => new Date("2026-09-28T12:00:00Z");

describe("giving existing drive entries the ordering", () => {
  it("backs up, verifies the new file before it replaces the old, reloads, and checks what systemd made of it", async () => {
    const files = fakeFiles();
    const { run, calls } = systemdRun();
    const result = await storageDockerOrder({}, { run, files, now: at });
    expect(result).toMatchObject({ changed: true, backup: "/etc/fstab.boxpilot-20260928T120000Z" });
    expect(files.disk.get("/etc/fstab.boxpilot-20260928T120000Z")).toBe(OWNER_FSTAB);
    expect(files.disk.get("/etc/fstab")).toContain(`/mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000,${ORDER} 0 0`);
    expect(files.disk.has("/etc/fstab.boxpilot-new")).toBe(false);
    expect(calls).toEqual([
      "findmnt --verify --tab-file /etc/fstab",
      "findmnt --verify --tab-file /etc/fstab.boxpilot-new",
      "systemctl daemon-reload",
      "systemctl show --property=Before --value mnt-the\\x2ddump.mount",
    ]);
    // The candidate was verified while it was still only a candidate.
    expect(files.rename).toHaveBeenCalledWith("/etc/fstab.boxpilot-new", "/etc/fstab");
  });

  it("writes nothing at all when every drive already has it", async () => {
    const files = fakeFiles(planDockerOrder(OWNER_FSTAB).content);
    const { run, calls } = systemdRun();
    await expect(storageDockerOrder({}, { run, files, now: at })).resolves.toMatchObject({ changed: false, backup: null });
    expect(files.writeFile).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("leaves fstab untouched when findmnt --verify rejects the new one", async () => {
    const files = fakeFiles();
    const { run, calls } = systemdRun({ verify: { "/etc/fstab.boxpilot-new": { ok: false, stdout: "[E] unsupported option\n0 parse errors, 1 error, 0 warnings" } } });
    await expect(storageDockerOrder({}, { run, files, now: at })).rejects.toThrow("left as it is");
    expect(files.disk.get("/etc/fstab")).toBe(OWNER_FSTAB);
    expect(files.disk.has("/etc/fstab.boxpilot-new")).toBe(false);
    expect(calls).not.toContain("systemctl daemon-reload");
  });

  it("goes ahead when findmnt complains exactly as it did about the current file (a drive unplugged right now)", async () => {
    const complaint = { ok: false, stdout: "[E] unreachable source\n0 parse errors, 1 error, 0 warnings" };
    const files = fakeFiles();
    const { run } = systemdRun({ verify: { "/etc/fstab": complaint, "/etc/fstab.boxpilot-new": complaint } });
    await expect(storageDockerOrder({}, { run, files, now: at })).resolves.toMatchObject({ changed: true });
  });

  it("puts the original back when daemon-reload fails", async () => {
    const files = fakeFiles();
    const { run, calls } = systemdRun({ reloadFails: true });
    await expect(storageDockerOrder({}, { run, files, now: at })).rejects.toThrow("put back as it was");
    expect(files.disk.get("/etc/fstab")).toBe(OWNER_FSTAB);
    expect(calls.filter((call) => call === "systemctl daemon-reload")).toHaveLength(2);
  });

  it("puts the original back when systemd does not show the drive ordered before Docker", async () => {
    const files = fakeFiles();
    const { run } = systemdRun({ orderedUnits: [] });
    await expect(storageDockerOrder({}, { run, files, now: at })).rejects.toThrow("did not order mnt-the\\x2ddump.mount before docker.service");
    expect(files.disk.get("/etc/fstab")).toBe(OWNER_FSTAB);
    expect(files.disk.get("/etc/fstab.boxpilot-20260928T120000Z")).toBe(OWNER_FSTAB);
  });
});

describe("reading the host", () => {
  it("reads the exFAT dirty flag from the boot sector, and nothing from anything else", () => {
    const sector = Buffer.alloc(512);
    sector.write("EXFAT   ", 3, "latin1");
    expect(exfatVolumeFlags(sector)).toEqual({ dirty: false, mediaFailure: false });
    sector[106] = 0x02;
    expect(exfatVolumeFlags(sector)).toEqual({ dirty: true, mediaFailure: false });
    sector[106] = 0x06;
    expect(exfatVolumeFlags(sector)).toEqual({ dirty: true, mediaFailure: true });
    const ext4 = Buffer.alloc(512);
    expect(exfatVolumeFlags(ext4)).toBeNull();
    expect(exfatVolumeFlags(null)).toBeNull();
  });

  it("reads containers, their stop signal and timeout, and the folders they bind, from docker inspect's JSON", () => {
    // Config.StopSignal and StopTimeout are simply absent when unset, as they were on the runner.
    const parsed = parseContainers(JSON.stringify([
      { Id: "abc", Name: "/bp-plex", State: { Pid: 4242 }, Config: { Image: "plex" }, Mounts: [{ Type: "bind", Source: "/mnt/the-dump/media" }, { Type: "bind", Source: "/opt/boxpilot/apps/plex/config" }] },
      { Id: "def", Name: "/bp-db", State: { Pid: 77 }, Config: { StopSignal: "SIGINT", StopTimeout: 30 }, Mounts: [{ Type: "volume", Name: "db", Source: "/var/lib/docker/volumes/db/_data" }] },
    ]));
    expect(parsed).toEqual([
      { id: "abc", name: "bp-plex", pid: 4242, stopSignal: "SIGTERM", stopTimeout: 10, sources: ["/mnt/the-dump/media", "/opt/boxpilot/apps/plex/config"] },
      { id: "def", name: "bp-db", pid: 77, stopSignal: "SIGINT", stopTimeout: 30, sources: ["/var/lib/docker/volumes/db/_data"] },
    ]);
    expect(parseContainers("not json")).toEqual([]);
    expect(parseContainers("")).toEqual([]);
    expect([stopSignalOf({ stopSignal: "SIGQUIT" }), stopSignalOf({ stopSignal: "quit" }), stopSignalOf({ stopSignal: "3" }), stopSignalOf({ stopSignal: "rm -rf" })]).toEqual(["SIGQUIT", "SIGQUIT", 3, "SIGTERM"]);
  });

  it("finds a filesystem still open in another mount namespace, once per namespace, never the host's", async () => {
    // pid 1 and 10 share the host's namespace, 20 and 21 are one container, 30 is a container
    // without the drive. Only the container that has it is named, and only once.
    const links = { "/proc/1/ns/mnt": "mnt:[1]", "/proc/10/ns/mnt": "mnt:[1]", "/proc/20/ns/mnt": "mnt:[2]", "/proc/21/ns/mnt": "mnt:[2]", "/proc/30/ns/mnt": "mnt:[3]" };
    const texts = {
      "/proc/1/mountinfo": "36 25 8:2 / /mnt/the-dump rw - exfat /dev/sda2 rw",
      "/proc/10/mountinfo": "36 25 8:2 / /mnt/the-dump rw - exfat /dev/sda2 rw",
      "/proc/20/mountinfo": "1 0 0:31 / / rw - overlay overlay rw\n900 800 8:2 / /data rw - exfat /dev/sda2 rw",
      "/proc/21/mountinfo": "900 800 8:2 / /data rw - exfat /dev/sda2 rw",
      "/proc/30/mountinfo": "1 0 0:32 / / rw - overlay overlay rw\n901 800 8:20 / /data rw - ext4 /dev/sdb4 rw",
      "/proc/20/comm": "qbittorrent-nox\n",
    };
    const fs = {
      readdir: async () => ["1", "10", "20", "21", "30", "self", "sys"],
      readlink: async (file) => { if (file in links) return links[file]; throw new Error("ENOENT"); },
      readFile: async (file) => { if (file in texts) return texts[file]; throw new Error("ENOENT"); },
    };
    await expect(hostView.namespaceHolders("8:2", { fs })).resolves.toEqual([{ pid: 20, command: "qbittorrent-nox" }]);
    await expect(hostView.namespaceHolders("8:9", { fs })).resolves.toEqual([]);
  });
});

/**
 * A server in memory for the reboot steps: fstab, what PID 1 has mounted, Docker and its
 * containers' processes, and a clock that moves only when something waits.
 */
function rebootHost({ fstab = OWNER_FSTAB, mounted = { "/mnt/the-dump": "/dev/sda2 exfat 8:2" }, containers = [], liveRestore = false, busy = {}, elsewhere = {}, dirty = false, dockerStops = true, ignoresSignal = [], smbConf = "", sharedUntilClosed = false } = {}) {
  let now = 0;
  const calls = [];
  const running = new Set(containers.map((container) => container.id));
  const signals = [];
  let closed = false;
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").pop();
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "findmnt") {
      const target = args.at(-1);
      return mounted[target] ? { ok: true, stdout: args.includes("SOURCE,FSTYPE,MAJ:MIN") ? mounted[target] : target, stderr: "" } : { ok: false, stdout: "", stderr: "" };
    }
    if (name === "docker" && args[0] === "ps") return { ok: true, stdout: containers.map((container) => container.id).join("\n"), stderr: "" };
    if (name === "docker" && args[0] === "inspect") {
      return { ok: true, stdout: JSON.stringify(containers.map((container) => ({ Id: container.id, Name: `/${container.name}`, State: { Pid: container.pid }, Config: { ...(container.stopSignal ? { StopSignal: container.stopSignal } : {}), ...(container.stopTimeout ? { StopTimeout: container.stopTimeout } : {}) }, Mounts: container.binds.map((source) => ({ Type: "bind", Source: source })) }))), stderr: "" };
    }
    if (name === "systemctl" && args[0] === "stop" && args.includes("docker.service")) {
      if (!dockerStops) return { ok: false, stdout: "", stderr: "Job for docker.service canceled" };
      if (!liveRestore) for (const container of containers) running.delete(container.id);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (name === "umount") {
      const target = args.at(-1);
      if (busy[target] && !(sharedUntilClosed && closed)) return { ok: false, stdout: "", stderr: `umount: ${target}: target is busy.` };
      // A container's bind is its own private copy of the mount, so the host's unmount succeeds
      // whether or not one is still running; `elsewhere` is how a test says one still is.
      delete mounted[target];
      return { ok: true, stdout: "", stderr: "" };
    }
    if (name === "smbstatus") return { ok: true, stdout: JSON.stringify({ tcons: { 1: { service: "Media", machine: "192.168.8.23" }, 2: { service: "Documents", machine: "192.168.8.40" } } }), stderr: "" };
    if (name === "smbcontrol") { closed = true; return { ok: true, stdout: "", stderr: "" }; }
    return { ok: true, stdout: "", stderr: "" };
  });
  const host = {
    running: vi.fn(async (container) => running.has(container.id)),
    signal: vi.fn((pid, signal) => {
      signals.push([pid, signal]);
      const container = containers.find((entry) => entry.pid === pid);
      if (container && (signal === "SIGKILL" || !ignoresSignal.includes(container.name))) running.delete(container.id);
      return true;
    }),
    namespaceHolders: vi.fn(async (majMin) => elsewhere[majMin] ?? []),
    processesUsing: vi.fn(async () => Object.values(busy).flat()),
    bootSector: vi.fn(async () => { const sector = Buffer.alloc(512); sector.write("EXFAT   ", 3, "latin1"); sector[106] = dirty ? 2 : 0; return sector; }),
  };
  const log = vi.fn();
  return {
    calls, signals, running, host, log,
    options: { run, log, host, files: { readFile: async (file) => (file === "/etc/samba/smb.conf" ? smbConf : fstab) }, clock: () => now, sleep: async (ms) => { now += ms; } },
  };
}

const plex = { id: "a".repeat(64), name: "bp-plex", pid: 4242, binds: ["/mnt/the-dump/media", "/opt/boxpilot/apps/plex/config"] };
const qbit = { id: "b".repeat(64), name: "bp-qbittorrent", pid: 4343, stopTimeout: 20, binds: ["/mnt/the-dump/downloads"] };
const pihole = { id: "c".repeat(64), name: "bp-pihole", pid: 4444, binds: ["/opt/boxpilot/apps/pihole/etc"] };

describe("getting the drives ready before a reboot", () => {
  it("stops Docker, syncs, unmounts each drive in the host's namespace and says it let go", async () => {
    const server = rebootHost({ containers: [plex, pihole] });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(server.calls).toEqual([
      "findmnt --task 1 -n -o SOURCE,FSTYPE,MAJ:MIN --mountpoint /mnt/the-dump",
      "docker ps -q --no-trunc",
      expect.stringMatching(/^docker inspect a{64} c{64}$/),
      "systemctl stop docker.socket docker.service",
      "sync ",
      "umount -N /proc/1/ns/mnt /mnt/the-dump",
      "findmnt --task 1 -n --mountpoint /mnt/the-dump",
    ]);
    // Not `docker stop`: that marks a container stopped by hand, and an unless-stopped app would stay down after the reboot.
    expect(server.calls.some((call) => call.startsWith("docker stop") || call.startsWith("docker kill"))).toBe(false);
    expect(server.signals).toEqual([]);
    expect(summary).toMatchObject({ dockerStopped: true, containers: { stopped: ["bp-plex"], signalled: [], killed: [], stillRunning: [] } });
    expect(summary.drives).toEqual([expect.objectContaining({ mountpoint: "/mnt/the-dump", state: "unmounted", holders: [], volumeDirty: false })]);
    expect(server.log).toHaveBeenCalledWith("/mnt/the-dump unmounted cleanly", "stdout");
  });

  it("with live-restore on, sends the containers still running their own stop signal, then kills one that outstays its timeout", async () => {
    const server = rebootHost({ containers: [plex, { ...qbit, stopSignal: "SIGINT" }], liveRestore: true, ignoresSignal: ["bp-qbittorrent"] });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(server.signals).toEqual([[4242, "SIGTERM"], [4343, "SIGINT"], [4343, "SIGKILL"]]);
    expect(summary.containers).toEqual({ stopped: ["bp-plex"], signalled: ["bp-plex", "bp-qbittorrent"], killed: ["bp-qbittorrent"], stillRunning: [] });
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining("kept running after Docker stopped (live-restore is on)"), "stdout");
    expect(summary.drives[0].state).toBe("unmounted");
  });

  it("leaves Docker running when no container uses a drive", async () => {
    const server = rebootHost({ containers: [pihole] });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(server.calls).not.toContain("systemctl stop docker.socket docker.service");
    expect(summary.dockerStopped).toBe(false);
    expect(summary.drives[0].state).toBe("unmounted");
  });

  // The UPS's shutdown on a low battery (M39.1): the same steps, every app, and its own words.
  it("before a power-off, stops Docker for every app, not only those on a drive, and says the shutdown", async () => {
    const server = rebootHost({ containers: [pihole] });
    const summary = await prepareDrivesForReboot({}, { ...server.options, allContainers: true, occasion: "shutdown" });
    expect(server.calls).toContain("systemctl stop docker.socket docker.service");
    expect(summary).toMatchObject({ dockerStopped: true, containers: { stopped: ["bp-pihole"] } });
    expect(summary.drives[0].state).toBe("unmounted");
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining("their restart policies start them again when the server starts"), "stdout");
  });

  it("before a power-off with no drive mounted, still stops the apps and syncs", async () => {
    const server = rebootHost({ mounted: {}, containers: [pihole] });
    const summary = await prepareDrivesForReboot({}, { ...server.options, allContainers: true, occasion: "shutdown" });
    expect(server.calls).toEqual([
      "findmnt --task 1 -n -o SOURCE,FSTYPE,MAJ:MIN --mountpoint /mnt/the-dump",
      "docker ps -q --no-trunc",
      expect.stringMatching(/^docker inspect c{64}$/),
      "systemctl stop docker.socket docker.service",
      "sync ",
    ]);
    expect(summary.containers.stopped).toEqual(["bp-pihole"]);
    expect(server.log).toHaveBeenCalledWith("No BoxPilot drive is mounted; nothing to unmount before the shutdown", "stdout");
  });

  it("stops Docker for a container bound to a folder above a drive, which carries the drive with it", async () => {
    // node-exporter binds / and File Browser /mnt: Docker's binds are recursive, so each holds
    // /mnt/the-dump in its own namespace however the host unmounts it.
    const nodeExporter = { id: "d".repeat(64), name: "bp-node-exporter", pid: 4545, binds: ["/proc", "/sys", "/"] };
    const fileBrowser = { id: "e".repeat(64), name: "bp-filebrowser", pid: 4646, binds: ["/mnt"] };
    const sibling = { id: "f".repeat(64), name: "bp-backup", pid: 4747, binds: ["/mnt/the-dump-backup"] };
    for (const holder of [nodeExporter, fileBrowser]) {
      const server = rebootHost({ containers: [pihole, holder, sibling] });
      const summary = await prepareDrivesForReboot({}, server.options);
      expect(server.calls).toContain("systemctl stop docker.socket docker.service");
      expect(summary.containers.stopped).toEqual([holder.name]);
    }
    const unrelated = rebootHost({ containers: [pihole, sibling] });
    expect((await prepareDrivesForReboot({}, unrelated.options)).dockerStopped).toBe(false);
  });

  it("does nothing at all when no BoxPilot drive is mounted", async () => {
    const server = rebootHost({ mounted: {}, containers: [plex] });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(server.calls).toEqual(["findmnt --task 1 -n -o SOURCE,FSTYPE,MAJ:MIN --mountpoint /mnt/the-dump"]);
    expect(summary.drives[0]).toMatchObject({ state: "not-mounted" });
  });

  it("names what holds a drive that will not unmount", async () => {
    const server = rebootHost({ containers: [plex], busy: { "/mnt/the-dump": [{ pid: 5678, command: "smbd" }, { pid: 1234, command: "bash" }] } });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(summary.drives[0]).toMatchObject({ state: "busy", holders: [{ pid: 5678, command: "smbd" }, { pid: 1234, command: "bash" }] });
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining("/mnt/the-dump did not unmount (umount: /mnt/the-dump: target is busy); it is in use by smbd (5678), bash (1234). The reboot stops those"), "stderr");
  });

  it("gets file-sharing clients off a drive that is also a share, then unmounts it", async () => {
    // The owner's server: a Windows PC with the share mapped kept smbd holding the drive, and
    // reconnected within a second of close-share, so the unmount has to follow it straight away.
    const smbConf = "[global]\n   workgroup = WORKGROUP\n[Media]\n   path = /mnt/the-dump/media\n[Documents]\n   path = /srv/documents\n";
    const server = rebootHost({ containers: [plex], smbConf, sharedUntilClosed: true, busy: { "/mnt/the-dump": [{ pid: 5678, command: "smbd" }] } });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(summary.drives[0].state).toBe("unmounted");
    const umounts = server.calls.filter((call) => call.startsWith("umount"));
    expect(umounts).toHaveLength(2);
    expect(server.calls.indexOf("smbcontrol smbd close-share Media")).toBeLessThan(server.calls.lastIndexOf("umount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(server.calls).not.toContain("smbcontrol smbd close-share Documents");
    expect(server.log).toHaveBeenCalledWith("Closed file-sharing connections from 192.168.8.23 to Media so /mnt/the-dump could be unmounted", "stdout");
  });

  it("keeps trying while a client keeps reconnecting, thirty times, then says who held on", async () => {
    const smbConf = "[Media]\n   path = /mnt/the-dump\n";
    const server = rebootHost({ containers: [plex], smbConf, busy: { "/mnt/the-dump": [{ pid: 5678, command: "smbd" }] } });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(server.calls.filter((call) => call === "smbcontrol smbd close-share Media")).toHaveLength(30);
    expect(summary.drives[0]).toMatchObject({ state: "busy", holders: [{ pid: 5678, command: "smbd" }] });
  });

  it("does not call a drive unmounted while another namespace still has it open", async () => {
    const server = rebootHost({ containers: [plex], elsewhere: { "8:2": [{ pid: 999, command: "rsync" }] } });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(summary.drives[0]).toMatchObject({ state: "busy", holders: [{ pid: 999, command: "rsync" }] });
    expect(server.host.bootSector).not.toHaveBeenCalled();
  });

  it("says when an exFAT drive still carries the dirty mark after a clean unmount", async () => {
    const server = rebootHost({ containers: [plex], dirty: true });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(summary.drives[0]).toMatchObject({ state: "unmounted", volumeDirty: true });
    expect(server.host.bootSector).toHaveBeenCalledWith("/dev/sda2");
    expect(server.log).toHaveBeenCalledWith(expect.stringContaining("Linux keeps that mark until a repairing check clears it"), "stderr");
  });

  it("does not signal containers when Docker would not stop, since it would only restart them", async () => {
    const server = rebootHost({ containers: [plex], liveRestore: true, dockerStops: false });
    const summary = await prepareDrivesForReboot({}, server.options);
    expect(server.signals).toEqual([]);
    expect(summary.containers.stillRunning).toEqual(["bp-plex"]);
  });

  it("stays inside its budget however long each step takes", async () => {
    const server = rebootHost({ containers: [plex], liveRestore: true, ignoresSignal: ["bp-plex"] });
    const summary = await prepareDrivesForReboot({}, { ...server.options, budgetMs: 3_000 });
    // Three seconds of the ten-second stop timeout, then the kill; the drive step is skipped once time is up.
    expect(server.signals).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    expect(summary.drives[0].state).toBe("out-of-time");
  });
});

describe("the reboot itself", () => {
  it("gets the drives ready before it schedules the reboot", async () => {
    const order = [];
    const run = vi.fn(async (binary) => { order.push(binary.split("/").pop()); return { ok: true, stdout: "", stderr: "" }; });
    const prepare = vi.fn(async () => { order.push("prepare"); return { drives: [{ mountpoint: "/mnt/the-dump", state: "unmounted", holders: [], volumeDirty: false, unit: "x" }], containers: { stopped: ["bp-plex"], signalled: [], killed: [], stillRunning: [] }, dockerStopped: true }; });
    const result = await systemReboot({ delaySeconds: 5 }, { run, prepare });
    expect(order).toEqual(["prepare", "systemd-run"]);
    expect(result).toEqual({ scheduled: true, inSeconds: 5, drives: [{ mountpoint: "/mnt/the-dump", state: "unmounted", holders: [], volumeDirty: false }], containers: { stopped: ["bp-plex"], signalled: [], killed: [], stillRunning: [] } });
  });

  it("reboots anyway when getting the drives ready fails", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const log = vi.fn();
    const result = await systemReboot({}, { run, log, prepare: async () => { throw new Error("fstab unreadable"); } });
    expect(result).toMatchObject({ scheduled: true, inSeconds: 5, drives: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rebooting anyway"), "stderr");
  });

  it("mounts the drives again and starts Docker when the reboot cannot be scheduled", async () => {
    // Unmounted a moment ago, outside systemd: the kernel's table says so, the unit does not yet.
    const host = laggingSystemd({ mounted: null, unitActive: true, lagMs: 300 });
    const run = vi.fn(async (binary, args, options) => (binary.endsWith("systemd-run") ? { ok: false, stdout: "", stderr: "Failed to connect to bus" } : host.run(binary, args, options)));
    const resume = (summary, options) => resumeAfterCancelledReboot(summary, { ...options, sleep: host.sleep, clock: host.clock });
    await expect(systemReboot({}, { run, log: host.log, prepare: async () => prepared(), resume })).rejects.toThrow("Could not schedule the reboot: Failed to connect to bus. The drives were mounted again and Docker was started.");
    const starts = host.calls.filter((call) => call.startsWith("systemctl start"));
    expect(starts).toEqual(["systemctl start mnt-the\\x2ddump.mount", "systemctl start docker.socket docker.service"]);
    expect(host.state).toMatchObject({ mounted: "/dev/sda2", dockerActive: true });
    expect(host.log).toHaveBeenCalledWith("Mounted /mnt/the-dump again, from /dev/sda2", "stdout");
  });
});

/** What the preparation reports for the owner's drive, unmounted cleanly (or otherwise). */
const prepared = (drive = {}) => ({
  drives: [{ name: "the-dump", mountpoint: "/mnt/the-dump", unit: "mnt-the\\x2ddump.mount", entrySource: "UUID=0023-7927", source: "/dev/sda2", fstype: "exfat", majMin: "8:2", mounted: true, state: "unmounted", holders: [], volumeDirty: false, ...drive }],
  containers: { stopped: ["bp-plex"], signalled: [], killed: [], stillRunning: [] },
  dockerStopped: true,
});

describe("putting things back when the reboot cannot be scheduled", () => {
  const resume = (host, summary = prepared()) => resumeAfterCancelledReboot(summary, { run: host.run, log: host.log, sleep: host.sleep, clock: host.clock });

  it("waits for systemd to see the drive unmounted before starting it, where a start would have done nothing", async () => {
    // The race: the unit still says mounted, so a start at once is a no-op that exits 0, and
    // Docker then starts every app on the empty folder. This used to log "Mounted ... again".
    const host = laggingSystemd({ mounted: null, unitActive: true, lagMs: 400 });
    const result = await resume(host);
    expect(result).toEqual({ drives: [{ mountpoint: "/mnt/the-dump", ok: true, remounted: true, source: "/dev/sda2", reason: null }], docker: "started", dockerError: null, missing: [] });
    const lastLook = host.calls.lastIndexOf("systemctl show mnt-the\\x2ddump.mount --property=ActiveState,SubState");
    expect(host.calls.indexOf("systemctl start mnt-the\\x2ddump.mount")).toBeGreaterThan(lastLook);
    expect(host.calls.filter((call) => call === "systemctl start mnt-the\\x2ddump.mount")).toHaveLength(1);
    expect(host.calls.indexOf("systemctl start docker.socket docker.service")).toBeGreaterThan(host.calls.indexOf("systemctl start mnt-the\\x2ddump.mount"));
    expect(host.log).toHaveBeenCalledWith(expect.stringMatching(/^systemd took \d+ ms to see \/mnt\/the-dump unmounted$/), "stdout");
  });

  it("leaves Docker stopped, and says why, when a drive does not mount again", async () => {
    const host = laggingSystemd({ mounted: null, unitActive: false, starts: [{ fails: "A dependency job for mnt-the\\x2ddump.mount failed. See 'journalctl -xe' for details." }] });
    const result = await resume(host);
    expect(result).toMatchObject({ docker: "left-stopped", missing: ["/mnt/the-dump"], drives: [{ ok: false, remounted: false }] });
    expect(host.calls).not.toContain("systemctl start docker.socket docker.service");
    expect(host.state.dockerActive).toBe(false);
    expect(host.log).toHaveBeenCalledWith("Docker was left stopped, so no app starts on the empty folder at /mnt/the-dump and writes to the system disk", "stderr");
    expect(host.log).not.toHaveBeenCalledWith(expect.stringContaining("Mounted /mnt/the-dump again"), "stdout");
  });

  it("leaves Docker stopped when systemd keeps saying started and nothing mounts", async () => {
    const host = laggingSystemd({ mounted: null, unitActive: true, lagMs: 60_000 });
    const result = await resumeAfterCancelledReboot(prepared(), { run: host.run, log: host.log, sleep: host.sleep, clock: host.clock, settleMs: 500 });
    expect(result).toMatchObject({ docker: "left-stopped", drives: [{ ok: false, reason: "systemd said mnt-the\\x2ddump.mount started, twice, but nothing is mounted at /mnt/the-dump" }] });
    expect(host.state.dockerActive).toBe(false);
  });

  it("mounts a drive reported busy because a container still had it: the host's mount is gone all the same", async () => {
    const host = laggingSystemd({ mounted: null, unitActive: false });
    const result = await resume(host, prepared({ state: "busy", holders: [{ pid: 999, command: "rsync" }] }));
    expect(result).toMatchObject({ docker: "started", drives: [{ ok: true, remounted: true }] });
  });

  it("starts nothing for a drive that never let go, and nothing for one that was not mounted", async () => {
    const busy = laggingSystemd({ mounted: "/dev/sda2" });
    expect(await resume(busy, prepared({ state: "busy" }))).toMatchObject({ docker: "started", drives: [{ ok: true, remounted: false }] });
    expect(busy.calls).not.toContain("systemctl start mnt-the\\x2ddump.mount");
    const absent = laggingSystemd();
    expect(await resume(absent, { ...prepared({ mounted: false, source: null, state: "not-mounted" }), dockerStopped: false })).toEqual({ drives: [], docker: "untouched", dockerError: null, missing: [] });
    expect(absent.calls).toEqual([]);
  });

  it("takes the drive back under the name its fstab entry has now, and nothing else", async () => {
    // Unplugged and back within the seconds of a cancelled reboot: sda2 is sdb2 now.
    const moved = laggingSystemd({ blkid: { "0023-7927": "/dev/sdb2" }, starts: [{ mounts: "/dev/sdb2" }] });
    expect(await resume(moved)).toMatchObject({ docker: "started", drives: [{ ok: true, source: "/dev/sdb2" }] });
    const other = laggingSystemd({ blkid: { "0023-7927": "/dev/sda2" }, starts: [{ mounts: "/dev/sdc1" }] });
    expect(await resume(other)).toMatchObject({ docker: "left-stopped", drives: [{ ok: false, reason: "/mnt/the-dump is mounted from /dev/sdc1, not from /dev/sda2" }] });
  });

  it("says in the reboot's error what putting things back did, never assuming it worked", () => {
    const back = { mountpoint: "/mnt/the-dump", ok: true, remounted: true };
    const lost = { mountpoint: "/mnt/the-dump", ok: false, remounted: false, reason: "systemctl start mnt-the\\x2ddump.mount failed: A dependency job failed." };
    expect(afterResume(null)).toBe("");
    expect(afterResume({ drives: [back], docker: "started" })).toBe(". The drives were mounted again and Docker was started.");
    expect(afterResume({ drives: [back], docker: "untouched" })).toBe(". The drives were mounted again.");
    expect(afterResume({ drives: [], docker: "started" })).toBe(". Docker was started again.");
    expect(afterResume({ drives: [], docker: "untouched" })).toBe("");
    expect(afterResume({ drives: [lost], docker: "left-stopped" })).toBe(". /mnt/the-dump did not mount again (systemctl start mnt-the\\x2ddump.mount failed: A dependency job failed), so Docker was left stopped and no app writes into the empty folder instead. Reconnect the drive from Repair, then start docker.service from Services, or reboot.");
    expect(afterResume({ drives: [lost], docker: "untouched" })).toBe(". /mnt/the-dump did not mount again (systemctl start mnt-the\\x2ddump.mount failed: A dependency job failed). Reconnect the drive from Repair, or reboot.");
    expect(afterResume({ drives: [back], docker: "failed", dockerError: "Job for docker.service failed." })).toBe(". The drives were mounted again, but Docker did not start again (Job for docker.service failed); start docker.service from Services.");
    expect(afterResume({ error: new Error("fstab unreadable") })).toBe(". Putting the drives and Docker back failed as well (fstab unreadable); reconnect the drives from Repair and start docker.service from Services, or reboot.");
  });
});

describe("what each drive's filesystem says about its last unmount", () => {
  const fstab = `${OWNER_FSTAB}# boxpilot:media\nUUID=aaaa-bbbb /mnt/media ext4 defaults,nofail 0 2\n# boxpilot:spare\nUUID=1234-ABCD /mnt/spare exfat defaults,nofail 0 0\n`;
  const sector = (dirty) => { const bytes = Buffer.alloc(512); bytes.write("EXFAT   ", 3, "latin1"); bytes[106] = dirty ? 2 : 0; return bytes; };

  it("reads the exFAT mark from the boot sector and ext4's state from its superblock, with when each mount began", async () => {
    const calls = [];
    const run = vi.fn(async (binary, args) => {
      const name = binary.split("/").pop();
      calls.push(`${name} ${args.join(" ")}`);
      if (name === "findmnt" && args.at(-1) === "/mnt/the-dump") return { ok: true, stdout: "/dev/sda2 exfat", stderr: "" };
      if (name === "findmnt" && args.at(-1) === "/mnt/media") return { ok: true, stdout: "/dev/sdb1 ext4", stderr: "" };
      if (name === "findmnt") return { ok: false, stdout: "", stderr: "" };
      if (name === "blkid") return { ok: true, stdout: "/dev/sdc1", stderr: "" };
      if (name === "systemctl" && args.at(-1) === "mnt-the\\x2ddump.mount") return { ok: true, stdout: "Mon 2026-09-28 19:00:00 UTC", stderr: "" };
      if (name === "systemctl") return { ok: true, stdout: "Mon 2026-09-28 18:26:40 UTC", stderr: "" };
      if (name === "dumpe2fs") return { ok: true, stdout: "Filesystem volume name:   media\nFilesystem state:         clean with errors\nErrors behavior:          Continue\n", stderr: "dumpe2fs 1.47.0 (5-Feb-2023)" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const readSector = vi.fn(async (device) => sector(device === "/dev/sda2"));
    const state = await storageVolumeState({}, { run, files: { readFile: async () => fstab }, readSector, now: () => new Date("2026-09-28T20:00:00Z") });
    expect(state).toEqual({
      available: true, readAt: "2026-09-28T20:00:00.000Z",
      drives: [
        { name: "the-dump", mountpoint: "/mnt/the-dump", device: "/dev/sda2", fstype: "exfat", mounted: true, mountedAt: "2026-09-28T19:00:00.000Z", exfat: { dirty: true }, ext: null },
        { name: "media", mountpoint: "/mnt/media", device: "/dev/sdb1", fstype: "ext4", mounted: true, mountedAt: "2026-09-28T18:26:40.000Z", exfat: null, ext: { state: "clean with errors" } },
        // Not mounted: found by its UUID, and its mark is exact, since nothing can have written to it since.
        { name: "spare", mountpoint: "/mnt/spare", device: "/dev/sdc1", fstype: "exfat", mounted: false, mountedAt: null, exfat: { dirty: false }, ext: null },
      ],
    });
    expect(calls).toContain("systemctl show --timestamp=utc --property=ActiveEnterTimestamp --value mnt-the\\x2ddump.mount");
    expect(calls).toContain("dumpe2fs -h /dev/sdb1");
    // Read only: nothing mounted, unmounted or written.
    expect(calls.some((call) => /^(u?mount|fsck|e2fsck|tune2fs) /.test(call))).toBe(false);
  });

  it("reads when a mount began from systemctl show --timestamp=utc", () => {
    // systemd 249 (Ubuntu 22.04), 255 (24.04) and 259 (26.04) alike, on the runners.
    expect(parseSystemdUtcTimestamp("Tue 2026-09-29 23:15:01 UTC\n")).toBe("2026-09-29T23:15:01.000Z");
    // Never active: 249 says n/a, 255 and 259 say nothing.
    expect(parseSystemdUtcTimestamp("n/a")).toBeNull();
    expect(parseSystemdUtcTimestamp("")).toBeNull();
    // Local time, which is systemd's default, names a zone this cannot place.
    expect(parseSystemdUtcTimestamp("Wed 2026-09-30 01:15:01 CEST")).toBeNull();
    // 249's answer to --timestamp=unix, which is systemd 251's.
    expect(parseSystemdUtcTimestamp("Invalid value: unix.")).toBeNull();
  });

  it("reads the superblock's state line", () => {
    expect(parseExtState("Filesystem state:         not clean\n")).toBe("not clean");
    expect(parseExtState("Filesystem state:         clean\nErrors behavior: Continue")).toBe("clean");
    expect(parseExtState("")).toBeNull();
  });
});

