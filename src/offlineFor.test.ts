import { describe, expect, it } from "vitest";
import { offlineFor } from "./AppCatalog";

/**
 * Backing an app up stops it. Whether that matters depends on the app and on how long, and the
 * number has been in every backup record from the start without ever being shown.
 */
describe("how long an app was offline for a backup", () => {
  it("does not make a fuss about a fraction of a second", () => {
    expect(offlineFor(191)).toBe("under a second");
    expect(offlineFor(999)).toBe("under a second");
  });

  it("is precise where the difference is worth seeing", () => {
    expect(offlineFor(1000)).toBe("1.0 seconds");
    expect(offlineFor(10268)).toBe("10 seconds");
  });

  it("switches to minutes once seconds stop being useful", () => {
    expect(offlineFor(180_000)).toBe("3 minutes");
  });

  it("says nothing rather than zero when the record does not have it", () => {
    // An older backup that never recorded downtime must not read as "no downtime".
    expect(offlineFor(null)).toBe("—");
  });
});
