import { describe, expect, it, vi } from "vitest";
import { copyVersion, databaseCopyRestore } from "./database-restore.mjs";

const name = "boxpilot-rollback-1.150.0-20261018T101500Z.sqlite3";
const file = () => ({ lstat: async () => ({ isFile: () => true }) });
const options = (overrides = {}) => ({ run: vi.fn(async () => ({ ok: true, stderr: "" })), version: "1.151.0", files: file(), upgradeRunning: async () => null, now: () => new Date("2026-10-19T13:00:00.000Z"), nodeBinary: "/usr/local/bin/node", installDir: "/opt/boxpilot", ...overrides });

describe("starting to put a database copy back", () => {
  it("reads the version a copy was taken from", () => {
    expect(copyVersion(name)).toBe("1.150.0");
    expect(copyVersion("boxpilot-rollback-1.150.0.sqlite3")).toBeNull();
  });

  it("starts its own unit with the copy, the database and this version, and says where the database before goes", async () => {
    const context = options();
    const result = await databaseCopyRestore({ name, database: "/var/lib/boxpilot/boxpilot.sqlite3" }, context);
    expect(result).toEqual({ started: true, unit: "boxpilot-db-restore-20261019T130000Z", name, saved: "boxpilot-rollback-1.151.0-20261019T130000Z.sqlite3" });
    expect(context.run).toHaveBeenCalledWith("/usr/bin/systemd-run", ["--quiet", "--unit", "boxpilot-db-restore-20261019T130000Z", "--description", `BoxPilot: put back ${name}`, "/usr/local/bin/node", "/opt/boxpilot/scripts/boxpilot-db-restore.mjs", name, "/var/lib/boxpilot/boxpilot.sqlite3", "1.151.0", "20261019T130000Z"], expect.anything());
  });

  it("refuses a copy from a newer release, one that is gone, a path, and while an update runs", async () => {
    const database = "/var/lib/boxpilot/boxpilot.sqlite3";
    await expect(databaseCopyRestore({ name: "boxpilot-rollback-1.160.0-20261018T101500Z.sqlite3", database }, options())).rejects.toThrow("newer than this 1.151.0");
    await expect(databaseCopyRestore({ name, database }, options({ files: { lstat: async () => null } }))).rejects.toThrow("not beside the database");
    await expect(databaseCopyRestore({ name: "../boxpilot.sqlite3", database }, options())).rejects.toThrow("Name one of the database copies");
    await expect(databaseCopyRestore({ name, database: "relative.sqlite3" }, options())).rejects.toThrow("database path");
    const busy = options({ upgradeRunning: async () => "pid=42" });
    await expect(databaseCopyRestore({ name, database }, busy)).rejects.toThrow("update is running");
    expect(busy.run).not.toHaveBeenCalled();
  });
});
