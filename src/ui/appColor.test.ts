import { describe, expect, it } from "vitest";
import { APP_HUES, appHue, knownAppHues } from "./appColor";

// Every manifest id, and the stylesheet, read the way App.test.tsx reads the catalog.
const manifests = import.meta.glob<string>("../../catalog/*.yaml", { query: "?raw", import: "default", eager: true });
const ids = Object.values(manifests).map((text) => /^id:\s*["']?([\w.-]+)["']?\s*$/m.exec(text)?.[1]).filter((id): id is string => Boolean(id));
const css = Object.values(import.meta.glob<string>("../styles.css", { query: "?raw", import: "default", eager: true }))[0] ?? "";

describe("an app's colour", () => {
  it("is the same every time for the same app, whatever the case or spacing of its id", () => {
    expect(appHue("stirling-pdf")).toBe(appHue("stirling-pdf"));
    expect(appHue(" Stirling-PDF ")).toBe(appHue("stirling-pdf"));
    expect(APP_HUES).toContain(appHue("an-app-nobody-has-heard-of"));
  });

  it("is the colour people know for the well-known apps", () => {
    expect(appHue("jellyfin")).toBe("violet");
    expect(appHue("pi-hole")).toBe("red");
    expect(appHue("nextcloud")).toBe("sky");
    expect(appHue("vaultwarden")).toBe("blue");
  });

  it("names only apps the catalog has, so the list cannot rot", () => {
    expect(ids.length).toBeGreaterThan(100);
    expect(Object.keys(knownAppHues).filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("spreads the catalog across the palette rather than piling it on one hue", () => {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(appHue(id), (counts.get(appHue(id)) ?? 0) + 1);
    expect(counts.size).toBe(APP_HUES.length);
    expect(Math.max(...counts.values())).toBeLessThan(ids.length / 4);
  });

  it("has both stops of every hue as tokens, and a rule that applies them", () => {
    for (const hue of APP_HUES) {
      expect(css).toContain(`--brand-${hue}-a:`);
      expect(css).toContain(`--brand-${hue}-b:`);
      expect(css).toContain(`[data-hue="${hue}"] { --app-a: var(--brand-${hue}-a); --app-b: var(--brand-${hue}-b); }`);
    }
  });
});
