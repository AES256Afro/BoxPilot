export function createPrerequisiteRepairService({ store, helper } = {}) {
  async function inspect() {
    return helper.request("prerequisite.smartmontools.inspect", {});
  }

  function matchingState(plan, state) {
    return plan.input.expectedVersion === state.selectedVersion && plan.input.installedBefore === state.installed;
  }

  async function planSmartmontools(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Smartmontools repair planning accepts only an empty object");
    const state = await inspect();
    if (!state.supported || !state.selectedVersion) throw new Error("No fixed smartmontools candidate is available from the configured package metadata");
    return store.createPlan({
      type: "prerequisite.repair",
      subjectId: "smartmontools",
      input: { expectedVersion: state.selectedVersion, installedBefore: state.installed },
      output: {
        executable: true,
        package: "smartmontools",
        selectedVersion: state.selectedVersion,
        currentState: state.installed ? `Installed ${state.installedVersion}` : "Not installed",
        action: state.installed ? "Run the fixed storage evidence scan and verify current evidence" : "Install only smartmontools from the configured APT candidate, then run the fixed storage evidence scan",
        networkAccess: !state.installed,
        aptUpdatePerformed: false,
        arbitraryPackageSelection: false,
        automaticRollback: false,
        recovery: "If APT fails, inspect dpkg and APT state from the server console before retrying. BoxPilot never removes a package automatically.",
      },
      createdBy: ownerId,
    });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "prerequisite.repair" || plan.subjectId !== "smartmontools") throw new Error("Prerequisite repair plan not found");
    if (plan.revision !== revision) throw new Error("Prerequisite repair plan revision does not match");
    const state = await inspect();
    if (!matchingState(plan, state)) throw new Error("Host state changed: create a new smartmontools repair plan");
    store.stagePlan(plan.id, ownerId);
    return store.createJob({
      type: "prerequisite.smartmontools.install",
      title: state.installed ? "Verify smartmontools and refresh storage evidence" : "Install smartmontools and verify storage evidence",
      risk: "system-package",
      parameters: { planId: plan.id, revision: plan.revision, expectedVersion: plan.input.expectedVersion, installedBefore: plan.input.installedBefore },
      recovery: {
        automaticRollback: false,
        reason: "Package installation is intentionally not reversed automatically because removal could disable operator tooling or alter administrator-managed package state.",
        manual: "If the job fails, inspect boxpilot-smartmontools-install.service, dpkg, and APT state from the server console. Repair interrupted package configuration before creating a fresh plan. Do not remove smartmontools merely to match the old state.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: `The fixed smartmontools package and exact version ${plan.input.expectedVersion} were resolved without accepting a package name, repository, command, or argument from the browser` },
        { name: "checkpoint", state: "completed", detail: "The operation will not run apt update, remove a package, change a disk, mount a filesystem, or alter a SMART setting; package removal is never automatic" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "prerequisite.smartmontools.install") throw new Error("Unsupported prerequisite repair job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.type !== "prerequisite.repair" || plan.subjectId !== "smartmontools" || plan.revision !== job.parameters.revision) throw new Error("The staged smartmontools repair plan is unavailable or changed");
    if (plan.input.expectedVersion !== job.parameters.expectedVersion || plan.input.installedBefore !== job.parameters.installedBefore) throw new Error("The staged smartmontools repair plan does not match the job");
    const state = await inspect();
    if (!matchingState(plan, state)) throw new Error("Host state changed: the smartmontools package state or candidate changed");
    return { plan, state };
  }

  return { inspect, planSmartmontools, stage, validateJob };
}
