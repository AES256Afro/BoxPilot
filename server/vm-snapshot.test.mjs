import { describe, expect, it } from "vitest";
import { snapshotDiskRevision, snapshotInventoryRevision } from "./vm-snapshot.mjs";

describe("VM snapshot revision helpers", () => {
  it("hashes snapshot inventories order-independently", () => {
    const first = snapshotInventoryRevision(["b", "a"]);
    expect(snapshotInventoryRevision([{ name: "a" }, { name: "b" }])).toBe(first);
    expect(snapshotInventoryRevision(["a"])).not.toBe(first);
    expect(snapshotInventoryRevision([])).toBe(snapshotInventoryRevision([]));
  });

  it("hashes disk topologies by their stable fields only", () => {
    const disks = [
      { type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/a.qcow2", extra: "ignored" },
      { type: "file", device: "disk", target: "vdb", source: "/var/lib/libvirt/images/b.qcow2" },
    ];
    const revision = snapshotDiskRevision(disks);
    expect(snapshotDiskRevision([disks[1], disks[0]])).toBe(revision);
    expect(snapshotDiskRevision([disks[0]])).not.toBe(revision);
  });
});
