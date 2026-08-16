const applicationId = "uptime-kuma";
const applicationName = "Uptime Kuma";

function validState(state) {
  return state?.installed === true
    && state?.managedApplication === true
    && state?.connected === true
    && state?.conflict === false
    && /^[a-f0-9]{64}$/.test(String(state?.revision ?? ""))
    && /^[a-f0-9]{64}$/.test(String(state?.applicationRevision ?? ""))
    && /^[a-f0-9]{64}$/.test(String(state?.configurationBoundaryRevision ?? ""))
    && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.ts\.net$/i.test(String(state?.dnsName ?? ""))
    && Number.isInteger(state?.port)
    && state.port >= 1024
    && state.port <= 65535
    && state?.boundary?.fixedApplication === true
    && state?.boundary?.fixedLoopbackTarget === true
    && state?.boundary?.firewallChanged === false
    && state?.boundary?.routerChanged === false
    && state?.boundary?.dnsChanged === false
    && state?.boundary?.containerChanged === false
    && state?.boundary?.arbitraryTargetAccepted === false
    && state?.boundary?.arbitraryPortAccepted === false
    && state?.boundary?.mutationPerformed === false;
}

export function createApplicationPrivateAccessService({ store, helper } = {}) {
  async function inspect() {
    const state = await helper.request("application.uptime-kuma.private-access.inspect", {});
    if (!validState(state)) throw new Error(state?.detail ?? "Private Uptime Kuma access identity is unavailable");
    return state;
  }

  async function plan(requestedApplicationId, action, ownerId) {
    if (requestedApplicationId !== applicationId) throw new Error("Private access adapter not found");
    if (!["publish", "unpublish"].includes(action)) throw new Error("Unsupported private access action");
    const state = await inspect();
    if (!state.allowedActions?.includes(action)) throw new Error(`${action === "publish" ? "Publish" : "Remove private access"} is not valid for the current Tailscale route state`);
    const desiredPublished = action === "publish";
    const input = { applicationId, action, expectedRevision: state.revision };
    const output = {
      executable: true,
      applicationId,
      applicationName,
      action,
      current: { published: state.published, tailnetOnly: state.tailnetOnly, url: state.url, port: state.port },
      desired: { published: desiredPublished, tailnetOnly: desiredPublished, url: desiredPublished ? `https://${state.dnsName}:${state.port}/` : null, port: state.port },
      changes: desiredPublished
        ? [`Create one persistent Tailscale Serve HTTPS listener on port ${state.port}`, `Proxy only to the existing Uptime Kuma loopback target on 127.0.0.1:${state.port}`, "Verify the route is labeled tailnet only"]
        : [`Remove only the exact Uptime Kuma Tailscale Serve listener on HTTPS port ${state.port}`, "Verify the loopback application remains running and healthy"],
      recovery: desiredPublished
        ? "If private route verification fails, remove only that exact Serve listener and keep Uptime Kuma on loopback. BoxPilot, other Serve routes, Funnel policy, firewall, DNS, and router state remain unchanged."
        : "Create a fresh Publish private access plan. Uptime Kuma stays running on loopback while the tailnet route is absent.",
      boundaries: [
        "Only permitted users and devices in the tailnet can reach this route; Funnel and public exposure must remain off",
        "The application, container, image, Compose definition, port, data, other Serve routes, firewall, DNS, router, and Tailscale connection are unchanged",
        "The browser cannot provide a hostname, target, port, path, protocol, command, argument, Service name, or Funnel option",
      ],
    };
    return store.createPlan({ type: "application.private-access", subjectId: applicationId, input, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.private-access" || draft.subjectId !== applicationId) throw new Error("Private access plan not found");
    if (draft.revision !== revision) throw new Error("Private access plan revision does not match");
    const state = await inspect();
    if (state.revision !== draft.input.expectedRevision || !state.allowedActions?.includes(draft.input.action)) throw new Error("Host state changed: create a new private access plan");
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.uptime-kuma.private-access",
      title: `${draft.input.action === "publish" ? "Publish" : "Remove"} private Uptime Kuma access`,
      risk: draft.input.action === "publish" ? "private-network-exposure" : "service-availability",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact healthy managed application, loopback port, Tailscale connection, tailnet DNS name, and complete Serve configuration revision validated" },
        { name: "checkpoint", state: "completed", detail: "Funnel stays off; only the exact app HTTPS listener can change, and all other Serve configuration is revision-locked" },
      ],
    });
  }

  async function validateJob(job) {
    const draft = store.getPlan(job.parameters.planId);
    if (!draft || draft.status !== "staged" || draft.type !== "application.private-access" || draft.subjectId !== applicationId || draft.createdBy !== job.createdBy || draft.revision !== job.parameters.revision) throw new Error("The staged private access plan is unavailable or changed");
    if (JSON.stringify(job.parameters.input) !== JSON.stringify(draft.input)) throw new Error("The private access job does not match the approved plan");
    const state = await inspect();
    if (state.revision !== draft.input.expectedRevision || !state.allowedActions?.includes(draft.input.action)) throw new Error("Host state changed: the private access plan is stale");
    return draft;
  }

  return { inspect, plan, stage, validateJob };
}

export const applicationPrivateAccessInternals = { applicationId, applicationName, validState };
