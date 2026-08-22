import { describe, expect, it } from "vitest";
import { createConcurrencyGate, createLaneQueues, exclusiveLane, laneFor } from "./helper-lanes.mjs";

describe("helper lanes", () => {
  it("gives each app and VM its own lane and keeps shared host work on one", () => {
    expect(laneFor("app.backup", { id: "jellyfin" })).toEqual(["app:jellyfin", "host"]);
    expect(laneFor("app.action", { id: "immich", action: "restart" })).toEqual(["app:immich"]);
    expect(laneFor("app.install", {})).toEqual(["app:homepage"]); // installs write the shared dashboard file
    expect(laneFor("app.backup", {})).toEqual(["host"]); // no subject: stay conservative
    expect(laneFor("vm.action", { name: "dev-lab" })).toEqual(["vm:dev-lab"]);
    expect(laneFor("vm.create", { name: "dev-lab" })).toEqual(["host"]); // shared pools and libvirt config
    expect(laneFor("vm.media.import", { name: "iso" })).toEqual(["host"]);
    expect(laneFor("apt.upgrade", {})).toEqual(["host"]);
    expect(laneFor("firewall.set", { enabled: true })).toEqual(["host"]);
    expect(laneFor("storage.format", { device: "/dev/sdb" })).toEqual(["host"]);
    expect(laneFor("app.backup", { id: "x".repeat(100) })).toEqual(["host"]); // implausible subject
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
    expect(laneFor("app.backup", { id: "jellyfin" })).toEqual(["app:jellyfin", "host"]);
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
