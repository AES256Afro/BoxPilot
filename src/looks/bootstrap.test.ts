import { describe, expect, it } from "vitest";
import page from "../../index.html?raw";
import { ACCENTS, LOOK_IDS, WALLPAPERS } from "./looks";

/*
 * index.html draws the look before the first paint (M41) from what this browser stored. It sets an
 * attribute only for a value Settings offers, and its lists are copies of the ones in looks.ts, so
 * they have to stay the same.
 */

const listBefore = (marker: string) => {
  const at = page.indexOf(marker);
  const list = page.lastIndexOf("[", at);
  return JSON.parse(page.slice(list, page.indexOf("]", list) + 1).replace(/'/g, '"')) as string[];
};

describe("the look before the first paint", () => {
  it("knows every look", () => {
    const list = page.slice(page.indexOf("var looks = ["), page.indexOf("];", page.indexOf("var looks = [")) + 1);
    expect(JSON.parse(list.slice(list.indexOf("[")).replace(/'/g, '"'))).toEqual([...LOOK_IDS]);
  });

  it("sets an accent or a wallpaper only from Settings' own choices", () => {
    expect(listBefore(".indexOf(accent)")).toEqual(ACCENTS.map((accent) => accent.id).filter((id) => id !== "sea"));
    expect(listBefore(".indexOf(wallpaper)")).toEqual(WALLPAPERS.map((wallpaper) => wallpaper.id).filter((id) => id !== "sea"));
  });
});
