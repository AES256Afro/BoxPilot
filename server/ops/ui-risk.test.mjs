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

  it("let a role start only what jobs.mjs would let it stage", () => {
    expect(mayStart("owner", "system.reboot")).toBe(true);
    expect(mayStart("operator", "system.reboot")).toBe(false);
    expect(mayStart("operator", "backup.cloud.sync")).toBe(false);
    expect(mayStart("operator", "app.action")).toBe(true);
    expect(mayStart("viewer", "app.action")).toBe(false);
    expect(mayStart(undefined, "app.action")).toBe(false);
  });
});
