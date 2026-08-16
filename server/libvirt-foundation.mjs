import { randomUUID } from "node:crypto";

export function createLibvirtFoundationService({ store, helper, newId = randomUUID } = {}) {
  async function inspect() {
    try {
      return await helper.request("virtualization.foundation.inspect", {});
    } catch {
      return {
        connectionUri: "qemu:///system",
        connectionReady: false,
        ready: false,
        revision: null,
        network: { name: "default", exists: false, active: false, autostart: false, compatible: false, bridge: "virbr0" },
        pool: { name: "default", exists: false, active: false, autostart: false, compatible: false, targetPath: "/var/lib/libvirt/images" },
        conflicts: ["The restricted libvirt foundation inspector is unavailable"],
        planAvailable: false,
        changes: [],
        boundary: { mutationPerformed: false, browserResourceAccepted: false },
      };
    }
  }

  async function plan(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Libvirt foundation planning accepts only an empty object");
    const state = await inspect();
    if (state.ready) throw new Error("The canonical default libvirt network and storage pool are already ready");
    if (!state.planAvailable || !/^[a-f0-9]{64}$/.test(String(state.revision ?? ""))) throw new Error(state.conflicts[0] ?? "The canonical libvirt foundation cannot be initialized safely");
    const foundationId = newId();
    return store.createPlan({
      type: "virtualization.foundation",
      subjectId: "default",
      input: { expectedRevision: state.revision, foundationId },
      output: {
        executable: true,
        connectionUri: "qemu:///system",
        network: { name: "default", mode: "nat", bridge: "virbr0", cidr: "192.168.122.0/24", dhcpRange: "192.168.122.2 - 192.168.122.254" },
        pool: { name: "default", type: "dir", targetPath: "/var/lib/libvirt/images" },
        current: { network: state.network, pool: state.pool },
        changes: state.changes,
        automaticRollback: true,
        boundaries: [
          "No browser-selected network, subnet, bridge, pool, path, XML, command, or argument",
          "No existing incompatible default resource is changed or replaced",
          "No non-default network or pool is changed",
          "No VM, disk, ISO, operator group, firewall rule, LAN route, or Tailscale setting is changed",
        ],
        recovery: "Failure reverses only network and pool definitions, starts, autostart settings, and an empty fixed target directory created by this exact job.",
      },
      createdBy: ownerId,
    });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.foundation" || draft.subjectId !== "default") throw new Error("Libvirt foundation plan not found");
    if (draft.revision !== revision) throw new Error("Libvirt foundation plan revision does not match");
    if (!draft.output.executable) throw new Error("Libvirt foundation plan is not executable");
    const state = await inspect();
    if (!state.planAvailable || state.ready || state.revision !== draft.input.expectedRevision) throw new Error("Host state changed: create a new libvirt foundation plan");
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.foundation.initialize",
      title: "Initialize the default libvirt network and storage pool",
      risk: "virtualization-network-storage",
      parameters: { planId: draft.id, revision: draft.revision, foundationId: draft.input.foundationId, expectedRevision: draft.input.expectedRevision },
      recovery: {
        automaticRollback: true,
        reason: draft.output.recovery,
        manual: "If automatic rollback reports an incomplete step, inspect only the default network, default pool, virbr0, and /var/lib/libvirt/images from the server console before creating a fresh plan. Do not change other resources.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "The system libvirt URI, exact default resource state, fixed NAT subnet, fixed bridge, and fixed image path were captured with no browser-selected resource" },
        { name: "checkpoint", state: "completed", detail: "Existing incompatible names, virbr0, subnet routes, and unsafe target paths are blocked; rollback is limited to changes made by this job" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.foundation.initialize") throw new Error("Unsupported libvirt foundation job");
    const draft = store.getPlan(job.parameters.planId);
    if (!draft || draft.status !== "staged" || draft.type !== "virtualization.foundation" || draft.subjectId !== "default" || draft.createdBy !== job.createdBy || draft.revision !== job.parameters.revision) {
      throw new Error("The staged libvirt foundation plan is unavailable or changed");
    }
    if (draft.input.foundationId !== job.parameters.foundationId || draft.input.expectedRevision !== job.parameters.expectedRevision) throw new Error("The libvirt foundation job does not match the approved plan");
    const state = await inspect();
    if (!state.planAvailable || state.ready || state.revision !== draft.input.expectedRevision) throw new Error("Host state changed: the libvirt foundation plan is stale");
    return { plan: draft, state };
  }

  return { inspect, plan, stage, validateJob };
}
