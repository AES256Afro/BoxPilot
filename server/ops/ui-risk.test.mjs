import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { operationRisk, riskOf } from "../../src/ui/operationRisk.ts";

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
});
