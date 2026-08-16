const actionStates = {
  start: { label: "Start", requiredState: "stopped", desiredState: "running" },
  stop: { label: "Stop", requiredState: "running", desiredState: "stopped" },
  restart: { label: "Restart", requiredState: "running", desiredState: "running" },
};

const applications = {
  "uptime-kuma": {
    name: "Uptime Kuma",
    jobType: "application.uptime-kuma.action",
    inspectOperation: "application.uptime-kuma.lifecycle.inspect",
    risk: (action) => action === "start" ? "low" : "service-availability",
    changes: {
      start: ["Start only the exact managed Uptime Kuma container", "Wait for the pinned container health check to pass", "Verify the loopback binding and persistent data mount are unchanged"],
      stop: ["Request a clean 30-second stop of only the exact managed Uptime Kuma container", "Verify the container stopped", "Keep the Compose definition, image, network, and persistent data directory unchanged"],
      restart: ["Restart only the exact managed Uptime Kuma container with a 30-second stop window", "Wait for the pinned container health check to pass", "Verify the loopback binding and persistent data mount are unchanged"],
    },
    recovery: {
      start: "If startup verification fails, leave the persistent data directory unchanged and inspect the Uptime Kuma and Docker logs before creating a new plan.",
      stop: "Create a fresh Start plan to return the exact managed container to service. BoxPilot does not delete its data, Compose definition, image, or network.",
      restart: "If restart verification fails, leave the persistent data directory unchanged and inspect the Uptime Kuma and Docker logs before creating a fresh Start or Restart plan.",
    },
    boundaries: [
      "The exact boxpilot-uptime-kuma container must retain its digest-pinned image, Compose labels, loopback binding, fixed data mount, restart policy, and unprivileged device-free configuration",
      "No image, Compose definition, environment, port, volume, network, data, Docker socket, other container, router, DNS, firewall, or Tailscale setting can be selected or changed",
    ],
    preflight: "Exact managed container identity, image digest, Compose labels, loopback port, persistent data mount, restart policy, privileges, devices, and current state validated",
    checkpoint: "No image, Compose, environment, port, volume, network, persistent data, other container, router, DNS, firewall, or Tailscale mutation is available",
  },
  "pi-hole": {
    name: "Pi-hole",
    jobType: "application.pi-hole.action",
    inspectOperation: "application.pi-hole.lifecycle.inspect",
    risk: () => "network-critical-service-availability",
    changes: {
      start: ["Start only the exact managed Pi-hole container", "Wait for the pinned container health check to pass", "Verify the exact private-LAN TCP and UDP DNS bindings, web binding, persistent configuration, and administrator secret remain present"],
      stop: ["Request a clean 30-second stop of only the exact managed Pi-hole container", "Verify the container stopped while its fixed LAN and storage configuration remains recorded", "Keep router DHCP, client DNS, Tailscale, the Compose definition, image, network, configuration, and administrator secret unchanged"],
      restart: ["Restart only the exact managed Pi-hole container with a 30-second stop window", "Wait for the pinned container health check to pass", "Verify the exact private-LAN TCP and UDP DNS bindings, web binding, persistent configuration, and administrator secret remain present"],
    },
    recovery: {
      start: "Keep router and clients on the independently tested resolver until Pi-hole health, direct DNS acceptance, backup, and second-device evidence pass. If startup verification fails, inspect Pi-hole and Docker logs before creating a new plan.",
      stop: "Keep router and clients on the independently tested resolver. Create a fresh Start plan to return the exact managed container to service; BoxPilot does not change router DHCP, client DNS, data, the secret, Compose, image, or network.",
      restart: "Keep router and clients on the independently tested resolver during the interruption. If restart verification fails, inspect Pi-hole and Docker logs before creating a fresh Start or Restart plan.",
    },
    boundaries: [
      "The exact boxpilot-pi-hole container must retain its digest-pinned image, Compose labels, private-LAN TCP and UDP port 53 bindings, web binding, fixed data mount, administrator-secret file, restart policy, exact capability set, and no-new-privileges configuration",
      "No image, Compose definition, environment, port, volume, network, data, secret, Docker socket, other container, router, DHCP, client DNS, firewall, or Tailscale setting can be selected or changed",
      "Stopping or restarting Pi-hole can interrupt DNS service. Keep router and clients on the independently tested resolver until deployment, backup, direct acceptance, and second-device evidence pass",
    ],
    preflight: "Exact managed Pi-hole identity, image digest, Compose labels, private-LAN DNS and web bindings, persistent configuration, secret file, capability set, privileges, devices, and current state validated",
    checkpoint: "Independent resolver recovery remains required; no router, DHCP, client DNS, image, Compose, port, volume, network, data, secret, firewall, or Tailscale mutation is available",
  },
};

function privateIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function validInspection(state, applicationId = "uptime-kuma") {
  const common = state?.installed === true
    && state?.managed === true
    && /^[a-f0-9]{64}$/.test(String(state?.revision ?? ""))
    && Number.isInteger(state?.port)
    && state.port >= 1024
    && state.port <= 65535;
  if (!common) return false;
  return applicationId !== "pi-hole" || (privateIpv4(state.lanAddress) && state.dnsTcpBound === true && state.dnsUdpBound === true);
}

export function createApplicationLifecycleService({ store, helper } = {}) {
  async function inspect(applicationId) {
    const definition = applications[applicationId];
    if (!definition) throw new Error("Application lifecycle adapter not found");
    const state = await helper.request(definition.inspectOperation, {});
    if (!validInspection(state, applicationId)) throw new Error(state?.detail ?? `Managed ${definition.name} lifecycle identity is unavailable`);
    return state;
  }

  async function plan(applicationId, action, ownerId) {
    const definition = applications[applicationId];
    if (!definition) throw new Error("Application lifecycle adapter not found");
    const actionState = actionStates[action];
    if (!actionState) throw new Error(`Unsupported ${definition.name} lifecycle action`);
    const state = await inspect(applicationId);
    if (!state.allowedActions?.includes(action)) throw new Error(`${actionState.label} is not valid while ${definition.name} is ${state.state}`);
    const input = { applicationId, action, expectedRevision: state.revision };
    const output = {
      executable: true,
      applicationId,
      applicationName: definition.name,
      label: actionState.label,
      current: { state: state.state, healthy: state.healthy, port: state.port, lanAddress: state.lanAddress ?? null, dnsTcpBound: state.dnsTcpBound ?? false, dnsUdpBound: state.dnsUdpBound ?? false },
      desired: { state: actionState.desiredState, healthy: action === "stop" ? false : true, port: state.port, lanAddress: state.lanAddress ?? null, dnsTcpBound: state.dnsTcpBound ?? false, dnsUdpBound: state.dnsUdpBound ?? false },
      changes: definition.changes[action],
      recovery: definition.recovery[action],
      boundaries: definition.boundaries,
    };
    return store.createPlan({ type: "application.action", subjectId: applicationId, input, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    const definition = applications[draft?.subjectId];
    if (!draft || !definition || draft.createdBy !== ownerId || draft.type !== "application.action") throw new Error("Application lifecycle plan not found");
    if (draft.revision !== revision) throw new Error(`${definition.name} lifecycle plan revision does not match`);
    const state = await inspect(draft.subjectId);
    if (state.revision !== draft.input.expectedRevision || !state.allowedActions?.includes(draft.input.action)) throw new Error(`Host state changed: create a new ${definition.name} lifecycle plan`);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: definition.jobType,
      title: `${draft.output.label} ${definition.name}`,
      risk: definition.risk(draft.input.action),
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: definition.preflight },
        { name: "checkpoint", state: "completed", detail: definition.checkpoint },
      ],
    });
  }

  async function validateJob(job) {
    const definition = Object.values(applications).find((item) => item.jobType === job.type);
    if (!definition) throw new Error("Unsupported application lifecycle job");
    const draft = store.getPlan(job.parameters.planId);
    if (!draft || draft.status !== "staged" || draft.type !== "application.action" || applications[draft.subjectId] !== definition || draft.createdBy !== job.createdBy || draft.revision !== job.parameters.revision) {
      throw new Error("The staged application lifecycle plan is unavailable or changed");
    }
    if (JSON.stringify(job.parameters.input) !== JSON.stringify(draft.input)) throw new Error(`The ${definition.name} lifecycle job does not match the approved plan`);
    const state = await inspect(draft.subjectId);
    if (state.revision !== draft.input.expectedRevision || !state.allowedActions?.includes(draft.input.action)) throw new Error(`Host state changed: the ${definition.name} lifecycle plan is stale`);
    return draft;
  }

  return { plan, stage, validateJob };
}

export const applicationLifecycleInternals = { actionStates, applications, privateIpv4, validInspection };
