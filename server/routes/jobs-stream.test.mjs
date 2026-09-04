import { describe, expect, it } from "vitest";
import { outputTailFrom } from "./jobs.mjs";

describe("the last of a job's output, after the live log is gone", () => {
  it("cuts by bytes, so a log with non-ASCII in it keeps its tail", () => {
    // compose prints "✔" (3 bytes, 1 character). Slicing the string by the byte count sent so far
    // skipped two characters per tick mark and silently dropped the end of the log.
    const final = "✔ pulled\n✔ created\nHealthy after 6s\n";
    const sentBytes = Buffer.byteLength("✔ pulled\n");
    expect(outputTailFrom(final, sentBytes)).toBe("✔ created\nHealthy after 6s\n");
  });

  it("sends nothing when everything was already streamed", () => {
    const final = "all of it\n";
    expect(outputTailFrom(final, Buffer.byteLength(final))).toBeNull();
  });

  it("sends nothing when the persisted copy is a truncated suffix", () => {
    // Only the last 2 MiB are kept, so a persisted copy shorter than what was streamed cannot be
    // sliced from the start: the offsets belong to a longer file.
    expect(outputTailFrom("tail only", 5_000_000)).toBeNull();
  });

  it("sends all of it when nothing was streamed", () => {
    expect(outputTailFrom("first line\n", 0)).toBe("first line\n");
  });
});
