import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { sambaOperations } from "./samba.mjs";

const operations = Object.fromEntries(sambaOperations().map((operation) => [operation.id, operation]));

describe("samba operations", () => {
  it("validates shares through the task validator and stages the normalized payload", async () => {
    const spec = operations["samba.apply"].parameters;
    expect(validateParameters(spec, { shares: [{ name: "Media", path: "/mnt/nas-media", readOnly: true, guest: true }] }, "t")).toBeNull();
    expect(validateParameters(spec, { scope: "lan", workgroup: "HOME", shares: [] }, "t")).toBeNull();
    expect(validateParameters(spec, { shares: [{ name: "global", path: "/srv" }] }, "t")).toContain("invalid");
    expect(validateParameters(spec, { scope: "everyone", shares: [] }, "t")).toContain("one of");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["samba.apply"].run({ shares: [{ name: "Media", path: "/mnt/nas-media", guest: true }] }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("samba.apply", { workgroup: "WORKGROUP", scope: "tailscale", shares: [{ name: "Media", path: "/mnt/nas-media", comment: null, readOnly: false, guest: true, users: [] }] }, expect.anything());
    expect(operations["samba.apply"].risk).toBe("medium");
  });

  it("keeps the user password secret and validates its length", async () => {
    const spec = operations["samba.user.set"].parameters;
    expect(spec.fields.password.secret).toBe(true);
    expect(validateParameters(spec, { username: "sam", password: "short" }, "t")).toContain("8 characters");
    expect(validateParameters(spec, { username: "sam", password: "long enough" }, "t")).toBeNull();
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["samba.user.remove"].run({ username: "sam" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("samba.user.remove", { username: "sam" }, expect.anything());
  });

  it("reads state from smb.conf and the sambashare group", async () => {
    const run = vi.fn(async (binary, args) => (args[0] === "is-active" ? { ok: true, stdout: "active\n", stderr: "" } : args[0] === "group" ? { ok: true, stdout: "sambashare:x:125:sam,jamie\n", stderr: "" } : { ok: false, stdout: "", stderr: "" }));
    const result = await operations["samba.inspect"].run({}, { run });
    expect(result.users).toEqual(["jamie", "sam"]);
    expect(typeof result.installed).toBe("boolean");
    expect(result.config).toHaveProperty("shares");
    if (!result.installed) expect(result.running).toBeNull();
  });
});

describe("nfs operations", () => {
  it("validates exports through the task validator and stages the normalized payload", async () => {
    const { nfsOperations } = await import("./nfs.mjs");
    const ops = Object.fromEntries(nfsOperations().map((operation) => [operation.id, operation]));
    const spec = ops["nfs.apply"].parameters;
    expect(validateParameters(spec, { exports: [{ path: "/srv/media", readOnly: true }] }, "t")).toBeNull();
    expect(validateParameters(spec, { scope: "lan", exports: [{ path: "/etc" }] }, "t")).toContain("system locations");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await ops["nfs.apply"].run({ exports: [{ path: "/srv/media" }] }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("nfs.apply", { scope: "tailscale", exports: [{ path: "/srv/media", readOnly: false }] }, expect.anything());
    const state = await ops["nfs.inspect"].run({}, { run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })) });
    expect(state).toHaveProperty("config.exports");
  });
});
