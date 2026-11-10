import { describe, expect, it } from "vitest";
import { inventoryFactsFrom, type InventoryFacts } from "../../home/facts";
import { fitRows, fitVerdict, heldPorts, heldWords, holdsData, mountFor, needsSettingsFirst, nextFreePort, relocatePorts, startsWords, whereItAnswers, type FitRow, type PortReading } from "./preflight";
import type { Entry, Manifest } from "./types";

// "Will it fit" (2026-11-10): what an install takes, from figures the product already has. These
// hold the arithmetic and, more than that, what it says when a figure is missing.

const GiB = 1024 ** 3;
const mount = (target: string, totalGiB: number, usedGiB: number) => {
  const usedPercent = Math.round((usedGiB / totalGiB) * 100);
  return { target, source: "/dev/sdx", totalBytes: totalGiB * GiB, usedBytes: usedGiB * GiB, usedPercent, capacityState: usedPercent >= 95 ? "critical" : usedPercent >= 85 ? "warning" : "healthy" };
};
/** The inventory as the server sends it, read by the reader Home uses. */
function inventory({ memoryTotal = 32, memoryUsed = 11, mounts = [mount("/", 100, 27)] }: { memoryTotal?: number; memoryUsed?: number; mounts?: Array<ReturnType<typeof mount>> } = {}): InventoryFacts {
  const root = mounts.find((entry) => entry.target === "/");
  return inventoryFactsFrom({
    host: { hostname: "homebox", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0", uptimeSeconds: 90_000 },
    compute: { cpuCount: 8, cpuModel: "fixture", load1: 0.5, loadPercent: 6, totalMemoryBytes: memoryTotal * GiB, usedMemoryBytes: memoryUsed * GiB, memoryUsedPercent: memoryTotal ? Math.round((memoryUsed / memoryTotal) * 100) : 0 },
    storage: { root: root ? { totalBytes: root.totalBytes, usedBytes: root.usedBytes, usedPercent: root.usedPercent } : null, filesystems: { mounts } },
    network: { addresses: [], tailscale: { installed: true, connected: true, dnsName: null } },
  });
}

const volume = (extra: Partial<Manifest["volumes"][number]>): Manifest["volumes"][number] => ({ id: "data", label: "Data", container: "/data", path: "data", hostPath: null, readOnly: false, backup: true, configurable: false, description: null, ...extra });
const port = (extra: Partial<Manifest["ports"][number]> = {}): Manifest["ports"][number] => ({ id: "web", label: "Web UI", container: 8000, host: 8000, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "serve", ...extra });
function app(extra: Partial<Manifest> = {}): Manifest {
  return {
    id: "paperless-ngx", name: "Paperless-ngx", category: "Documents", description: "Files your paper.", website: null, icon: null, risk: "medium", notes: null,
    image: { reference: "paperless:2", version: "2", digestPinned: false },
    ports: [port()],
    volumes: [volume({}), volume({ id: "documents", label: "Documents", container: "/documents", path: null, hostPath: "/mnt/media/documents", backup: false, configurable: true })],
    env: [], health: { kind: "running", stableSeconds: 10, timeoutSeconds: 180 }, network: "bridge", sidecars: [{ id: "db", volumes: [{ path: "db", backup: true }] }, { id: "broker" }], sha256: "a",
    ...extra,
  };
}
const formOf = (manifest: Manifest, extra: Partial<{ ports: Record<string, number>; volumes: Record<string, string>; networkMode: string }> = {}) => ({
  ports: Object.fromEntries(manifest.ports.map((entry) => [entry.id, entry.host])),
  volumes: Object.fromEntries(manifest.volumes.filter((entry) => entry.configurable).map((entry) => [entry.id, entry.hostPath ?? ""])),
  env: {},
  ...extra,
});
const clear: PortReading = { state: "read", conflicts: [], moved: {} };
const row = (rows: FitRow[], id: string) => { const found = rows.find((entry) => entry.id === id); if (!found) throw new Error(`no row ${id} in ${rows.map((entry) => entry.id).join(", ")}`); return found; };
const cells = (entry: FitRow) => [entry.item, entry.usedNow, entry.adds, entry.leftAfter, entry.check];

describe("what an install takes", () => {
  it("passes every row when there is plenty of room, and says what is left after", () => {
    const manifest = app({ needs: { memoryMb: 1229, diskMb: 1946 } });
    const rows = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 1200)] }), ports: clear });
    expect(rows.map(cells)).toEqual([
      ["Memory", "11.0 GB", "+ 1.2 GB", "19.8 GB of 32.0 GB", "pass"],
      ["System disk", "27.0 GB", "+ 1.9 GB", "71.1 GB of 100.0 GB", "pass"],
      ["/mnt/media", "1.2 TB", "not stated", "2.7 TB of 3.9 TB", "pass"],
      ["Port", "8000 is free", "takes 8000", "no clash", "pass"],
    ]);
    // The bar is how full it is after the install; a port has none.
    expect(row(rows, "memory").scale).toEqual({ percent: 38, words: "38 percent of 32.0 GB in use after install", status: "good" });
    expect(row(rows, "disk:/").scale?.percent).toBe(29);
    expect(row(rows, "port:web").scale).toBeNull();
    expect(rows.every((entry) => entry.note === null)).toBe(true);
    expect(fitVerdict(rows)).toEqual({ status: "good", label: "Fits", summary: null });
  });

  it("is a caution when memory would be thin after it: 85% in use, the line Home draws amber from", () => {
    const manifest = app({ needs: { memoryMb: 4096, diskMb: null } });
    // 22 of 32 GB in use is 69%: fine now. With 4 GB more it is 81%: still fine. With 6 it is 88%.
    expect(row(fitRows({ manifest, values: formOf(manifest), inventory: inventory({ memoryUsed: 22 }), ports: clear }), "memory").check).toBe("pass");
    const thin = app({ needs: { memoryMb: 6144, diskMb: null } });
    const rows = fitRows({ manifest: thin, values: formOf(thin), inventory: inventory({ memoryUsed: 22 }), ports: clear });
    expect(cells(row(rows, "memory"))).toEqual(["Memory", "22.0 GB", "+ 6.0 GB", "4.0 GB of 32.0 GB", "caution"]);
    expect(row(rows, "memory").note).toBe("Memory would be 88% in use after this, with 4.0 GB left.");
    expect(row(rows, "memory").scale?.status).toBe("warning");
    expect(fitVerdict(rows)).toMatchObject({ status: "warning", label: "Fits, 1 caution" });
    // Exactly on the line counts, as it does on Home.
    const onTheLine = app({ needs: { memoryMb: 1024, diskMb: null } });
    expect(row(fitRows({ manifest: onTheLine, values: formOf(onTheLine), inventory: inventory({ memoryTotal: 100, memoryUsed: 84 }), ports: clear }), "memory").check).toBe("caution");
    expect(row(fitRows({ manifest: onTheLine, values: formOf(onTheLine), inventory: inventory({ memoryTotal: 100, memoryUsed: 83 }), ports: clear }), "memory").check).toBe("pass");
  });

  it("does not fit when it states more memory or disk than is free", () => {
    const manifest = app({ needs: { memoryMb: 8192, diskMb: 20 * 1024 } });
    const rows = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ memoryUsed: 28, mounts: [mount("/", 100, 90), mount("/mnt/media", 4000, 1200)] }), ports: clear });
    expect(cells(row(rows, "memory"))).toEqual(["Memory", "28.0 GB", "+ 8.0 GB", "4.0 GB short of 32.0 GB", "fail"]);
    expect(row(rows, "memory").note).toBe("Memory: it states 8.0 GB and 4.0 GB is free.");
    expect(cells(row(rows, "disk:/"))).toEqual(["System disk", "90.0 GB", "+ 20.0 GB", "10.0 GB short of 100.0 GB", "fail"]);
    expect(fitVerdict(rows)).toEqual({ status: "danger", label: "Does not fit", summary: null });
  });

  it("is a caution when a disk is thin: the system disk after what it adds, a data drive as it is now", () => {
    const manifest = app({ needs: { memoryMb: null, diskMb: 10 * 1024 } });
    const rows = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ mounts: [mount("/", 100, 78), mount("/mnt/media", 4000, 3520)] }), ports: clear });
    expect(cells(row(rows, "disk:/"))).toEqual(["System disk", "78.0 GB", "+ 10.0 GB", "12.0 GB of 100.0 GB", "caution"]);
    expect(row(rows, "disk:/").note).toBe("System disk would be 88% full after this, with 12.0 GB left.");
    // The drive its documents go to is 88% full already; nothing is stated about what it adds there.
    expect(cells(row(rows, "disk:/mnt/media"))).toEqual(["/mnt/media", "3.4 TB", "not stated", "480.0 GB of 3.9 TB", "caution"]);
    expect(row(rows, "disk:/mnt/media").note).toBe("/mnt/media is 88% full already, before anything this app keeps there.");
    expect(fitVerdict(rows).label).toBe("Fits, 2 cautions");
  });

  it("uses Storage's forecast for a drive when there is one, and warns inside its fourteen days", () => {
    const manifest = app();
    const stock = inventory({ mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 2720)] });
    const far = fitRows({ manifest, values: formOf(manifest), inventory: stock, forecasts: [{ target: "/mnt/media", daysToFull: 77 }], ports: clear });
    expect(row(far, "disk:/mnt/media")).toMatchObject({ leftHint: "~77 days left at the rate it has been filling", check: "pass", note: null });
    const soon = fitRows({ manifest, values: formOf(manifest), inventory: stock, forecasts: [{ target: "/mnt/media", daysToFull: 9 }], ports: clear });
    expect(row(soon, "disk:/mnt/media")).toMatchObject({ leftHint: "~9 days left at the rate it has been filling", check: "caution", note: "/mnt/media is on track to fill in about 9 days, at the rate free space has been dropping." });
    // No forecast, or one past the ninety days Storage shows: nothing is said about filling.
    expect(row(fitRows({ manifest, values: formOf(manifest), inventory: stock, forecasts: [{ target: "/mnt/media", daysToFull: 400 }], ports: clear }), "disk:/mnt/media").leftHint).toBeNull();
    expect(row(fitRows({ manifest, values: formOf(manifest), inventory: stock, forecasts: null, ports: clear }), "disk:/mnt/media").leftHint).toBeNull();
  });

  it("says \"not stated\" when the manifest declares nothing, and checks on what is free now alone", () => {
    const manifest = app();
    expect(manifest.needs).toBeUndefined();
    const roomy = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 1200)] }), ports: clear });
    expect(cells(row(roomy, "memory"))).toEqual(["Memory", "11.0 GB", "not stated", "21.0 GB of 32.0 GB", "pass"]);
    expect(row(roomy, "memory").scale?.words).toBe("34 percent of 32.0 GB in use now");
    expect(cells(row(roomy, "disk:/"))).toEqual(["System disk", "27.0 GB", "not stated", "73.0 GB of 100.0 GB", "pass"]);
    expect(fitVerdict(roomy).label).toBe("Fits");
    // Thin already: a caution on what is there now, and the note does not pretend to know what it adds.
    const tight = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ memoryUsed: 29, mounts: [mount("/", 100, 96), mount("/mnt/media", 4000, 1200)] }), ports: clear });
    expect(row(tight, "memory")).toMatchObject({ check: "caution", note: "Memory is 91% in use already; what this adds is not stated." });
    expect(row(tight, "disk:/")).toMatchObject({ check: "caution", note: "System disk is 96% full already; what this adds is not stated." });
    // One figure stated, the other not.
    const half = app({ needs: { memoryMb: 512, diskMb: null } });
    const mixed = fitRows({ manifest: half, values: formOf(half), inventory: inventory(), ports: clear });
    expect([row(mixed, "memory").adds, row(mixed, "disk:/").adds]).toEqual(["+ 512 MB", "not stated"]);
  });

  it("says \"not read\" for every figure of an inventory that was not read, and is never green about it", () => {
    const manifest = app({ needs: { memoryMb: 1229, diskMb: 1946 } });
    const rows = fitRows({ manifest, values: formOf(manifest), inventory: null, ports: clear });
    expect(rows.map(cells)).toEqual([
      ["Memory", "not read", "+ 1.2 GB", "not read", "unread"],
      ["System disk", "not read", "+ 1.9 GB", "not read", "unread"],
      ["/mnt/media/documents", "not read", "not stated", "not read", "unread"],
      ["Port", "8000 is free", "takes 8000", "no clash", "pass"],
    ]);
    expect(fitVerdict(rows)).toEqual({ status: "unknown", label: "Not read", summary: "Memory, System disk and /mnt/media/documents could not be read, so this cannot say it fits." });
    // While it is still being read the rows say so, and the result waits.
    const pending = fitRows({ manifest, values: formOf(manifest), inventory: null, inventoryPending: true, ports: clear });
    expect(cells(row(pending, "memory"))).toEqual(["Memory", "reading…", "+ 1.2 GB", "reading…", "reading"]);
    expect(fitVerdict(pending).label).toBe("Checking…");
    // An inventory that answered with no memory total (the reader writes 0) did not read the memory.
    const partial = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ memoryTotal: 0, memoryUsed: 0, mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 1200)] }), ports: clear });
    expect(row(partial, "memory").check).toBe("unread");
    expect(row(partial, "disk:/").check).toBe("pass");
    expect(fitVerdict(partial)).toMatchObject({ status: "unknown", label: "Not read" });
    // A figure that is not a number is not read either: no arithmetic on it, and no NaN on the page.
    const broken = fitRows({ manifest, values: formOf(manifest), inventory: { ...inventory(), memoryUsed: Number.NaN, mounts: [{ target: "/", source: "", total: Number.NaN, used: null, percent: Number.NaN, state: "healthy" }] }, ports: clear });
    expect(cells(row(broken, "memory"))).toEqual(["Memory", "not read", "+ 1.2 GB", "not read", "unread"]);
    expect(cells(row(broken, "disk:/"))).toEqual(["System disk", "not read", "+ 1.9 GB", "not read", "unread"]);
    // Not read outranks a caution, and only something that cannot fit outranks not read.
    expect(fitVerdict([{ ...row(partial, "memory") }, { ...row(partial, "disk:/"), check: "caution" }]).label).toBe("Not read");
    expect(fitVerdict([{ ...row(partial, "memory") }, { ...row(partial, "disk:/"), check: "fail" }]).label).toBe("Does not fit");
  });

  it("has no data-drive row for an app with no folders of its own, or whose folders are on the system disk", () => {
    const plain = app({ volumes: [volume({})], sidecars: [] });
    const stock = inventory({ mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 1200)] });
    expect(fitRows({ manifest: plain, values: formOf(plain), inventory: stock, ports: clear }).map((entry) => entry.id)).toEqual(["memory", "disk:/", "port:web"]);
    // No volumes and no ports at all: memory and the system disk are still the question.
    const bare = app({ volumes: [], ports: [], sidecars: [] });
    expect(fitRows({ manifest: bare, values: formOf(bare), inventory: stock, ports: clear }).map((entry) => entry.id)).toEqual(["memory", "disk:/"]);
    // A folder that is not on a mounted drive lives on the system disk: one row, not two.
    const manifest = app();
    expect(fitRows({ manifest, values: formOf(manifest, { volumes: { documents: "/srv/documents" } }), inventory: stock, ports: clear }).map((entry) => entry.id)).toEqual(["memory", "disk:/", "port:web"]);
    // A library it only reads takes nothing from that drive.
    const reader = app({ volumes: [volume({}), volume({ id: "media", container: "/media", path: null, hostPath: "/mnt/media", readOnly: true, backup: false, configurable: true })] });
    expect(fitRows({ manifest: reader, values: formOf(reader), inventory: stock, ports: clear }).map((entry) => entry.id)).toEqual(["memory", "disk:/", "port:web"]);
    // The folder the owner picked in the form decides the drive, not the manifest's default.
    const moved = fitRows({ manifest, values: formOf(manifest, { volumes: { documents: "/mnt/tank/paper" } }), inventory: inventory({ mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 1200), mount("/mnt/tank", 8000, 800)] }), ports: clear });
    expect(moved.map((entry) => entry.id)).toEqual(["memory", "disk:/", "disk:/mnt/tank", "port:web"]);
  });

  it("puts each path on the filesystem with the longest matching mount point", () => {
    const { mounts } = inventory({ mounts: [mount("/", 100, 27), mount("/mnt/media", 4000, 1200), mount("/mnt/media/archive", 500, 100), mount("/var/lib/docker", 200, 50)] });
    expect(mountFor("/mnt/media/documents", mounts)?.target).toBe("/mnt/media");
    expect(mountFor("/mnt/media/archive/2019/", mounts)?.target).toBe("/mnt/media/archive");
    expect(mountFor("/mnt/mediafiles", mounts)?.target).toBe("/"); // a name that only starts the same
    expect(mountFor("/srv/x", [])).toBeNull();
    // Docker's images on a disk of their own: that disk is the one the install lands on.
    const manifest = app({ needs: { memoryMb: null, diskMb: 2048 }, volumes: [], sidecars: [] });
    const rows = fitRows({ manifest, values: formOf(manifest), inventory: inventory({ mounts: [mount("/", 100, 27), mount("/var/lib/docker", 200, 50)] }), ports: clear });
    expect(rows.filter((entry) => entry.kind === "disk").map(cells)).toEqual([["/var/lib/docker", "50.0 GB", "+ 2.0 GB", "148.0 GB of 200.0 GB", "pass"]]);
    // A mount list without the system disk still has it, from the inventory's own root reading.
    const rootOnly = { ...inventory(), mounts: [] };
    expect(fitRows({ manifest, values: formOf(manifest), inventory: rootOnly, ports: clear }).filter((entry) => entry.kind === "disk").map(cells)).toEqual([["System disk", "27.0 GB", "+ 2.0 GB", "71.0 GB of 100.0 GB", "pass"]]);
    // Neither: the disk is not read.
    expect(row(fitRows({ manifest, values: formOf(manifest), inventory: { ...rootOnly, root: null }, ports: clear }), "disk:/var/lib/docker")).toMatchObject({ item: "System disk", check: "unread" });
  });
});

describe("the port it will get", () => {
  const portainer = { label: "Web UI", id: "web", port: 8000, protocol: "tcp", listeners: ["0.0.0.0:8000"], containers: [{ name: "boxpilot-portainer-1", app: "portainer", composeProject: null }] };
  const names = (id: string) => (id === "portainer" ? "Portainer" : null);

  it("moves a taken default to the next free port, stepping over what installed apps hold", () => {
    const manifest = app();
    const held = new Set(["8001/tcp", "8002/tcp", "8003/udp"]);
    const relocation = relocatePorts({ manifest, values: formOf(manifest), conflicts: [portainer], touched: new Set(), held, tried: new Set(["8000/tcp"]), appName: names });
    expect(relocation).toEqual({ ports: { web: 8003 }, moved: { web: { from: 8000, held: "Portainer's" } } }); // 8003/udp is another protocol's
    // Once the precheck agrees the new one is free, the row says where it went and why.
    const rows = fitRows({ manifest, values: formOf(manifest, { ports: relocation.ports }), inventory: inventory(), ports: { state: "read", conflicts: [], moved: relocation.moved }, appName: names });
    expect(row(rows, "port:web")).toMatchObject({ usedNow: "8000 is Portainer's", adds: "takes 8003", scaleWords: "next free one", leftAfter: "no clash", check: "pass" });
    expect(fitVerdict(rows.filter((entry) => entry.kind === "port")).label).toBe("Fits");
  });

  it("leaves a port the owner typed, a fixed one and one on the host's network where they are, and says they clash", () => {
    const manifest = app();
    const nothing = { ports: {}, moved: {} };
    expect(relocatePorts({ manifest, values: formOf(manifest), conflicts: [portainer], touched: new Set(["web"]), held: new Set(), tried: new Set() })).toEqual(nothing);
    const fixed = app({ ports: [port({ fixed: true })] });
    expect(relocatePorts({ manifest: fixed, values: formOf(fixed), conflicts: [portainer], touched: new Set(), held: new Set(), tried: new Set() })).toEqual(nothing);
    expect(relocatePorts({ manifest, values: formOf(manifest, { networkMode: "host" }), conflicts: [portainer], touched: new Set(), held: new Set(), tried: new Set() })).toEqual(nothing);
    expect(relocatePorts({ manifest, values: formOf(manifest), conflicts: [], touched: new Set(), held: new Set(), tried: new Set() })).toEqual(nothing);
    const typed = fitRows({ manifest, values: formOf(manifest), inventory: inventory(), ports: { state: "read", conflicts: [portainer], moved: {} }, appName: names });
    expect(row(typed, "port:web")).toMatchObject({ usedNow: "8000 is Portainer's", adds: "needs 8000", scaleWords: "pick another", leftAfter: "clash", check: "fail", note: "Web UI port 8000/tcp is Portainer's." });
    expect(fitVerdict(typed).label).toBe("Does not fit");
    const stuck = fitRows({ manifest: fixed, values: formOf(fixed), inventory: inventory(), ports: { state: "read", conflicts: [portainer], moved: {} }, appName: names });
    expect(row(stuck, "port:web")).toMatchObject({ scaleWords: "cannot move", note: "Web UI port 8000/tcp is Portainer's, and this app cannot use another." });
  });

  it("keeps two of an app's own ports apart when both move, and names each when there are several", () => {
    const manifest = app({ ports: [port(), port({ id: "api", label: "API", container: 8001, host: 8001 })] });
    const conflicts = [portainer, { ...portainer, id: "api", label: "API", port: 8001, containers: [] }];
    const relocation = relocatePorts({ manifest, values: formOf(manifest), conflicts, touched: new Set(), held: new Set(), tried: new Set() });
    expect(relocation.ports).toEqual({ web: 8002, api: 8003 });
    expect(relocation.moved.api).toEqual({ from: 8001, held: "in use" });
    expect(fitRows({ manifest, values: formOf(manifest), inventory: inventory(), ports: clear }).filter((entry) => entry.kind === "port").map((entry) => entry.item)).toEqual(["Web UI port", "API port"]);
  });

  it("finds the next free port, and none past the last one", () => {
    expect(nextFreePort(8000, (candidate) => candidate <= 8010)).toBe(8011);
    expect(nextFreePort(8000, () => false)).toBe(8001);
    expect(nextFreePort(65535, () => false)).toBeNull();
    expect(nextFreePort(65530, () => true)).toBeNull();
  });

  it("is not read, and says why, until the server can check: never a pass on a guess", () => {
    const manifest = app();
    const waiting = fitRows({ manifest, values: formOf(manifest), inventory: inventory(), ports: { state: "unread", conflicts: [], moved: {}, reason: "settings" } });
    expect(row(waiting, "port:web")).toMatchObject({ usedNow: "not read", adds: "takes 8000", leftAfter: "not checked", check: "unread", note: "The ports are checked once the settings this app requires are filled in." });
    expect(fitVerdict(waiting)).toMatchObject({ status: "unknown", label: "Not read" });
    const checking = fitRows({ manifest, values: formOf(manifest), inventory: inventory(), ports: { state: "reading", conflicts: [], moved: {} } });
    expect(row(checking, "port:web").check).toBe("reading");
    expect(fitVerdict(checking)).toEqual({ status: "unknown", label: "Checking…", summary: null });
    // On the host's own network the app holds its container port, whatever the form's box says.
    const host = app({ ports: [port({ container: 80, host: 8084 })] });
    expect(row(fitRows({ manifest: host, values: formOf(host, { networkMode: "host" }), inventory: inventory(), ports: clear }), "port:web").adds).toBe("takes 80");
  });

  it("says whose a taken port is in the fewest words", () => {
    expect(heldWords(portainer, names)).toBe("Portainer's");
    expect(heldWords(portainer)).toBe("portainer's");
    expect(heldWords({ ...portainer, containers: [{ name: "emby", app: null, composeProject: "media" }] })).toBe("held by container emby");
    expect(heldWords({ label: "DNS", port: 53, protocol: "udp", listeners: ["127.0.0.53:53"] })).toBe("held by Ubuntu's own resolver");
    expect(heldWords({ label: "Web", port: 8000, protocol: "tcp", listeners: ["0.0.0.0:8000"] })).toBe("in use");
  });

  it("knows the ports installed apps hold, from what they publish and what was chosen for them", () => {
    const installed = (id: string, extra: Partial<Entry["live"] & object> = {}): Entry => ({
      manifest: app({ id, ports: [port({ host: 9000 }), port({ id: "dns", label: "DNS", container: 53, host: 53, protocol: "udp" })] }),
      live: { id, installed: true, dataPresent: true, state: { installedAt: "x", updatedAt: "x", manifestSha256: null, image: null, values: { ports: { web: 9443 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null }, container: { exists: true, running: true, status: "running", health: "none", restarts: 0, image: null }, urls: [], ...extra },
    });
    const absent: Entry = { manifest: app({ id: "later", ports: [port({ host: 7000 })] }), live: null };
    const held = heldPorts([installed("portainer", { published: [{ id: "edge", host: 8000, protocol: "tcp", bind: "*", fixed: false, web: false }] }), installed("itself"), absent], "itself");
    expect([...held].sort()).toEqual(["53/udp", "8000/tcp", "9443/tcp"]);
  });

  it("knows a form the server would refuse before it looks at ports", () => {
    const setting = (extra: Record<string, unknown>) => ({ name: "TOKEN", label: "Token", description: null, type: "string" as const, default: null, required: true, secret: false, generate: false, options: null, fixed: false, ...extra });
    expect(needsSettingsFirst(app({ env: [setting({})] }), { env: {} })).toBe(true);
    expect(needsSettingsFirst(app({ env: [setting({})] }), { env: { TOKEN: "abc" } })).toBe(false);
    expect(needsSettingsFirst(app({ env: [setting({ default: "x" })] }), { env: {} })).toBe(false);
    expect(needsSettingsFirst(app({ env: [setting({ generate: true })] }), { env: {} })).toBe(false);
    expect(needsSettingsFirst(app({ env: [setting({ required: false })] }), { env: {} })).toBe(false);
  });
});

describe("where it will answer", () => {
  const host = { lanAddress: "192.0.2.10", tailscaleDnsName: "homebox.tail1234.ts.net" };

  it("gives the network address with the port it will actually get, and the tailnet's short name", () => {
    const manifest = app();
    expect(whereItAnswers({ manifest, values: formOf(manifest, { ports: { web: 8011 } }), host })).toEqual([
      { id: "lan:web", label: "On your network", address: "http://192.0.2.10:8011", words: null },
      { id: "tailnet:web", label: "Over Tailscale", address: "http://homebox:8011", words: "Needs Tailscale running on the device you are using." },
      { id: "internet", label: "On the internet", address: null, words: "Not published. Installing it opens nothing on your router." },
    ]);
  });

  it("invents no address: one that was not read is said as not read", () => {
    const manifest = app();
    const lines = whereItAnswers({ manifest, values: formOf(manifest), host: { lanAddress: null, tailscaleDnsName: null } });
    expect(lines.slice(0, 2)).toEqual([
      { id: "lan:web", label: "On your network", address: null, words: "Port 8000 on this server; its network address was not read." },
      { id: "tailnet:web", label: "Over Tailscale", address: null, words: "No tailnet name is known for this server." },
    ]);
  });

  it("says a tailnet-only app is not on the home network, and where Tailscale Serve publishes it", () => {
    const manifest = app({ defaultExposure: "tailnet" });
    const lines = whereItAnswers({ manifest, values: formOf(manifest), host });
    expect(lines[0]).toEqual({ id: "lan:web", label: "On your network", address: null, words: "Not reachable: its page stays on this server." });
    expect(lines[1]).toMatchObject({ label: "Over Tailscale", address: "https://homebox.tail1234.ts.net:8000" });
    expect(whereItAnswers({ manifest, values: formOf(manifest), host: { ...host, tailscaleDnsName: null } })[1]).toEqual({ id: "tailnet:web", label: "Over Tailscale", address: null, words: "Published by Tailscale Serve on port 8000; this server's tailnet name was not read." });
  });

  it("keeps a loopback port on the server, lists the ports that are not web pages, and says when there is none", () => {
    const local = app({ ports: [port({ exposure: "loopback" })] });
    expect(whereItAnswers({ manifest: local, values: formOf(local), host })[0]).toEqual({ id: "loopback:web", label: "On this server only", address: "http://127.0.0.1:8000", words: "Bound to the server itself; not reachable from other devices." });
    const dns = app({ ports: [port({ host: 8084, container: 80 }), port({ id: "dns", label: "DNS", container: 53, host: 53, protocol: "udp", tailnet: "unchanged" })] });
    expect(whereItAnswers({ manifest: dns, values: formOf(dns), host }).find((line) => line.id === "others")).toEqual({ id: "others", label: "Other ports", address: "DNS 53/udp", words: null });
    // On the host's own network its ports are the container's.
    expect(whereItAnswers({ manifest: dns, values: formOf(dns, { networkMode: "host" }), host })[0].address).toBe("http://192.0.2.10:80");
    const none = app({ ports: [] });
    expect(whereItAnswers({ manifest: none, values: formOf(none), host })).toEqual([{ id: "none", label: "No address", address: null, words: "It publishes no port, so nothing opens it from another device." }]);
    // An app whose own page is HTTPS is linked that way.
    expect(whereItAnswers({ manifest: app(), values: formOf(app()), host, https: true })[0].address).toBe("https://192.0.2.10:8000");
  });
});

describe("what it starts, and whether it holds data", () => {
  it("counts a container for the app and one for each sidecar, none of those on the host's own network", () => {
    const manifest = app();
    expect(startsWords(manifest, {})).toBe("Starts 3 containers (paperless-ngx, db, broker). Nothing that is running now is stopped or changed.");
    expect(startsWords(app({ sidecars: [] }), {})).toBe("Starts 1 container. Nothing that is running now is stopped or changed.");
    expect(startsWords(app({ sidecars: undefined }), {})).toBe("Starts 1 container. Nothing that is running now is stopped or changed.");
    expect(startsWords(manifest, { networkMode: "host" })).toBe("Starts 1 container. Nothing that is running now is stopped or changed.");
  });

  it("holds data when a backup would archive anything of it, a sidecar's included", () => {
    expect(holdsData(app())).toBe(true);
    expect(holdsData(app({ volumes: [], sidecars: [] }))).toBe(false);
    expect(holdsData(app({ volumes: [volume({ backup: false })], sidecars: [] }))).toBe(false);
    // Immich's shape: its library is a host folder kept out of backups, its database is a sidecar's.
    expect(holdsData(app({ volumes: [volume({ path: null, hostPath: "/mnt/photos", backup: false, configurable: true })], sidecars: [{ id: "db", volumes: [{ path: "db", backup: true }] }] }))).toBe(true);
  });
});
