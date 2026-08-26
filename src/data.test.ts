import { describe, expect, it } from "vitest";
import { countOf, sentenceList, viewLabel, navItems } from "./data";

describe("naming several things in a sentence", () => {
  it("joins them the way a person would say them", () => {
    // The Virtual Machines page listed what it could not read as "exports, recoveries, retention",
    // which reads like a list that got cut off rather than a finished sentence. The serial comma
    // is what the rest of the copy uses ("SSH, Tailscale, and BoxPilot"), so it is kept.
    expect(sentenceList(["exports", "recoveries", "retention"])).toBe("exports, recoveries, and retention");
    expect(sentenceList(["exports", "retention"])).toBe("exports and retention");
    expect(sentenceList(["exports"])).toBe("exports");
    expect(sentenceList([])).toBe("");
  });
});

describe("the name a page is known by", () => {
  it("matches what the navigation calls it, for every page", () => {
    // The error boundary names the page it caught, so this has to be the word on the button.
    for (const item of navItems) expect(viewLabel(item.id)).toBe(item.label);
  });
});

describe("counting things in a sentence", () => {
  it("agrees the noun with the number", () => {
    // The Backups page told people their data had been copied off "1 days ago".
    expect(countOf(1, "day")).toBe("1 day");
    expect(countOf(0, "day")).toBe("0 days");
    expect(countOf(3, "day")).toBe("3 days");
    expect(countOf(1, "copy", "copies")).toBe("1 copy");
    expect(countOf(2, "copy", "copies")).toBe("2 copies");
  });
});
