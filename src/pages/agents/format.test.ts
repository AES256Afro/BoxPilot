import { describe, expect, it } from "vitest";
import { duration, toolTitle } from "./format";

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
    expect(duration(3599)).toBe("60 min");
    expect(duration(7170)).toBe("2 h");
  });

  it("is a dash for nothing", () => {
    expect(duration(null)).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(duration(Number.NaN)).toBe("—");
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
