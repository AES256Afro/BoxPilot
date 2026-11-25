import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { backupCloudOperations } from "./backup-cloud.mjs";

const operations = Object.fromEntries(backupCloudOperations().map((operation) => [operation.id, operation]));

describe("cloud backup operations", () => {
  it("validates destinations per provider, marks credentials secret, and stages the tasks", async () => {
    const setup = operations["backup.cloud.setup"].parameters;
    expect(validateParameters(setup, { provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox", key: "K" }, "t")).toBeNull();
    expect(validateParameters(setup, { provider: "s3", bucket: "bkt", accessKeyId: "AK", secretAccessKey: "SK" }, "t")).toContain("region");
    expect(validateParameters(setup, { provider: "nope" }, "t")).toContain("one of");
    for (const name of ["key", "secretAccessKey", "password", "token", "passphrase"]) expect(setup.fields[name].secret).toBe(true);
    expect(validateParameters(setup, { provider: "b2", account: "a", bucket: "home-backups", key: "K", passphrase: "short" }, "t")).toContain("passphrase");
    expect(validateParameters(setup, { provider: "b2", account: "a", bucket: "home-backups", key: "K", passphrase: "orchard lantern river" }, "t")).toBeNull();
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["backup.cloud.setup"].run({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: "K" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("backup.cloud.setup", expect.objectContaining({ provider: "b2", key: "K" }), expect.anything());
    await operations["backup.cloud.sync"].run({ provider: "b2", account: "a", bucket: "home-backups", path: "homebox", key: null }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenLastCalledWith("backup.cloud.sync", { provider: "b2", account: "a", bucket: "home-backups", path: "homebox" }, expect.anything());
    expect(operations["backup.cloud.test"].risk).toBe("medium");
  });

  it("reports rclone and configuration state without reading secrets back", async () => {
    const state = await operations["backup.cloud.inspect"].run({}, {});
    expect(typeof state.rcloneInstalled).toBe("boolean");
    expect(state.providers.b2).toMatchObject({ label: "Backblaze B2", secrets: ["key", "passphrase"] });
    expect(typeof state.sealed).toBe("boolean");
    expect(JSON.stringify(state)).not.toContain("secret_access_key");
  });
});

describe("reading the cloud copy back (M91)", () => {
  it("lists for an operator, read-only, and fetches for the owner only, one snapshot by name", async () => {
    const list = operations["backup.cloud.snapshots"];
    expect(list).toMatchObject({ readOnly: true, minimumRole: "operator", risk: "low" });
    const fetch = operations["backup.cloud.fetch"];
    expect(fetch).toMatchObject({ risk: "medium", minimumRole: "owner" });
    expect(fetch.readOnly).toBeFalsy();
    const artifact = "machine-snapshot-20261124T020000Z-1a2b3c4d.tar.gz";
    expect(validateParameters(fetch.parameters, { artifact }, "t")).toBeNull();
    for (const bad of ["../x", "machine-snapshot-20261124T020000Z-1a2b3c4d.tar.gz.meta.json", ""]) expect(validateParameters(fetch.parameters, { artifact: bad }, "t")).not.toBeNull();
    expect(validateParameters(fetch.parameters, { artifact, root: "/etc" }, "t")).not.toBeNull();
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await list.run({}, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenLastCalledWith("backup.cloud.snapshots", {}, expect.anything());
    await fetch.run({ artifact }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenLastCalledWith("backup.cloud.fetch", { artifact }, expect.anything());
  });

  it("lets a secret left empty through to the task, which keeps the saved one", () => {
    const setup = operations["backup.cloud.setup"].parameters;
    expect(validateParameters(setup, { provider: "b2", account: "a", bucket: "home-backups", path: "renamed" }, "t")).toBeNull();
  });
});
