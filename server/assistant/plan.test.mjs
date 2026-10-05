// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRegistry, defineOperation, operationModules } from "../ops/index.mjs";
import { createCatalogService, installRiskLookup } from "../catalog/index.mjs";
import { extractPlan, maxPlanSteps, refusalFor, validatePlan } from "./plan.mjs";

const run = () => ({});
const idField = { type: "string", pattern: /^[a-z0-9][a-z0-9-]{0,62}$/ };
const registry = createRegistry([[
  defineOperation({ id: "app.restart", title: "Restart an application", risk: "low", parameters: { fields: { id: idField } }, run }),
  defineOperation({ id: "app.update", title: "Update an application", risk: "medium", parameters: { fields: { id: idField } }, run }),
  defineOperation({ id: "app.purge", title: "Uninstall application and delete its data", risk: "high", confirm: (parameters) => parameters.id, parameters: { fields: { id: idField } }, run }),
  defineOperation({ id: "app.backup.restore", title: "Restore application data from a backup", risk: "high", confirm: (parameters) => (parameters.allowCompose ? `allow ${parameters.id}` : null), confirmWhen: "it starts a backup's own compose file as it was archived", parameters: { fields: { id: idField, backup: { type: "string" }, allowCompose: { type: "string", optional: true } } }, run }),
  defineOperation({ id: "credentials.remove", title: "Remove a credential", risk: "medium", minimumRole: "owner", parameters: { fields: { name: { type: "string" } } }, run }),
  defineOperation({ id: "credentials.set", title: "Save a credential", risk: "medium", minimumRole: "owner", parameters: { fields: { name: { type: "string" }, value: { type: "string", secret: true } } }, run }),
  defineOperation({ id: "app.install", title: "Install an application", risk: "medium", parameters: { fields: { id: idField, values: { type: "object", optional: true, secretEnvOf: "id" } } }, run }),
  defineOperation({ id: "app.logs", title: "Read application logs", risk: "low", readOnly: true, minimumRole: "operator", parameters: { fields: { id: idField, lines: { type: "number", optional: true } } }, run }),
  defineOperation({ id: "app.secrets", title: "Reveal application secrets", risk: "low", readOnly: true, elevatedOnly: true, minimumRole: "owner", parameters: { fields: { id: idField } }, run }),
]]);

describe("extractPlan", () => {
  it("takes the plan block out of the answer and reads its steps", () => {
    const text = 'Jellyfin keeps restarting [S2].\n\n```plan\n[{"operationId": "app.restart", "parameters": {"id": "jellyfin"}, "why": "Start it cleanly."}]\n```\n';
    const { answer, steps, problem } = extractPlan(text);
    expect(answer).toBe("Jellyfin keeps restarting [S2].");
    expect(steps).toEqual([{ operationId: "app.restart", parameters: { id: "jellyfin" }, why: "Start it cleanly." }]);
    expect(problem).toBeNull();
  });

  it("accepts a block labelled json when it is plainly a plan, and leaves other code alone", () => {
    expect(extractPlan('Do this.\n```json\n[{"operationId": "app.restart", "parameters": {"id": "x"}}]\n```').steps).toHaveLength(1);
    const other = extractPlan('Example:\n```json\n{"port": 8096}\n```');
    expect(other.steps).toBeNull();
    expect(other.answer).toContain('"port": 8096');
  });

  it("says a block the model was cut off in the middle of could not be read, rather than guessing", () => {
    const { answer, steps, problem } = extractPlan('Restart it.\n```plan\n[{"operationId": "app.rest');
    expect(answer).toBe("Restart it.");
    expect(steps).toEqual([]);
    expect(problem).toBe("The plan was cut off before it ended");
  });

  it("answers no steps when there is no block", () => {
    expect(extractPlan("Nothing to do.")).toEqual({ answer: "Nothing to do.", steps: null, problem: null });
  });
});

describe("validatePlan", () => {
  it("keeps a valid step with its title, tier and the request that would stage it", async () => {
    const { steps, dropped } = await validatePlan([{ operationId: "app.update", parameters: { id: "jellyfin" }, why: "An update is available." }], { registry, role: "operator" });
    expect(dropped).toEqual([]);
    expect(steps).toEqual([{
      operationId: "app.update", title: "Update an application", risk: "medium", readOnly: false, approval: "One confirmation, with a preview", typedConfirmation: false,
      parameters: { id: "jellyfin" }, why: "An update is available.",
      request: { method: "POST", path: "/api/v1/operations/app.update/jobs", body: { parameters: { id: "jellyfin" } } },
    }]);
  });

  it("drops an operation that does not exist", async () => {
    const { steps, dropped } = await validatePlan([{ operationId: "app.reboot-everything", parameters: {} }], { registry, role: "owner" });
    expect(steps).toEqual([]);
    expect(dropped).toEqual([{ index: 0, operationId: "app.reboot-everything", reason: "BoxPilot has no operation called app.reboot-everything" }]);
  });

  it("drops a step whose parameters the registry refuses, with the registry's own words", async () => {
    const { dropped } = await validatePlan([
      { operationId: "app.restart", parameters: { id: "Not An Id" } },
      { operationId: "app.restart", parameters: {} },
      { operationId: "app.restart", parameters: { id: "jellyfin", force: true } },
      { operationId: "app.restart", parameters: "jellyfin" },
    ], { registry, role: "owner" });
    expect(dropped.map((entry) => entry.reason)).toEqual([
      'Restart an application parameter "id" has an invalid value',
      'Restart an application requires parameter "id"',
      'Restart an application does not accept parameter "force"',
      "Its parameters are not a set of named values",
    ]);
  });

  it("drops what the person asking could not approve", async () => {
    const plan = [
      { operationId: "app.purge", parameters: { id: "jellyfin" } },
      { operationId: "credentials.remove", parameters: { name: "ntfy" } },
      { operationId: "app.restart", parameters: { id: "jellyfin" } },
    ];
    const operator = await validatePlan(plan, { registry, role: "operator" });
    expect(operator.steps.map((step) => step.operationId)).toEqual(["app.restart"]);
    expect(operator.dropped.map((entry) => entry.reason)).toEqual(["Only the owner can approve high-risk operations", "Only the owner can approve this operation"]);
    const viewer = await validatePlan(plan, { registry, role: "viewer" });
    expect(viewer.steps).toEqual([]);
    expect(new Set(viewer.dropped.map((entry) => entry.reason))).toEqual(new Set(["Viewers can look but not change anything"]));
  });

  it("shows a high-risk step as high, with what approving it takes", async () => {
    const { steps } = await validatePlan([{ operationId: "app.purge", parameters: { id: "jellyfin" } }], { registry, role: "owner" });
    expect(steps[0]).toMatchObject({ risk: "high", approval: "The owner's password and a typed confirmation", typedConfirmation: true });
  });

  // Sweep 4: a restore asks for typed text only when it allows a backup's own compose file.
  it("says a typed confirmation only for a step that will ask for one", async () => {
    const plain = await validatePlan([{ operationId: "app.backup.restore", parameters: { id: "jellyfin", backup: "20260101T000000Z.tar.gz" } }], { registry, role: "owner" });
    expect(plain.steps[0]).toMatchObject({ risk: "high", approval: "The owner's password", typedConfirmation: false });
    const allowing = await validatePlan([{ operationId: "app.backup.restore", parameters: { id: "jellyfin", backup: "20260101T000000Z.tar.gz", allowCompose: "e".repeat(64) } }], { registry, role: "owner" });
    expect(allowing.steps[0]).toMatchObject({ risk: "high", approval: "The owner's password and a typed confirmation", typedConfirmation: true });
  });

  it("never carries a secret, top-level or inside an app's settings", async () => {
    const { steps, dropped } = await validatePlan([
      { operationId: "credentials.set", parameters: { name: "ntfy", value: "hunter22" } },
      { operationId: "app.install", parameters: { id: "jellyfin", values: { env: { ADMIN_PASSWORD: "hunter22" } } } },
      { operationId: "app.install", parameters: { id: "jellyfin", values: { env: { TZ: "UTC" } } } },
    ], { registry, role: "owner", secretEnvNamesFor: async () => ["ADMIN_PASSWORD"] });
    expect(steps.map((step) => step.parameters)).toEqual([{ id: "jellyfin", values: { env: { TZ: "UTC" } } }]);
    expect(dropped.map((entry) => entry.index)).toEqual([0, 1]);
    expect(dropped[0].reason).toContain("secret");
  });

  it("offers a read as something to run, never a secret-revealing one, and only to whoever may read it", async () => {
    const operator = await validatePlan([{ operationId: "app.logs", parameters: { id: "jellyfin", lines: 50 } }, { operationId: "app.secrets", parameters: { id: "jellyfin" } }], { registry, role: "operator" });
    expect(operator.steps[0]).toMatchObject({ readOnly: true, risk: "low", request: { path: "/api/v1/operations/app.logs/run" } });
    expect(operator.dropped[0].reason).toBe("It reveals secrets, so it is not suggested");
    expect(refusalFor(registry.get("app.logs"), "viewer")).toBe("Viewers can look but not change anything");
  });

  it("drops repeats, and anything past the step limit", async () => {
    const step = { operationId: "app.restart", parameters: { id: "jellyfin" } };
    const { steps, dropped } = await validatePlan([step, step, ...Array.from({ length: maxPlanSteps }, (_, index) => ({ operationId: "app.restart", parameters: { id: `app-${index}` } }))], { registry, role: "owner" });
    expect(steps).toHaveLength(maxPlanSteps - 1);
    expect(dropped[0]).toMatchObject({ index: 1, reason: "It repeats step 1" });
    expect(dropped.at(-1).reason).toBe(`A plan has at most ${maxPlanSteps} steps`);
  });
});

describe("the tier a card shows is the one the job will be staged at (sweep 3)", () => {
  // The real registry and the real catalog, with the hook the web process gives the job layer.
  const real = createRegistry(operationModules).useRiskHooks({ "app.install": installRiskLookup(createCatalogService()) });

  it("shows installing the house's DNS or VPN as high, with the owner's password, as the job layer stages it", async () => {
    for (const id of ["pi-hole", "adguard-home", "technitium-dns", "wg-easy"]) {
      const { steps, dropped } = await validatePlan([{ operationId: "app.install", parameters: { id }, why: "Block ads." }], { registry: real, role: "owner" });
      expect(dropped, id).toEqual([]);
      expect(steps[0], id).toMatchObject({ operationId: "app.install", risk: "high", approval: "The owner's password", typedConfirmation: false });
      expect(await real.effectiveRisk("app.install", { id }), id).toBe("high");
    }
    const { steps } = await validatePlan([{ operationId: "app.install", parameters: { id: "jellyfin" } }], { registry: real, role: "owner" });
    expect(steps[0]).toMatchObject({ risk: "medium", approval: "One confirmation, with a preview" });
  });

  it("does not put a step the job layer would stage high on an operator's card", async () => {
    const { steps, dropped } = await validatePlan([
      { operationId: "app.install", parameters: { id: "pi-hole" } },
      { operationId: "app.install", parameters: { id: "jellyfin" } },
    ], { registry: real, role: "operator" });
    expect(steps.map((step) => step.parameters.id)).toEqual(["jellyfin"]);
    expect(dropped).toEqual([{ index: 0, operationId: "app.install", reason: "Only the owner can approve high-risk operations, and Install application is high risk here" }]);
  });

  it("takes the effective tier from whoever builds the card, when it is given", async () => {
    const { steps } = await validatePlan([{ operationId: "app.update", parameters: { id: "jellyfin" } }], { registry, role: "owner", effectiveRisk: async () => "high" });
    expect(steps[0]).toMatchObject({ risk: "high", approval: "The owner's password" });
    // A lower answer never lowers the operation's own tier, and a lookup that fails drops the step.
    expect((await validatePlan([{ operationId: "app.purge", parameters: { id: "jellyfin" } }], { registry, role: "owner", effectiveRisk: async () => "low" })).steps[0].risk).toBe("high");
    const failed = await validatePlan([{ operationId: "app.update", parameters: { id: "jellyfin" } }], { registry, role: "owner", effectiveRisk: async () => { throw new Error("catalog unreadable"); } });
    expect(failed.steps).toEqual([]);
    expect(failed.dropped[0].reason).toMatch(/could not tell how risky/);
  });
});
