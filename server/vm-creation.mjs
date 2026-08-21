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

  /** Full host-checked preview for the planner UI; nothing is stored. */
  async function preview(input) {
    return inspectHost(input);
  }

  /** Pin the validated creation input for the registry operation. */
  async function prepareOperation(input = {}) {
    const result = await inspectHost(input);
    if (!result.ok) throw new Error(result.errors.join(" | "));
    if (!result.plan.executable || !result.plan.stageable) throw new Error((result.plan.blockers ?? []).join(" | ") || "The VM creation plan is not executable");
    return result.plan.input;
  }


  return { preview, prepareOperation };
}
