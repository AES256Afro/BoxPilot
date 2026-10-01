import { describe, expect, it } from "vitest";
import { buildCommands, searchCommands } from "./commandIndex";

describe("the command bar's index", () => {
  it("finds Appearance by the words people look for it by, and opens Settings at that tab", () => {
    const commands = buildCommands([]);
    for (const words of ["appearance", "look", "dark mode", "wallpaper", "theme"]) {
      const found = searchCommands(commands, words).find((command) => command.id === "settings:appearance");
      expect(found, words).toMatchObject({ view: "settings", tab: "appearance", label: "Appearance" });
    }
  });
});
