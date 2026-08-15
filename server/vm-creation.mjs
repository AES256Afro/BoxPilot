export function createVmCreationService({ store, planner, libvirt }) {
  async function inspectHost(input) {
    const domain = await libvirt.getDomain(input.name);
    if (domain) return { ok: false, errors: [`A libvirt domain named ${input.name} already exists`] };
    const resources = await libvirt.listResources();
    if (!resources.connected) throw new Error("libvirt resources are unavailable");
    const defaultNetwork = resources.networks.find((network) => network.name === "default");
    if (!defaultNetwork?.active) throw new Error("The default libvirt network is not active");
    const defaultPool = resources.pools.find((pool) => pool.name === "default");
    if (!defaultPool?.active) throw new Error("The default libvirt storage pool is not active");
    return planner.createPlan(input, {
      existingDomainNames: [],
      poolAvailableBytes: defaultPool.availableBytes ?? null,
    });
  }

  async function plan(input, ownerId) {
    const result = await inspectHost(input);
    if (!result.ok) return result;
    const draft = store.createPlan({
      type: "virtualization.create",
      subjectId: result.plan.input.name,
      input: result.plan.input,
      output: { ...result.plan, adapterRevision: result.plan.revision },
      createdBy: ownerId,
    });
    return {
      ok: true,
      plan: { ...draft.output, id: draft.id, revision: draft.revision, status: draft.status, expiresAt: draft.expiresAt },
    };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.create") throw new Error("VM creation plan not found");
    if (draft.revision !== revision) throw new Error("VM creation plan revision does not match");
    if (!draft.output.executable || !draft.output.stageable) throw new Error("VM creation plan is not executable");
    const live = await inspectHost(draft.input);
    if (!live.ok) throw new Error(`Host state changed: ${live.errors.join(" | ")}`);
    if (live.plan.revision !== draft.output.adapterRevision) throw new Error("Host state changed: the ISO or VM creation plan changed");
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.domain.create",
      title: `Create virtual machine ${draft.subjectId}`,
      risk: "high",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: {
        automaticRollback: true,
        reason: "If creation or post-create verification fails, the helper removes only the newly created exact-name domain and its newly allocated storage.",
        manual: `If automatic rollback fails, inspect ${draft.subjectId} with virsh before deleting or retrying anything.`,
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Domain name, managed ISO, active default network, storage pool capacity, and fixed virt-install arguments validated" },
        { name: "checkpoint", state: "completed", detail: "Exact-name absence confirmed and automatic cleanup is limited to the newly created domain" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.domain.create") throw new Error("Unsupported VM creation job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM creation plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) {
      throw new Error("The staged VM creation job inputs do not match the approved plan");
    }
    const live = await inspectHost(staged.input);
    if (!live.ok) throw new Error(`Host state changed: ${live.errors.join(" | ")}`);
    if (live.plan.revision !== staged.output.adapterRevision) throw new Error("Host state changed: the ISO or VM creation plan changed");
    return staged;
  }

  return { plan, stage, validateJob };
}
