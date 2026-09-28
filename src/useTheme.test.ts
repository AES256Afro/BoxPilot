import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyThemeChoice, readThemeChoice, reloadThemeChoice } from "./useTheme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
});

afterEach(() => vi.restoreAllMocks());

describe("the theme choice", () => {
  it("defaults to System and the Raw palette", () => {
    expect(readThemeChoice()).toEqual({ appearance: "system", palette: "raw" });
  });

  it("reads a chosen appearance and palette", () => {
    window.localStorage.setItem("boxpilot-theme", "dark");
    window.localStorage.setItem("boxpilot-palette", "nord");
    expect(readThemeChoice()).toEqual({ appearance: "dark", palette: "nord" });
  });

  it("reads a palette stored under the old key as the palette, and moves it", () => {
    window.localStorage.setItem("boxpilot-theme", "solarized");
    expect(reloadThemeChoice()).toEqual({ appearance: "system", palette: "solarized" });
    expect(window.localStorage.getItem("boxpilot-theme")).toBeNull();
    expect(window.localStorage.getItem("boxpilot-palette")).toBe("solarized");
    expect(document.documentElement.getAttribute("data-palette")).toBe("solarized");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("treats the old default and anything unknown as System and Raw", () => {
    window.localStorage.setItem("boxpilot-theme", "default");
    expect(reloadThemeChoice()).toEqual({ appearance: "system", palette: "raw" });
    window.localStorage.setItem("boxpilot-theme", "purple");
    window.localStorage.setItem("boxpilot-palette", "purple");
    expect(readThemeChoice()).toEqual({ appearance: "system", palette: "raw" });
  });

  it("follows the device when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readThemeChoice()).toEqual({ appearance: "system", palette: "raw" });
  });

  it("sets and clears the attributes the stylesheet reads", () => {
    applyThemeChoice({ appearance: "light", palette: "amber" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-palette")).toBe("amber");
    applyThemeChoice({ appearance: "system", palette: "raw" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
  });
});
