import { describe, expect, it } from "vitest";
import { withData } from "./BackupCenter";

/**
 * A machine snapshot holds settings and secrets, not data. "12 apps" therefore reads as twelve apps
 * protected when it can mean twelve apps that would come back installed and empty.
 */
describe("how much of a snapshot would come back with its data", () => {
  const snapshot = (apps: unknown[]) => ({ artifact: "a", sizeBytes: 1, checksumSha256: null, createdAt: null, contents: { apps } }) as never;

  it("counts the apps that have a backup behind them", () => {
    expect(withData(snapshot([{ id: "a", backups: 2 }, { id: "b", backups: 0 }, { id: "c", backups: 1 }]))).toBe(2);
  });

  it("says nothing rather than zero when the snapshot never recorded it", () => {
    // Snapshots taken before the count existed must not be reported as protecting nothing.
    expect(withData(snapshot([{ id: "a" }, { id: "b" }]))).toBeNull();
    expect(withData(snapshot([]))).toBeNull();
  });

  it("counts none as none, which is the case worth seeing", () => {
    expect(withData(snapshot([{ id: "a", backups: 0 }, { id: "b", backups: 0 }]))).toBe(0);
  });
});
