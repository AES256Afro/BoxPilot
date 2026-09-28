import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkTokens, contrast, parseColor } from "./check-contrast.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "src", "styles.css"), "utf8");

describe("the design tokens", () => {
  const report = checkTokens(css);

  it("meet the contrast minimums for the main pairs, light and dark", () => {
    expect(report.results.length).toBeGreaterThan(60);
    expect(report.results.filter((result) => !result.ok).map((result) => result.line)).toEqual([]);
  });

  it("keep the System and Light blocks identical", () => {
    expect(report.lightBlocksMatch).toBe(true);
  });

  it("give every dark colour a light value, so no page keeps a dark colour in light mode", () => {
    expect(report.missingLight).toEqual([]);
  });

  it("never draw unknown as green", () => {
    expect(report.unknownGreen).toEqual([]);
  });
});

describe("the arithmetic", () => {
  it("reads hex and both rgb syntaxes", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#0d1117")).toEqual([13, 17, 23, 1]);
    expect(parseColor("rgba(9, 105, 218, 0.3)")).toEqual([9, 105, 218, 0.3]);
    expect(parseColor("rgb(78 170 145 / 16%)")).toEqual([78, 170, 145, 0.16]);
  });

  it("matches the WCAG figures for known pairs", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("fails a pair that falls short", () => {
    const failing = css.replace(/(:root\[data-theme="light"\] \{[\s\S]*?--text-muted: )#59636e;/, "$1#a0a0a0;");
    expect(checkTokens(failing).lightBlocksMatch).toBe(false);
    expect(checkTokens(failing).results.some((result) => !result.ok && result.theme === "light" && result.fg === "--text-muted")).toBe(true);
  });
});
