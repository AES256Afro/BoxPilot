import { describe, expect, it } from "vitest";
import { formatMemory } from "./virtualization";

describe("virtualization helpers", () => {
  it("formats libvirt KiB memory values", () => {
    expect(formatMemory(4 * 1024 * 1024)).toBe("4 GiB");
    expect(formatMemory(1536 * 1024)).toBe("1.5 GiB");
    expect(formatMemory(0)).toBe("Unknown");
  });
});
