import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { mayStart, operationRisk, ownerOnlyOperations, riskOf } from "../../src/ui/operationRisk.ts";

// The interface draws each action's risk tier on its button before the click (ADR-004). Those
// tiers are written into the UI so the button can render before anything is fetched, which is
// only safe while they agree with the registry the approval policy actually uses.
describe("the risk tiers drawn on buttons", () => {
  it("are the registry's tiers for every operation a rebuilt page starts", () => {
    for (const [id, tier] of Object.entries(operationRisk)) {
      const operation = registry.get(id);
      expect(operation, `${id} is not a registered operation`).not.toBeNull();
      expect({ id, risk: operation.risk }).toEqual({ id, risk: tier });
    }
  });

  it("treat an operation missing from the table as high, as the server does", () => {
    expect(riskOf("no.such.operation")).toBe("high");
  });

  // Home and Ops leave out the buttons a role cannot use (M33.2), so the owner-only list is held
  // to the registry's minimumRole the same way the tiers are.
  it("mark as owner-only exactly the operations the registry keeps for the owner", () => {
    for (const id of Object.keys(operationRisk)) {
      expect({ id, ownerOnly: ownerOnlyOperations.has(id) }).toEqual({ id, ownerOnly: registry.get(id).minimumRole === "owner" });
    }
    for (const id of ownerOnlyOperations) expect(id in operationRisk, `${id} is owner-only but has no tier`).toBe(true);
  });

  // Home and Ops offer each Repair finding's fix from their lists, with the tier on the button. A
  // fix whose operation had no entry would be drawn as high, which is wrong the other way.
  it("have a tier for every fix Repair can offer", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "remediations.mjs"), "utf8");
    const fixes = [...new Set([...source.matchAll(/operationId: "([a-z][\w.-]+)"/g)].map((match) => match[1]))];
    expect(fixes.length).toBeGreaterThan(5);
    expect(fixes.filter((id) => !(id in operationRisk))).toEqual([]);
  });

  // The first test only reads the table against the registry, so an id a page names that the
  // table lacks went unseen: the schedule templates offered "docker.prune" (medium) as a plain
  // string, and it would have been drawn as high. riskOf/mayStart literals are held by tsc
  // (KnownOperation); this holds every other spelling: any string in the UI's own source that is a
  // registered operation which changes something must have its tier here.
  //
  // It is deliberately not "every registry operation": four that change something have no entry and
  // need none. apt.purge is high, which is what a missing entry draws anyway; job.output.release is
  // the server's own log tidying; agents.zulip.post is internal; http.request is offered only by the
  // automation step picker, which draws the tier the server sends with each step. Requiring them
  // would put tiers in the UI for buttons that do not exist.
  it("have a tier for every changing operation the UI's own source names", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const sources = readdirSync(root, { recursive: true }).map(String)
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
    const changing = new Set(registry.list().filter((operation) => !operation.readOnly).map((operation) => operation.id));
    const named = new Set();
    for (const file of sources) {
      for (const match of readFileSync(path.join(root, file), "utf8").matchAll(/["'`]([a-z][\w-]*(?:\.[\w-]+)+)["'`]/g)) {
        if (changing.has(match[1])) named.add(`${match[1]} (${file})`);
      }
    }
    expect(named.size).toBeGreaterThan(50);
    expect([...named].filter((entry) => !(entry.split(" ")[0] in operationRisk))).toEqual([]);
  });

  it("let a role start only what jobs.mjs would let it stage", () => {
    expect(mayStart("owner", "system.reboot")).toBe(true);
    expect(mayStart("operator", "system.reboot")).toBe(false);
    expect(mayStart("operator", "backup.cloud.sync")).toBe(false);
    expect(mayStart("operator", "app.action")).toBe(true);
    expect(mayStart("viewer", "app.action")).toBe(false);
    expect(mayStart(undefined, "app.action")).toBe(false);
  });
});
