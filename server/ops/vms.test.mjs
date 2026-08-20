import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { vmOperations } from "./vms.mjs";

const operations = Object.fromEntries(vmOperations().map((operation) => [operation.id, operation]));

/** virsh fake with a domain table: { name: { state, snapshots } }. Records calls. */
function fakeRun(domains = {}) {
  return vi.fn(async (_binary, args) => {
    const [, , command, name, ...rest] = args;
    const domain = domains[name];
    if (command === "domstate") return domain ? { ok: true, stdout: `${domain.state}\n`, stderr: "" } : { ok: false, stdout: "", stderr: "error: failed to get domain" };
    if (command === "snapshot-list") return domain ? { ok: true, stdout: domain.snapshots.join("\n"), stderr: "" } : { ok: false, stdout: "", stderr: "no domain" };
    if (command === "destroy") { domain.state = "shut off"; return { ok: true, stdout: "", stderr: "" }; }
    if (command === "undefine") { delete domains[name]; return { ok: true, stdout: "", stderr: "" }; }
    if (command === "snapshot-revert") return { ok: true, stdout: "", stderr: "" };
    if (command === "snapshot-delete") { domain.snapshots = domain.snapshots.filter((snapshot) => snapshot !== rest[0]); return { ok: true, stdout: "", stderr: "" }; }
    return { ok: false, stdout: "", stderr: `unknown ${command}` };
  });
}

describe("vm lifecycle operations", () => {
  it("starts, gracefully stops, reboots, and toggles autostart with state guards", async () => {
    const domains = { "dev-box": { state: "shut off", snapshots: [] } };
    const run = vi.fn(async (_binary, args) => {
      const [, , command, name, ...rest] = args;
      const domain = domains[name ?? rest.at(-1)] ?? domains[args.at(-1)];
      if (command === "domstate") return domain ? { ok: true, stdout: `${domain.state}\n`, stderr: "" } : { ok: false, stdout: "", stderr: "no domain" };
      if (command === "start") { domain.state = "running"; return { ok: true, stdout: "", stderr: "" }; }
      if (command === "shutdown") { domain.state = "shut off"; return { ok: true, stdout: "", stderr: "" }; }
      if (command === "reboot") return { ok: true, stdout: "", stderr: "" };
      if (command === "autostart") { domain.autostart = !args.includes("--disable"); return { ok: true, stdout: "", stderr: "" }; }
      if (command === "dominfo") return { ok: true, stdout: `Autostart:      ${domain.autostart ? "enable" : "disable"}\n`, stderr: "" };
      return { ok: false, stdout: "", stderr: `unknown ${command}` };
    });
    const wait = vi.fn(async () => {});

    await expect(operations["vm.action"].run({ name: "dev-box", action: "shutdown" }, { run, wait })).rejects.toThrow("needs a running VM");
    await expect(operations["vm.action"].run({ name: "dev-box", action: "start" }, { run, wait })).resolves.toMatchObject({ action: "start", state: "running" });
    await expect(operations["vm.action"].run({ name: "dev-box", action: "start" }, { run, wait })).rejects.toThrow("only a stopped VM");
    await expect(operations["vm.action"].run({ name: "dev-box", action: "reboot" }, { run, wait })).resolves.toMatchObject({ action: "reboot", state: "running" });
    await expect(operations["vm.action"].run({ name: "dev-box", action: "shutdown" }, { run, wait })).resolves.toMatchObject({ action: "shutdown", state: "shut off" });
    expect(run).toHaveBeenCalledWith(expect.anything(), ["--connect", "qemu:///system", "shutdown", "dev-box"], expect.anything());

    await expect(operations["vm.action"].run({ name: "dev-box", action: "autostart-on" }, { run, wait })).resolves.toMatchObject({ autostart: true });
    await expect(operations["vm.action"].run({ name: "dev-box", action: "autostart-off" }, { run, wait })).resolves.toMatchObject({ autostart: false });
    expect(run).toHaveBeenCalledWith(expect.anything(), ["--connect", "qemu:///system", "autostart", "--disable", "dev-box"], expect.anything());
  });

  it("forces off a running VM and refuses one that is already off", async () => {
    const domains = { "dev-box": { state: "running", snapshots: [] } };
    const run = fakeRun(domains);
    await expect(operations["vm.force-off"].run({ name: "dev-box" }, { run })).resolves.toMatchObject({ previousState: "running", state: "shut off" });
    await expect(operations["vm.force-off"].run({ name: "dev-box" }, { run })).rejects.toThrow("already off");
  });

  it("deletes only a stopped VM, with snapshot metadata and optional storage", async () => {
    const domains = { "dev-box": { state: "running", snapshots: [] } };
    const run = fakeRun(domains);
    await expect(operations["vm.delete"].run({ name: "dev-box", deleteStorage: true }, { run })).rejects.toThrow("force it off first");
    domains["dev-box"].state = "shut off";
    await expect(operations["vm.delete"].run({ name: "dev-box", deleteStorage: true }, { run })).resolves.toMatchObject({ deleted: true, storageDeleted: true });
    expect(run).toHaveBeenCalledWith(expect.anything(), ["--connect", "qemu:///system", "undefine", "dev-box", "--snapshots-metadata", "--remove-all-storage", "--nvram"], expect.anything());
    await expect(operations["vm.delete"].run({ name: "dev-box", deleteStorage: false }, { run })).rejects.toThrow("not found");
  });

  it("reverts a snapshot only while the VM is off and the snapshot exists", async () => {
    const domains = { "dev-box": { state: "shut off", snapshots: ["clean-install"] } };
    const run = fakeRun(domains);
    await expect(operations["vm.snapshot.revert"].run({ name: "dev-box", snapshotName: "missing" }, { run })).rejects.toThrow("does not exist");
    await expect(operations["vm.snapshot.revert"].run({ name: "dev-box", snapshotName: "clean-install" }, { run })).resolves.toMatchObject({ reverted: true });
    domains["dev-box"].state = "running";
    await expect(operations["vm.snapshot.revert"].run({ name: "dev-box", snapshotName: "clean-install" }, { run })).rejects.toThrow("only while it is off");
  });

  it("deletes a snapshot and validates parameters at the registry boundary", async () => {
    const domains = { "dev-box": { state: "running", snapshots: ["clean-install"] } };
    const run = fakeRun(domains);
    await expect(operations["vm.snapshot.delete"].run({ name: "dev-box", snapshotName: "clean-install" }, { run })).resolves.toMatchObject({ deleted: true });
    expect(domains["dev-box"].snapshots).toEqual([]);
    expect(validateParameters(operations["vm.delete"].parameters, { name: "dev-box", deleteStorage: true }, "t")).toBeNull();
    expect(validateParameters(operations["vm.delete"].parameters, { name: "bad name!", deleteStorage: true }, "t")).toContain("invalid value");
    expect(validateParameters(operations["vm.snapshot.revert"].parameters, { name: "dev-box" }, "t")).toContain("snapshotName");
    expect(operations["vm.delete"].risk).toBe("high");
    expect(operations["vm.snapshot.revert"].risk).toBe("high");
  });
});
