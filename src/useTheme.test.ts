import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyThemeChoice, readThemeChoice, reloadThemeChoice } from "./useTheme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
});

afterEach(() => vi.restoreAllMocks());

describe("the theme choice", () => {
  it("defaults to System", () => {
    expect(readThemeChoice()).toEqual({ appearance: "system" });
  });

  it("reads a chosen appearance", () => {
    window.localStorage.setItem("boxpilot-theme", "dark");
    expect(readThemeChoice()).toEqual({ appearance: "dark" });
    window.localStorage.setItem("boxpilot-theme", "light");
    expect(readThemeChoice()).toEqual({ appearance: "light" });
  });

  it("treats a retired palette as System, and clears what the palettes left behind", () => {
    // Before M33.1 the palette id sat under boxpilot-theme; after it, under boxpilot-palette.
    window.localStorage.setItem("boxpilot-theme", "solarized");
    window.localStorage.setItem("boxpilot-palette", "nord");
    document.documentElement.setAttribute("data-palette", "nord");
    expect(reloadThemeChoice()).toEqual({ appearance: "system" });
    expect(window.localStorage.getItem("boxpilot-theme")).toBeNull();
    expect(window.localStorage.getItem("boxpilot-palette")).toBeNull();
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
  });

  it("keeps a chosen appearance while clearing a retired palette beside it", () => {
    window.localStorage.setItem("boxpilot-theme", "dark");
    window.localStorage.setItem("boxpilot-palette", "amber");
    expect(reloadThemeChoice()).toEqual({ appearance: "dark" });
    expect(window.localStorage.getItem("boxpilot-theme")).toBe("dark");
    expect(window.localStorage.getItem("boxpilot-palette")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("follows the device when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readThemeChoice()).toEqual({ appearance: "system" });
  });

  it("sets and clears the attribute the stylesheet reads", () => {
    applyThemeChoice({ appearance: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyThemeChoice({ appearance: "system" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
