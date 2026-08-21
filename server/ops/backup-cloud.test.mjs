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
    for (const name of ["key", "secretAccessKey", "password", "token"]) expect(setup.fields[name].secret).toBe(true);
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
    expect(state.providers.b2).toMatchObject({ label: "Backblaze B2", secrets: ["key"] });
    expect(JSON.stringify(state)).not.toContain("secret_access_key");
  });
});
