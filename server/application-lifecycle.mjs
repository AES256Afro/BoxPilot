const actions = {
  start: {
    label: "Start",
    risk: "low",
    requiredState: "stopped",
    desiredState: "running",
    changes: ["Start only the exact managed Uptime Kuma container", "Wait for the pinned container health check to pass", "Verify the loopback binding and persistent data mount are unchanged"],
    recovery: "If startup verification fails, leave the persistent data directory unchanged and inspect the Uptime Kuma and Docker logs before creating a new plan.",
  },
  stop: {
    label: "Stop",
    risk: "service-availability",
    requiredState: "running",
    desiredState: "stopped",
    changes: ["Request a clean 30-second stop of only the exact managed Uptime Kuma container", "Verify the container stopped", "Keep the Compose definition, image, network, and persistent data directory unchanged"],
    recovery: "Create a fresh Start plan to return the exact managed container to service. BoxPilot does not delete its data, Compose definition, image, or network.",
  },
  restart: {
    label: "Restart",
    risk: "service-availability",
    requiredState: "running",
    desiredState: "running",
    changes: ["Restart only the exact managed Uptime Kuma container with a 30-second stop window", "Wait for the pinned container health check to pass", "Verify the loopback binding and persistent data mount are unchanged"],
    recovery: "If restart verification fails, leave the persistent data directory unchanged and inspect the Uptime Kuma and Docker logs before creating a fresh Start or Restart plan.",
  },
};

function validInspection(state) {
  return state?.installed === true
    && state?.managed === true
    && /^[a-f0-9]{64}$/.test(String(state?.revision ?? ""))
    && Number.isInteger(state?.port)
    && state.port >= 1024
    && state.port <= 65535;
}

export function createApplicationLifecycleService({ store, helper } = {}) {
  async function inspect() {
    const state = await helper.request("application.uptime-kuma.lifecycle.inspect", {});
    if (!validInspection(state)) throw new Error(state?.detail ?? "Managed Uptime Kuma lifecycle identity is unavailable");
    return state;
  }

  async function plan(applicationId, action, ownerId) {
    if (applicationId !== "uptime-kuma") throw new Error("Application lifecycle adapter not found");
    const definition = actions[action];
    if (!definition) throw new Error("Unsupported Uptime Kuma lifecycle action");
    const state = await inspect();
    if (!state.allowedActions?.includes(action)) throw new Error(`${definition.label} is not valid while Uptime Kuma is ${state.state}`);
    const input = { applicationId, action, expectedRevision: state.revision };
    const output = {
      executable: true,
      label: definition.label,
      current: { state: state.state, healthy: state.healthy, port: state.port },
      desired: { state: definition.desiredState, healthy: action === "stop" ? false : true, port: state.port },
      changes: definition.changes,
      recovery: definition.recovery,
      boundaries: [
        "The exact boxpilot-uptime-kuma container must retain its digest-pinned image, Compose labels, loopback binding, fixed data mount, restart policy, and unprivileged device-free configuration",
        "No image, Compose definition, environment, port, volume, network, data, Docker socket, other container, router, DNS, firewall, or Tailscale setting can be selected or changed",
      ],
    };
    return store.createPlan({ type: "application.action", subjectId: applicationId, input, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.action" || draft.subjectId !== "uptime-kuma") throw new Error("Uptime Kuma lifecycle plan not found");
    if (draft.revision !== revision) throw new Error("Uptime Kuma lifecycle plan revision does not match");
    const state = await inspect();
    if (state.revision !== draft.input.expectedRevision || !state.allowedActions?.includes(draft.input.action)) throw new Error("Host state changed: create a new Uptime Kuma lifecycle plan");
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.uptime-kuma.action",
      title: `${draft.output.label} Uptime Kuma`,
      risk: actions[draft.input.action].risk,
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact managed container identity, image digest, Compose labels, loopback port, persistent data mount, restart policy, privileges, devices, and current state validated" },
        { name: "checkpoint", state: "completed", detail: "No image, Compose, environment, port, volume, network, persistent data, other container, router, DNS, firewall, or Tailscale mutation is available" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.uptime-kuma.action") throw new Error("Unsupported Uptime Kuma lifecycle job");
    const draft = store.getPlan(job.parameters.planId);
    if (!draft || draft.status !== "staged" || draft.type !== "application.action" || draft.subjectId !== "uptime-kuma" || draft.createdBy !== job.createdBy || draft.revision !== job.parameters.revision) {
      throw new Error("The staged Uptime Kuma lifecycle plan is unavailable or changed");
    }
    if (JSON.stringify(job.parameters.input) !== JSON.stringify(draft.input)) throw new Error("The Uptime Kuma lifecycle job does not match the approved plan");
    const state = await inspect();
    if (state.revision !== draft.input.expectedRevision || !state.allowedActions?.includes(draft.input.action)) throw new Error("Host state changed: the Uptime Kuma lifecycle plan is stale");
    return draft;
  }

  return { plan, stage, validateJob };
}

export const applicationLifecycleInternals = { actions, validInspection };
