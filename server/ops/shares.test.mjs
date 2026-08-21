import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { shareOperations } from "./shares.mjs";

const operations = Object.fromEntries(shareOperations().map((operation) => [operation.id, operation]));

describe("share operations", () => {
  it("validates SMB and NFS parameters and marks the password secret", () => {
    const spec = operations["share.mount"].parameters;
    expect(validateParameters(spec, { kind: "smb", host: "mycloud.local", share: "Public", name: "nas", username: "chris", password: "pw" }, "t")).toBeNull();
    expect(validateParameters(spec, { kind: "nfs", host: "192.168.1.20", share: "/volume1/media", name: "media", readOnly: true }, "t")).toBeNull();
    expect(validateParameters(spec, { kind: "smb", host: "nas", share: "/volume1/media", name: "x" }, "t")).toContain("share");
    expect(validateParameters(spec, { kind: "nfs", host: "nas", share: "media", name: "x" }, "t")).toContain("absolute");
    expect(validateParameters(spec, { kind: "smb", host: "nas", share: "Public", name: "Bad Name" }, "t")).toContain("name");
    expect(spec.fields.password.secret).toBe(true);
    expect(operations["share.mount"].risk).toBe("medium");
  });

  it("stages both tasks with normalized payloads", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["share.mount"].run({ kind: "smb", host: "nas", share: "Public", name: "nas" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("share.mount", { kind: "smb", host: "nas", share: "Public", name: "nas", username: null, password: null, domain: null, readOnly: false }, expect.anything());
    await operations["share.unmount"].run({ name: "nas" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("share.unmount", { name: "nas" }, expect.anything());
  });
});
