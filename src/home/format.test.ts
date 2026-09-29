import { describe, expect, it } from "vitest";
import { shortCpu } from "./format";

describe("a processor's name", () => {
  it("is said the way a person says it", () => {
    expect(shortCpu("AMD Ryzen 7 7800X3D 8-Core Processor")).toBe("AMD Ryzen 7 7800X3D");
    expect(shortCpu("Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz")).toBe("Intel Core i5-8500T");
    expect(shortCpu("AMD Ryzen 5 5600G with Radeon Graphics")).toBe("AMD Ryzen 5 5600G");
    expect(shortCpu("Intel(R) N100")).toBe("Intel N100");
  });

  it("stays empty when the inventory did not name one", () => {
    expect(shortCpu("")).toBe("");
  });
});
