// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createStandIns } from "../../packages/harness/src/safety/stand-ins.mjs";
import { fill, slowness } from "../../test/hostile-text.mjs";

/*
 * The stand-ins read every message a run on Claude sends (M45.3), tool output anyone can write
 * included, on the web process's event loop: each of their patterns in linear time (sweep 5).
 */

const shapes = {
  "dotted labels": (n) => fill("a.", n),
  "dotted labels ending .ts": (n) => `${fill("ab.", n - 3)}.ts`,
  "address-like digits": (n) => fill("10.1.", n),
  "MAC-like pairs": (n) => fill("aa:", n),
  "MAC-like pairs with dashes": (n) => fill("aa-", n),
  "a host name repeated": (n) => fill("homebox-", n),
  "a host name run together": (n) => fill("homebox", n),
  "hyphens": (n) => fill("-", n),
};

describe("the stand-ins on text made to be slow", () => {
  it("read every shape in linear time", () => {
    const standIns = createStandIns({ hosts: ["homebox", "nas-attic"], domains: ["homebox.example.org"], users: ["jamie"] });
    const slow = Object.entries(shapes).map(([name, make]) => [name, slowness((text) => standIns.hide(text), make)]).filter(([, problem]) => problem);
    expect(slow).toEqual([]);
  }, 60_000);
});
