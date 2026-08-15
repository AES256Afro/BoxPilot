import { validateDomainName } from "./libvirt.mjs";

export const vmLifecycleActions = {
  start: { label: "Start", risk: "medium", allowedStates: ["stopped"], desiredState: "running" },
  shutdown: { label: "Shut down", risk: "medium", allowedStates: ["running"], desiredState: "stopped" },
  reboot: { label: "Reboot", risk: "medium", allowedStates: ["running"], desiredState: "running" },
  "autostart-on": { label: "Enable autostart", risk: "low", allowedStates: ["running", "stopped"], desiredAutostart: true },
  "autostart-off": { label: "Disable autostart", risk: "low", allowedStates: ["running", "stopped"], desiredAutostart: false },
};

export function validateVmLifecycleInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A VM lifecycle request is required"];
  if (!validateDomainName(input.name)) errors.push("Invalid domain name");
  if (!Object.hasOwn(vmLifecycleActions, input.action)) errors.push("Unsupported VM lifecycle action");
  if (!["running", "stopped"].includes(input.expectedState)) errors.push("Expected VM state must be running or stopped");
  if (typeof input.expectedAutostart !== "boolean") errors.push("Expected autostart state must be true or false");
  return errors;
}

export function createVmLifecycleService({ store, libvirt }) {
  async function inspect(name, action) {
    if (!validateDomainName(name) || !Object.hasOwn(vmLifecycleActions, action)) throw new Error("Invalid domain name or unsupported lifecycle action");
    const domain = await libvirt.getDomain(name);
    if (!domain || !domain.managed) throw new Error("Managed VM not found");
    const definition = vmLifecycleActions[action];
    if (!definition.allowedStates.includes(domain.state)) throw new Error(`${definition.label} is not valid while ${name} is ${domain.state}`);
    if (definition.desiredAutostart === domain.autostart) throw new Error(`${name} already has the requested autostart state`);
    return { domain, definition };
  }

  async function plan(name, action, ownerId) {
    const { domain, definition } = await inspect(name, action);
    const input = { name, action, expectedState: domain.state, expectedAutostart: domain.autostart };
    const output = {
      executable: true,
      action,
      label: definition.label,
      current: { state: domain.state, autostart: domain.autostart },
      desired: { state: definition.desiredState ?? domain.state, autostart: definition.desiredAutostart ?? domain.autostart },
      changes: action === "start" ? ["Start the existing persistent domain", "Verify libvirt reports the domain running"]
        : action === "shutdown" ? ["Request a graceful ACPI shutdown", "Wait up to two minutes for libvirt to report the domain stopped"]
          : action === "reboot" ? ["Request a guest reboot through libvirt", "Verify the reboot request succeeded and the domain remains running"]
            : [`${definition.label} for the persistent domain`, "Read back the autostart setting from libvirt"],
      recovery: action === "shutdown"
        ? "If the guest does not stop, use its console or SSH session to shut it down normally. BoxPilot will not force power off."
        : action === "reboot"
          ? "If the guest does not return healthy, use its console. BoxPilot will not issue a force-off operation."
          : action === "start"
            ? "If start verification fails, inspect the guest console and libvirt state before retrying."
            : "Create a new reviewed plan to restore the previous autostart value.",
    };
    return store.createPlan({ type: "virtualization.action", subjectId: name, input, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.action") throw new Error("VM lifecycle plan not found");
    if (draft.revision !== revision) throw new Error("VM lifecycle plan revision does not match");
    if (!draft.output.executable) throw new Error("VM lifecycle plan is not executable");
    const { domain } = await inspect(draft.input.name, draft.input.action);
    if (domain.state !== draft.input.expectedState || domain.autostart !== draft.input.expectedAutostart) throw new Error("Host state changed: create a new VM lifecycle plan");
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.domain.action",
      title: `${draft.output.label} ${draft.subjectId}`,
      risk: vmLifecycleActions[draft.input.action].risk,
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: `Exact domain identity and expected ${draft.input.expectedState} state validated` },
        { name: "checkpoint", state: "completed", detail: "Current power and autostart state recorded; force-off and delete are not available" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.domain.action") throw new Error("Unsupported VM lifecycle job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM lifecycle plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM lifecycle job inputs do not match the approved plan");
    const { domain } = await inspect(staged.input.name, staged.input.action);
    if (domain.state !== staged.input.expectedState || domain.autostart !== staged.input.expectedAutostart) throw new Error("Host state changed: the VM lifecycle plan is stale");
    return staged;
  }

  return { plan, stage, validateJob };
}
