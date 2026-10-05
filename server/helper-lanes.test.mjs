import { describe, expect, it } from "vitest";
import { backupTreeLane, createConcurrencyGate, createLaneQueues, dockerLane, exclusiveLane, laneFor } from "./helper-lanes.mjs";

describe("helper lanes", () => {
  it("gives each app and VM its own lane and keeps shared host work on one", () => {
    expect(laneFor("app.backup", { id: "jellyfin" })).toEqual(["app:jellyfin", "backup-tree", "host"]);
    expect(laneFor("app.action", { id: "immich", action: "restart" })).toEqual(["app:immich"]);
    expect(laneFor("app.install", {})).toEqual(["app:homepage"]); // installs write the shared dashboard file
    expect(laneFor("app.backup", {})).toEqual(["backup-tree", "host"]); // no subject: stay conservative
    expect(laneFor("vm.action", { name: "dev-lab" })).toEqual(["vm:dev-lab"]);
    expect(laneFor("vm.create", { name: "dev-lab" })).toEqual(["host"]); // shared pools and libvirt config
    expect(laneFor("vm.media.import", { name: "iso" })).toEqual(["host"]);
    expect(laneFor("apt.refresh", {})).toEqual(["host"]);
    expect(laneFor("firewall.set", { enabled: true })).toEqual(["host"]);
    expect(laneFor("storage.format", { device: "/dev/sdb" })).toEqual(["host"]);
    expect(laneFor("app.backup", { id: "x".repeat(100) })).toEqual(["backup-tree", "host"]); // implausible subject
  });

  it("runs different lanes concurrently and the same lane in order, surviving failures", async () => {
    const queues = createLaneQueues();
    const order = [];
    const gate = { resolve: null };
    const blocked = new Promise((resolve) => { gate.resolve = resolve; });

    const slow = queues.run("app:jellyfin", async () => { await blocked; order.push("slow"); return "slow"; });
    const other = queues.run("host", async () => { order.push("host"); return "host"; });
    expect(await other).toBe("host");
    expect(order).toEqual(["host"]); // the slow lane is still blocked

    const failing = queues.run("app:immich", async () => { throw new Error("boom"); });
    await expect(failing).rejects.toThrow("boom");
    const after = await queues.run("app:immich", async () => { order.push("after-failure"); return "ok"; });
    expect(after).toBe("ok");

    const queued = queues.run("app:jellyfin", async () => { order.push("queued"); return "queued"; });
    gate.resolve();
    await queued;
    expect(order).toEqual(["host", "after-failure", "slow", "queued"]);
    expect(await slow).toBe("slow");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queues.size()).toBe(0); // idle lanes are dropped
  });
});

describe("whole-box operations", () => {
  it("takes an exclusive lane so a machine snapshot never runs beside app writes", async () => {
    expect(laneFor("host.snapshot.create", {})).toEqual([exclusiveLane]);
    expect(laneFor("controller.backup.create", {})).toEqual([exclusiveLane]);
    const queues = createLaneQueues();
    const order = [];
    let releaseApp;
    const appWork = queues.run("app:jellyfin", async () => { await new Promise((resolve) => { releaseApp = resolve; }); order.push("app"); });
    const snapshot = queues.run(exclusiveLane, async () => { order.push("snapshot"); });
    const otherApp = queues.run("app:immich", async () => { order.push("other-app"); });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the lanes start before the app work finishes
    releaseApp();
    await Promise.all([appWork, snapshot, otherApp]);
    // The snapshot waited for the running app work, and the app queued behind it waited for the snapshot.
    expect(order).toEqual(["app", "snapshot", "other-app"]);
  });
});

describe("apps that touch the shared dashboard", () => {
  it("puts installs and removals on the Homepage lane so one services.yaml has one writer", () => {
    expect(laneFor("app.install", { id: "jellyfin" })).toEqual(["app:jellyfin", "app:homepage"]);
    expect(laneFor("app.purge", { id: "immich" })).toEqual(["app:immich", "app:homepage"]);
    expect(laneFor("homepage.sync", {})).toEqual(["app:homepage"]);
    // Everything else about an app still gets that app's own lane.
    expect(laneFor("app.backup", { id: "jellyfin" })).toEqual(["app:jellyfin", "backup-tree", "host"]);
    expect(laneFor("app.action", { id: "jellyfin", action: "restart" })).toEqual(["app:jellyfin"]);
  });
});

describe("an operation holds every lane it touches", () => {
  it("keeps purge and backup of the same app apart while still sharing the dashboard lane", async () => {
    // Installing and purging rewrite the shared dashboard file AND the app's own directory,
    // so they must never run beside another operation on that app.
    expect(laneFor("app.purge", { id: "jellyfin" })).toEqual(["app:jellyfin", "app:homepage"]);

    const queues = createLaneQueues();
    const order = [];
    let releaseBackup;
    const backup = queues.run(laneFor("app.backup", { id: "jellyfin" }), async () => {
      order.push("backup:start");
      await new Promise((resolve) => { releaseBackup = resolve; });
      order.push("backup:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const purge = queues.run(laneFor("app.purge", { id: "jellyfin" }), async () => { order.push("purge"); });
    // A different app's install shares only the dashboard lane, so it waits for the purge but not the backup.
    const otherInstall = queues.run(laneFor("app.install", { id: "immich" }), async () => { order.push("other-install"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["backup:start"]); // nothing else has started

    releaseBackup();
    await Promise.all([backup, purge, otherInstall]);
    expect(order).toEqual(["backup:start", "backup:end", "purge", "other-install"]);
  });

  it("lets two apps work at once when they share no lane", async () => {
    const queues = createLaneQueues();
    const order = [];
    let release;
    const slow = queues.run(laneFor("app.backup", { id: "jellyfin" }), async () => { await new Promise((resolve) => { release = resolve; }); order.push("jellyfin"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await queues.run(laneFor("app.action", { id: "immich", action: "restart" }), async () => { order.push("immich"); });
    expect(order).toEqual(["immich"]); // the other app did not wait
    release();
    await slow;
  });
});

describe("inspection concurrency", () => {
  it("refuses overflow instead of retaining an unbounded read queue", async () => {
    const gate = createConcurrencyGate(1, { maxWaiting: 2 });
    let release;
    const active = gate.run(() => new Promise((resolve) => { release = resolve; }));
    const queued = [gate.run(async () => "first"), gate.run(async () => "second")];
    const overflow = await Promise.allSettled(Array.from({ length: 1000 }, () => gate.run(async () => "must not run")));
    expect(overflow.every((result) => result.status === "rejected" && result.reason.code === "HELPER_BUSY")).toBe(true);
    expect(gate.waiting()).toBe(2);
    release(); await active;
    expect(await Promise.all(queued)).toEqual(["first", "second"]);
    expect(gate.waiting()).toBe(0); expect(gate.active()).toBe(0);
  });

  it("removes abandoned waiting work and admits the next live caller", async () => {
    const gate = createConcurrencyGate(1, { maxWaiting: 1 });
    let release; let abandonedRuns = 0;
    const active = gate.run(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const pending = gate.run(async () => { abandonedRuns += 1; }, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejection;
    expect(gate.waiting()).toBe(0);
    const next = gate.run(async () => "next");
    release(); await active;
    expect(await next).toBe("next"); expect(abandonedRuns).toBe(0);
  });
  it("runs a bounded number at once and lets the rest through in order", async () => {
    const gate = createConcurrencyGate(2);
    const order = [];
    const releases = [];
    const start = (label) => gate.run(async () => {
      order.push(`start:${label}`);
      await new Promise((resolve) => releases.push(resolve));
      order.push(`end:${label}`);
    });
    const all = [start("a"), start("b"), start("c")];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:a", "start:b"]); // the third waits
    expect(gate.active()).toBe(2);
    expect(gate.waiting()).toBe(1);
    releases.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toContain("start:c");
    while (releases.length) releases.shift()();
    await Promise.all(all);
    expect(gate.active()).toBe(0);
  });

  it("frees its slot when a task throws", async () => {
    const gate = createConcurrencyGate(1);
    await expect(gate.run(async () => { throw new Error("inspection failed"); })).rejects.toThrow("inspection failed");
    expect(gate.active()).toBe(0);
    await expect(gate.run(async () => "next one runs")).resolves.toBe("next one runs");
  });
});

it("keeps completed-log cache release independent of long host work", () => {
  expect(laneFor("job.output.release", { jobId: "11111111-2222-4333-8444-555555555555" })).toEqual(["job-output"]);
});

it("holds every app a several-app backup touches, and the shared dashboard when an app is rebuilt (M35)", () => {
  expect(laneFor("app.backup.many", { ids: ["audhdmap", "protec"] })).toEqual(["app:audhdmap", "app:protec", "backup-tree", "host"]);
  expect(laneFor("app.reinstall", { id: "homepage" })).toEqual(["app:homepage"]);
  expect(laneFor("app.reinstall", { id: "it-tools" })).toEqual(["app:it-tools", "app:homepage"]);
});

/**
 * An update, a settings change, a compose edit, a rollback and a file restore each write a
 * checkpoint into the backup tree, and a delete removes from it; they held only their app's lane, so
 * a mirror ran beside them, copied a `<stamp>.tar.gz.partial` mid-write and kept it forever, or died
 * when the file it was reading was renamed or grew under it (rsync exits 24, rclone errors).
 */
describe("the backup tree", () => {
  it("puts everything that writes or deletes there, and the three mirrors, on one lane", () => {
    for (const id of ["app.backup", "app.backup.many", "app.backup.restore", "app.backup.restore-path", "app.backup.delete", "app.backup.verify", "app.update", "app.rollback", "app.reconfigure", "app.compose.edit"]) {
      expect(laneFor(id, { id: "jellyfin" })).toContain(backupTreeLane);
    }
    for (const id of ["backup.sync", "backup.remote.sync", "backup.cloud.sync"]) expect(laneFor(id, {})).toEqual([backupTreeLane, "host"]);
    // Reclaiming space deletes app archives behind the newest few of each app, so it holds the tree
    // too, and keeps the host lane it had for everything else it clears.
    expect(laneFor("housekeeping.reclaim", { categories: ["app-backups"] })).toEqual([backupTreeLane, "host"]);
    // The checkpoint is all an update writes there: it takes the tree's lane, not the host's.
    expect(laneFor("app.update", { id: "jellyfin" })).toEqual(["app:jellyfin", backupTreeLane]);
    expect(laneFor("app.backup.delete", { id: "jellyfin", backup: "20261001T030000Z.tar.gz" })).toEqual(["app:jellyfin", backupTreeLane]);
    // Nothing else about an app touches the tree.
    expect(laneFor("app.action", { id: "jellyfin", action: "restart" })).toEqual(["app:jellyfin"]);
    expect(laneFor("app.exposure.set", { id: "jellyfin", mode: "tailnet" })).toEqual(["app:jellyfin"]);
  });

  it("never runs a mirror beside an update's checkpoint, or a delete beside a mirror", async () => {
    const queues = createLaneQueues();
    const order = [];
    let releaseUpdate;
    const update = queues.run(laneFor("app.update", { id: "jellyfin" }), async () => {
      order.push("update:start");
      await new Promise((resolve) => { releaseUpdate = resolve; });
      order.push("update:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mirrors = ["backup.sync", "backup.remote.sync", "backup.cloud.sync"].map((id) => queues.run(laneFor(id, {}), async () => { order.push(id); }));
    const remove = queues.run(laneFor("app.backup.delete", { id: "immich" }), async () => { order.push("delete"); });
    // A third app's restart shares no lane with any of them.
    await queues.run(laneFor("app.action", { id: "pihole", action: "restart" }), async () => { order.push("restart"); });
    expect(order).toEqual(["update:start", "restart"]);
    releaseUpdate();
    await Promise.all([update, ...mirrors, remove]);
    expect(order).toEqual(["update:start", "restart", "update:end", "backup.sync", "backup.remote.sync", "backup.cloud.sync", "delete"]);
  });
});

/**
 * Docker log rotation restarts dockerd; a package change can restart docker.service or containerd
 * (their own scripts, or needrestart afterwards); so can Services. Those held only the host lane, and
 * app operations never hold it, so Docker restarted under an install, an update or a model pull
 * mid-compose - and under its rollback.
 */
describe("operations that can restart Docker", () => {
  const restartsDocker = [
    ["docker.logging.set", {}],
    ...["apt.upgrade", "apt.install", "apt.remove", "apt.purge", "apt.autoremove", "apt.repair", "apt.unattended.set", "prerequisite.docker.install"].map((id) => [id, {}]),
    ["service.action", { unit: "docker.service", action: "restart" }],
    ["service.action", { unit: "containerd.service", action: "restart" }],
    ["service.action", { unit: "docker.socket", action: "stop" }],
  ];

  it("hold the Docker lane as well as the host lane; nothing else does", () => {
    for (const [id, parameters] of restartsDocker) expect(laneFor(id, parameters)).toEqual(["host", dockerLane]);
    expect(laneFor("apt.refresh", {})).toEqual(["host"]); // lists only: nothing is installed or restarted
    expect(laneFor("service.action", { unit: "nginx.service", action: "restart" })).toEqual(["host"]);
    expect(laneFor("docker.prune", {})).toEqual(["host"]);
    expect(laneFor("app.install", { id: "jellyfin" })).not.toContain(dockerLane);
  });

  it("waits for every app operation already running, and every app operation behind it waits for it", async () => {
    const queues = createLaneQueues();
    const order = [];
    let releaseInstall;
    const install = queues.run(laneFor("app.install", { id: "jellyfin" }), async () => {
      order.push("install:start");
      await new Promise((resolve) => { releaseInstall = resolve; });
      order.push("install:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queues.busy(laneFor("apt.upgrade", {}))).toBe(true);
    const upgrade = queues.run(laneFor("apt.upgrade", {}), async () => { order.push("upgrade"); });
    expect(queues.busy(laneFor("app.model.pull", { id: "ollama" }))).toBe(true);
    const pull = queues.run(laneFor("app.model.pull", { id: "ollama" }), async () => { order.push("pull"); });
    // Work that never touches Docker's apps is not held up by either.
    await queues.run(laneFor("vm.action", { name: "dev-lab" }), async () => { order.push("vm"); });
    expect(order).toEqual(["install:start", "vm"]);
    releaseInstall();
    await Promise.all([install, upgrade, pull]);
    expect(order).toEqual(["install:start", "vm", "install:end", "upgrade", "pull"]);
  });

  it("still lets two apps work at once with nothing restarting Docker", async () => {
    const queues = createLaneQueues();
    let release;
    const first = queues.run(laneFor("app.update", { id: "jellyfin" }), () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queues.busy(laneFor("app.action", { id: "immich", action: "restart" }))).toBe(false);
    await queues.run(laneFor("app.action", { id: "immich", action: "restart" }), async () => {});
    release();
    await first;
  });
});

/**
 * A drive check, a reconnect and letting apps write stop the containers bound to the drive, unmount
 * it and start them again; unmounting a drive or a share decides from the running containers that
 * none holds it. They held only the host lane, which no app operation holds, so Start Jellyfin
 * mid-check bound the empty folder on the system disk, and the check's own start afterwards left
 * that container as it was: Jellyfin wrote to the system disk, hidden under the drive.
 */
describe("operations that unmount a drive under the apps", () => {
  const underApps = [
    ["storage.check", { name: "media" }],
    ["storage.dirty-mark.clear", { name: "media" }],
    ["storage.remount", { name: "media" }],
    ["storage.writable", { name: "media" }],
    ["storage.unmount", { name: "media" }],
    ["share.reconnect", { name: "nas" }],
    ["share.unmount", { name: "nas" }],
  ];

  it("hold the Docker lane as well as the host lane", () => {
    for (const [id, parameters] of underApps) expect(laneFor(id, parameters), id).toEqual(["host", dockerLane]);
    // Mounting a drive or a share touches no container.
    expect(laneFor("storage.mount", { name: "media" })).toEqual(["host"]);
    expect(laneFor("share.mount", { name: "nas" })).toEqual(["host"]);
  });

  it.each(underApps)("%s keeps an app started behind it waiting until the drive is back", async (id, parameters) => {
    const queues = createLaneQueues();
    const order = [];
    let releaseCheck;
    const check = queues.run(laneFor(id, parameters), async () => {
      order.push("unmounted");
      await new Promise((resolve) => { releaseCheck = resolve; });
      order.push("mounted again");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const start = laneFor("app.action", { id: "jellyfin", action: "start" });
    expect(queues.busy(start)).toBe(true);
    const started = queues.run(start, async () => { order.push("jellyfin started"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["unmounted"]);
    releaseCheck();
    await Promise.all([check, started]);
    expect(order).toEqual(["unmounted", "mounted again", "jellyfin started"]);
  });

  it("waits for an app operation already running before it unmounts", async () => {
    const queues = createLaneQueues();
    const order = [];
    let releaseUpdate;
    const update = queues.run(laneFor("app.update", { id: "jellyfin" }), async () => {
      order.push("update:start");
      await new Promise((resolve) => { releaseUpdate = resolve; });
      order.push("update:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const check = queues.run(laneFor("storage.check", { name: "media" }), async () => { order.push("check"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["update:start"]);
    releaseUpdate();
    await Promise.all([update, check]);
    expect(order).toEqual(["update:start", "update:end", "check"]);
  });
});

/** A DNS rehearsal stops and starts the DNS app's own container: it holds that app's lane. */
it("holds the DNS app's lane while a rehearsal stops and starts it", async () => {
  expect(laneFor("dns.fallback.rehearse", { app: "pihole", router: "192.0.2.1", lanAddress: "192.0.2.10" })).toEqual(["host", "app:pihole"]);
  expect(laneFor("dns.fallback.rehearse", { app: "adguard" })).toEqual(["host", "app:adguard"]);
  const queues = createLaneQueues();
  const order = [];
  let release;
  const rehearsal = queues.run(laneFor("dns.fallback.rehearse", { app: "pihole" }), async () => {
    order.push("stopped");
    await new Promise((resolve) => { release = resolve; });
    order.push("started again");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const update = queues.run(laneFor("app.update", { id: "pihole" }), async () => { order.push("update"); });
  // Another app is not held up.
  await queues.run(laneFor("app.action", { id: "jellyfin", action: "restart" }), async () => { order.push("jellyfin"); });
  expect(order).toEqual(["stopped", "jellyfin"]);
  release();
  await Promise.all([rehearsal, update]);
  expect(order).toEqual(["stopped", "jellyfin", "started again", "update"]);
});

/**
 * A root task that ran out of its own time is left running (boxpilot-run@ has KillMode=process): the
 * operation answers at once that it timed out, but what it holds must not be free while that task is
 * still at work. fsck.exfat -y went on writing to an unmounted drive while an app start bound the
 * empty folder and a reconnect mounted the drive mid-repair (sweep 4).
 */
it("keeps an operation's lanes held for what it asks to be held for, after it has answered", async () => {
  const queues = createLaneQueues();
  const order = [];
  let unitStops;
  const stopped = new Promise((resolve) => { unitStops = resolve; });
  const clearing = queues.run(laneFor("storage.dirty-mark.clear", { name: "media" }), async (holdUntil) => {
    holdUntil(stopped);
    throw new Error("Root task storage.clear-mark did not finish within 58 minutes");
  });
  // The operation's answer is not held back.
  await expect(clearing).rejects.toThrow("did not finish");
  expect(queues.busy(laneFor("storage.remount", { name: "media" }))).toBe(true);
  const reconnect = queues.run(laneFor("storage.remount", { name: "media" }), async () => { order.push("reconnect"); });
  const start = queues.run(laneFor("app.action", { id: "jellyfin", action: "start" }), async () => { order.push("app start"); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([]);
  unitStops();
  await Promise.all([reconnect, start]);
  expect(order).toEqual(["reconnect", "app start"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(queues.size()).toBe(0);
});
