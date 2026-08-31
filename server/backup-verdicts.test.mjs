import { describe, expect, it } from "vitest";
import { foldVerdict, verdictFrom, verdictHistoryLimit } from "./backup-verdicts.mjs";

const at = (day) => `2026-08-${String(day).padStart(2, "0")}T03:30:00.000Z`;
const pass = (day, backup = `2026080${day}T033000Z.tar.gz`) => verdictFrom({ verified: true, id: "jellyfin", backup, checkedAt: at(day), sizeBytes: 10, durationMs: 500 }, "alex");
const fail = (day, reason) => verdictFrom({ verified: false, id: "jellyfin", backup: "x.tar.gz", checkedAt: at(day), reason }, "alex");

describe("restore-rehearsal verdicts", () => {
  it("keeps the newest verdict at the top level and builds a history behind it", () => {
    let entries = {};
    entries = foldVerdict(entries, "jellyfin", pass(1));
    expect(entries.jellyfin).toMatchObject({ verified: true, checkedAt: at(1), by: "alex" });
    expect(entries.jellyfin.history).toHaveLength(1);

    entries = foldVerdict(entries, "jellyfin", fail(2, "The archive could not be unpacked"));
    expect(entries.jellyfin.verified).toBe(false);                     // the badge follows the newest
    expect(entries.jellyfin.reason).toContain("could not be unpacked");
    expect(entries.jellyfin.history.map((entry) => entry.verified)).toEqual([false, true]);   // newest first
  });

  it("adopts a verdict written before histories existed instead of discarding it", () => {
    // What is already in the setting from v1.90.0: a flat verdict with no history array.
    const legacy = { jellyfin: { verified: true, backup: "old.tar.gz", reason: null, checkedAt: at(1), by: "alex" } };
    const entries = foldVerdict(legacy, "jellyfin", pass(2));
    expect(entries.jellyfin.history).toHaveLength(2);
    expect(entries.jellyfin.history[1].backup).toBe("old.tar.gz");
  });

  it("caps the history and never nests one inside another", () => {
    let entries = {};
    for (let day = 1; day <= verdictHistoryLimit + 5; day += 1) entries = foldVerdict(entries, "jellyfin", pass(day));
    expect(entries.jellyfin.history).toHaveLength(verdictHistoryLimit);
    expect(entries.jellyfin.history.every((entry) => !("history" in entry))).toBe(true);
    expect(entries.jellyfin.history[0].checkedAt).toBe(at(verdictHistoryLimit + 5));   // newest first
  });

  it("keeps each app's history to itself", () => {
    let entries = foldVerdict({}, "jellyfin", pass(1));
    entries = foldVerdict(entries, "qbittorrent", fail(1, "missing compose.yaml"));
    expect(entries.jellyfin.verified).toBe(true);
    expect(entries.qbittorrent.verified).toBe(false);
    expect(entries.jellyfin.history).toHaveLength(1);
  });

  it("tolerates a result with fields missing rather than storing undefined", () => {
    expect(verdictFrom({}, null)).toEqual({ verified: false, backup: null, reason: null, sizeBytes: null, durationMs: null, checkedAt: null, by: null });
  });
});
