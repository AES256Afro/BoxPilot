import { expect, it } from "vitest";
import { hiddenOutputNotice, jobOutputText, maxDisplayedJobOutputChars as limit } from "./jobOutputText";

it("keeps a bounded tail across repeated stream fragments", () => {
  let output = "";
  for (let n = 0; n < 100; n++) output = jobOutputText(output, `${"x".repeat(10_000)}${n}\n`, true);
  expect(output.length).toBeLessThanOrEqual(limit + hiddenOutputNotice.length);
  expect(output.startsWith(hiddenOutputNotice)).toBe(true);
  expect(output.endsWith("99\n")).toBe(true);
  expect(output.split(hiddenOutputNotice)).toHaveLength(2);
});

it("replaces full snapshots and does not split Unicode pairs at the tail boundary", () => {
  const output = jobOutputText("older", `prefix🙂${"a".repeat(limit - 1)}`);
  expect(output).toBe(hiddenOutputNotice + "a".repeat(limit - 1));
  expect(jobOutputText(output, "new snapshot")).toBe("new snapshot");
  expect(jobOutputText("hello", "🙂", true)).toBe("hello🙂");
});
