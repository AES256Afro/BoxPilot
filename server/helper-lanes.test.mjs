import { describe, expect, it } from "vitest";
import { createLaneQueues, exclusiveLane, laneFor } from "./helper-lanes.mjs";

describe("helper lanes", () => {
  it("gives each app and VM its own lane and keeps shared host work on one", () => {
    expect(laneFor("app.backup", { id: "jellyfin" })).toBe("app:jellyfin");
    expect(laneFor("app.action", { id: "immich", action: "restart" })).toBe("app:immich");
    expect(laneFor("app.install", {})).toBe("host"); // no subject: stay conservative
    expect(laneFor("vm.action", { name: "dev-lab" })).toBe("vm:dev-lab");
    expect(laneFor("vm.create", { name: "dev-lab" })).toBe("host"); // shared pools and libvirt config
    expect(laneFor("vm.media.import", { name: "iso" })).toBe("host");
    expect(laneFor("apt.upgrade", {})).toBe("host");
    expect(laneFor("firewall.set", { enabled: true })).toBe("host");
    expect(laneFor("storage.format", { device: "/dev/sdb" })).toBe("host");
    expect(laneFor("app.backup", { id: "x".repeat(100) })).toBe("host"); // implausible subject
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
    expect(laneFor("host.snapshot.create", {})).toBe(exclusiveLane);
    expect(laneFor("controller.backup.create", {})).toBe(exclusiveLane);
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
