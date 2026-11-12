import { describe, expect, it } from "vitest";
import { bytes, duration, minutesOf, pagesWords, secondsOf, toolTitle } from "./format";

/*
 * The words the Agents section uses for a budget and a tool (M48.7): "1800 s" and "apps.usage" said
 * nothing to the person reading them.
 */

describe("a budget's seconds in words", () => {
  it("says seconds under a minute, minutes under an hour, hours past it, and drops the seconds past ten minutes", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(60)).toBe("1 min");
    expect(duration(125)).toBe("2 min 5 s");
    expect(duration(1800)).toBe("30 min");
    expect(duration(1810)).toBe("30 min");
    expect(duration(3600)).toBe("1 h");
    expect(duration(5400)).toBe("1 h 30 min");
    expect(duration(10_800)).toBe("3 h");
    expect(duration(86_400)).toBe("24 h");
    expect(duration(3599)).toBe("1 h");   // rounded first, then the unit: it read "60 min"
    expect(bytes(999_999_999)).toBe("1.0 GB");
    expect(bytes(999_600)).toBe("1 MB");
    expect(duration(7170)).toBe("2 h");
  });

  it("is a dash for nothing", () => {
    expect(duration(null)).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(duration(Number.NaN)).toBe("—");
  });
});

describe("a limit kept in seconds, typed in minutes", () => {
  it("shows whole and part minutes, and reads what is typed back into seconds", () => {
    expect(minutesOf(1800)).toBe("30");
    expect(minutesOf(90)).toBe("1.5");
    expect(minutesOf(30)).toBe("0.5");
    expect(minutesOf(100)).toBe("1.67");
    expect(minutesOf(10)).toBe("0.17");
    expect(secondsOf("30")).toBe(1800);
    expect(secondsOf("2.5")).toBe(150);
    expect(secondsOf(" 1. ")).toBe(60);
    expect(secondsOf("0")).toBe(0);
  });

  it("gives every whole second back as itself, across the widest range a limit has", () => {
    for (let value = 0; value <= 86_400; value += 1) {
      if (secondsOf(minutesOf(value)) !== value) throw new Error(`${value} s came back as ${secondsOf(minutesOf(value))}`);
    }
  });

  it("is no number while nothing, a word or less than nothing is typed", () => {
    for (const typed of ["", "   ", "abc", "-", "-5", "1e999", "NaN"]) expect(secondsOf(typed), typed).toBeNull();
  });
});

describe("how much a run can read, in pages", () => {
  it("counts about 500 tokens a page, and never says no pages", () => {
    expect(pagesWords(12_000)).toBe("about 24 pages");
    expect(pagesWords(24_000)).toBe("about 48 pages");
    expect(pagesWords(500)).toBe("about 1 page");
    expect(pagesWords(100)).toBe("about 1 page");
    expect(pagesWords(96_000)).toBe("about 192 pages");
  });
});

describe("a tool's title", () => {
  const tools = [{ id: "apps.usage", title: "App usage" }, { id: "server.facts", title: "Server facts" }];
  it("is the catalog's title for its id, however the model spelt it, and the dotted id when the catalog does not know it", () => {
    expect(toolTitle(tools, "apps.usage")).toBe("App usage");
    expect(toolTitle(tools, "apps_usage")).toBe("App usage");
    expect(toolTitle(tools, "drives_list")).toBe("drives.list");
    expect(toolTitle(null, "server_facts")).toBe("server.facts");
    expect(toolTitle(tools, null)).toBe("");
  });
});
