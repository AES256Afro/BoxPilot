import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("uses IEC units all the way up", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MiB");
    expect(formatBytes(40 * 1024 ** 3)).toBe("40.0 GiB");
    expect(formatBytes(3.5 * 1024 ** 4)).toBe("3.5 TiB");
  });

  it("shows a placeholder for a size that is not known", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN, "unknown")).toBe("unknown");
    expect(formatBytes(-1)).toBe("—");
  });
});
