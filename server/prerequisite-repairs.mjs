const virtualizationPackageNames = ["qemu-system-x86", "libvirt-daemon-system", "libvirt-clients", "virtinst", "ovmf"];
const packageVersionPattern = /^[0-9A-Za-z.+:~_-]{1,64}$/;

export function createPrerequisiteRepairService({ store, helper } = {}) {
  async function inspectSmartmontools() {
    return helper.request("prerequisite.smartmontools.inspect", {});
  }

  async function inspectAptMetadata() {
    return helper.request("prerequisite.apt-metadata.inspect", {});
  }

  async function inspectRestic() {
    return helper.request("prerequisite.restic.inspect", {});
  }

  async function inspectDocker() {
    return helper.request("prerequisite.docker.inspect", {});
  }

  async function inspectVirtualization() {
    return helper.request("prerequisite.virtualization.inspect", {});
  }

  function matchingSmartmontoolsState(plan, state) {
    return plan.input.expectedVersion === state.selectedVersion && plan.input.installedBefore === state.installed;
  }

  function matchingAptMetadataState(plan, state) {
    return plan.input.expectedUpdatedAt === state.updatedAt
      && plan.input.expectedState === state.state
      && state.packageManagerState === "ready"
      && state.refreshAvailable === true;
  }

  function matchingResticState(plan, state) {
    return plan.input.expectedVersion === state.selectedVersion && plan.input.installedBefore === state.installed;
  }

  function matchingDockerState(plan, state) {
    return plan.input.expectedVersion === state.selectedVersion && plan.input.installedBefore === state.installed;
  }

  function matchingVirtualizationState(plan, state) {
    const names = Object.keys(plan.input.expectedPackages ?? {}).sort();
    return plan.input.installedBefore === state.installed
      && plan.input.expectedKvmDevice === state.kvmDeviceAvailable
      && names.length === virtualizationPackageNames.length
      && names.every((name, index) => name === [...virtualizationPackageNames].sort()[index])
      && names.every((name) => plan.input.expectedPackages[name] === state.candidatePackages?.[name]);
  }

  async function planSmartmontools(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Smartmontools repair planning accepts only an empty object");
    const state = await inspectSmartmontools();
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

  async function planAptMetadata(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("APT metadata refresh planning accepts only an empty object");
    const state = await inspectAptMetadata();
    if (state.packageManagerState !== "ready") throw new Error("The package manager is not ready; repair interrupted dpkg state from the server console before refreshing metadata");
    if (!state.refreshAvailable || state.state === "current") throw new Error("APT metadata is already current or no fixed refresh is available");
    return store.createPlan({
      type: "prerequisite.repair",
      subjectId: "apt-metadata",
      input: { expectedUpdatedAt: state.updatedAt, expectedState: state.state },
      output: {
        executable: true,
        currentState: state.state,
        currentUpdatedAt: state.updatedAt,
        currentAgeHours: state.ageHours,
        action: "Run only the fixed APT metadata update and verify that installed package state is unchanged",
        networkAccess: true,
        aptUpdatePerformed: true,
        packageInstallPerformed: false,
        packageUpgradePerformed: false,
        packageRemovalPerformed: false,
        arbitraryPackageSelection: false,
        arbitraryCommandAccepted: false,
        automaticRollback: false,
        recovery: "If repository metadata refresh fails, installed packages remain unchanged. Inspect the fixed service and repository availability before creating a new plan.",
      },
      createdBy: ownerId,
    });
  }

  async function planRestic(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Restic repair planning accepts only an empty object");
    const state = await inspectRestic();
    if (!state.supported || !state.selectedVersion) throw new Error("No fixed restic candidate is available from the configured package metadata");
    return store.createPlan({
      type: "prerequisite.repair",
      subjectId: "restic",
      input: { expectedVersion: state.selectedVersion, installedBefore: state.installed },
      output: {
        executable: true,
        package: "restic",
        selectedVersion: state.selectedVersion,
        currentState: state.installed ? `Installed ${state.installedVersion}` : "Not installed",
        action: state.installed ? "Verify the fixed restic package and binary" : "Install only restic from the configured APT candidate, then verify its fixed binary",
        networkAccess: !state.installed,
        aptUpdatePerformed: false,
        arbitraryPackageSelection: false,
        automaticRollback: false,
        storageSetupPerformed: false,
        recovery: "If APT fails, inspect dpkg and APT state from the server console before retrying. BoxPilot never removes restic automatically and this repair never mounts storage, creates a recovery key, or initializes a repository.",
      },
      createdBy: ownerId,
    });
  }

  async function planDocker(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Docker Engine repair planning accepts only an empty object");
    const state = await inspectDocker();
    if (state.installed) throw new Error("A compatible Docker Engine is already active; no installation plan is needed");
    if (!state.supported || !state.repairAvailable || !state.selectedVersion) throw new Error("No fixed docker.io candidate is available from the configured package metadata");
    return store.createPlan({
      type: "prerequisite.repair",
      subjectId: "docker",
      input: { expectedVersion: state.selectedVersion, installedBefore: false },
      output: {
        executable: true,
        package: "docker.io",
        selectedVersion: state.selectedVersion,
        currentState: "No compatible active Docker Engine detected",
        action: "Install only docker.io from the configured Ubuntu APT candidate, enable and start docker.service, then verify the local daemon version",
        networkAccess: true,
        aptUpdatePerformed: false,
        arbitraryPackageSelection: false,
        arbitraryRepositorySelection: false,
        daemonConfigurationChanged: false,
        userGroupChanged: false,
        containerCreated: false,
        automaticRollback: false,
        recovery: "If APT or daemon startup fails, inspect boxpilot-docker-install.service, docker.service, dpkg, and APT state from the server console. BoxPilot never removes Docker automatically, rewrites daemon.json, adds a user to the docker group, or replaces an existing provider.",
      },
      createdBy: ownerId,
    });
  }

  async function planVirtualization(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Virtualization repair planning accepts only an empty object");
    const state = await inspectVirtualization();
    if (state.installed) throw new Error("The KVM, QEMU, and libvirt stack is already active; no installation plan is needed");
    if (!state.kvmDeviceAvailable) throw new Error("The KVM kernel interface is unavailable; enable virtualization in firmware or repair the host before planning installation");
    if (!state.repairAvailable || !state.candidateSetAvailable || virtualizationPackageNames.some((name) => !packageVersionPattern.test(String(state.candidatePackages?.[name] ?? "")))) throw new Error("No clean fixed virtualization package set is available from configured Ubuntu metadata");
    const expectedPackages = Object.fromEntries(virtualizationPackageNames.map((name) => [name, state.candidatePackages[name]]));
    return store.createPlan({
      type: "prerequisite.repair",
      subjectId: "virtualization",
      input: { expectedPackages, expectedKvmDevice: true, installedBefore: false },
      output: {
        executable: true,
        packageSet: virtualizationPackageNames.map((name) => ({ name, version: expectedPackages[name] })),
        currentState: "The KVM kernel interface is registered and no existing libvirt or QEMU provider was detected",
        action: "Install the fixed Ubuntu QEMU, libvirt, virt-install, and OVMF package set; enable and start libvirtd.service; then verify /dev/kvm, QEMU, and qemu:///system",
        networkAccess: true,
        aptUpdatePerformed: false,
        dependencyChangesPossible: true,
        arbitraryPackageSelection: false,
        arbitraryRepositorySelection: false,
        operatorUserGroupChanged: false,
        networkCreated: false,
        storagePoolCreated: false,
        virtualMachineCreated: false,
        automaticRollback: false,
        recovery: "If APT or libvirt startup fails, inspect boxpilot-virtualization-install.service, libvirtd.service, dpkg, APT, /dev/kvm, and firmware virtualization state. BoxPilot never removes the stack automatically, replaces a partial provider, creates a network or pool, changes an operator user, or creates a VM in this prerequisite job.",
      },
      createdBy: ownerId,
    });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "prerequisite.repair" || !["smartmontools", "restic", "docker", "virtualization", "apt-metadata"].includes(plan.subjectId)) throw new Error("Prerequisite repair plan not found");
    if (plan.revision !== revision) throw new Error("Prerequisite repair plan revision does not match");

    if (plan.subjectId === "smartmontools") {
      const state = await inspectSmartmontools();
      if (!matchingSmartmontoolsState(plan, state)) throw new Error("Host state changed: create a new smartmontools repair plan");
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

    if (plan.subjectId === "restic") {
      const state = await inspectRestic();
      if (!matchingResticState(plan, state)) throw new Error("Host state changed: create a new restic repair plan");
      store.stagePlan(plan.id, ownerId);
      return store.createJob({
        type: "prerequisite.restic.install",
        title: state.installed ? "Verify the fixed restic package" : "Install and verify restic",
        risk: "system-package",
        parameters: { planId: plan.id, revision: plan.revision, expectedVersion: plan.input.expectedVersion, installedBefore: plan.input.installedBefore },
        recovery: {
          automaticRollback: false,
          reason: "Package installation is intentionally not reversed automatically because removal could disable existing backup tooling or alter administrator-managed package state.",
          manual: "If the job fails, inspect boxpilot-restic-install.service, dpkg, and APT state from the server console. Repair interrupted package configuration before creating a fresh plan. Do not remove restic merely to match the old state.",
        },
        createdBy: ownerId,
        initialSteps: [
          { name: "preflight", state: "completed", detail: `The fixed restic package and exact version ${plan.input.expectedVersion} were resolved without accepting a package name, repository, command, or argument from the browser` },
          { name: "checkpoint", state: "completed", detail: "The operation will not run apt update, upgrade or remove a package, mount storage, create a password, initialize a repository, start a backup, or alter retention" },
        ],
      });
    }

    if (plan.subjectId === "docker") {
      const state = await inspectDocker();
      if (!matchingDockerState(plan, state) || state.installed || !state.repairAvailable) throw new Error("Host state changed: create a new Docker Engine repair plan");
      store.stagePlan(plan.id, ownerId);
      return store.createJob({
        type: "prerequisite.docker.install",
        title: "Install and verify Docker Engine",
        risk: "system-package-service",
        parameters: { planId: plan.id, revision: plan.revision, expectedVersion: plan.input.expectedVersion, installedBefore: false },
        recovery: {
          automaticRollback: false,
          reason: "Package installation and service enablement are not reversed automatically because removal could destroy administrator-managed container tooling or worsen interrupted package state.",
          manual: "If the job fails, inspect boxpilot-docker-install.service, docker.service, dpkg, and APT state from the server console. Repair package or daemon state before creating a fresh plan. Do not remove Docker merely to match the old state.",
        },
        createdBy: ownerId,
        initialSteps: [
          { name: "preflight", state: "completed", detail: `The fixed docker.io package and exact version ${plan.input.expectedVersion} were resolved only from configured Ubuntu APT metadata; no compatible active Docker provider was present` },
          { name: "checkpoint", state: "completed", detail: "The operation will not run apt update, add a repository, upgrade or remove a package, replace an existing Docker provider, change daemon.json, add a user to the docker group, pull an image, create a container, or accept a browser command" },
        ],
      });
    }

    if (plan.subjectId === "virtualization") {
      const state = await inspectVirtualization();
      if (!matchingVirtualizationState(plan, state) || state.installed || !state.repairAvailable) throw new Error("Host state changed: create a new virtualization repair plan");
      store.stagePlan(plan.id, ownerId);
      return store.createJob({
        type: "prerequisite.virtualization.install",
        title: "Install and verify KVM, QEMU, and libvirt",
        risk: "system-package-service-virtualization",
        parameters: { planId: plan.id, revision: plan.revision, expectedPackages: plan.input.expectedPackages, expectedKvmDevice: true, installedBefore: false },
        recovery: {
          automaticRollback: false,
          reason: "Package and service installation are not reversed automatically because removal could damage administrator-managed virtualization state or worsen interrupted package configuration.",
          manual: "If the job fails, inspect boxpilot-virtualization-install.service, libvirtd.service, dpkg, APT, and /dev/kvm from the server console. Repair the host before creating a new plan. Do not remove libvirt or QEMU merely to match the old state.",
        },
        createdBy: ownerId,
        initialSteps: [
          { name: "preflight", state: "completed", detail: "The fixed five-package Ubuntu virtualization bundle and every exact candidate version were resolved only from configured APT metadata; the KVM kernel interface is registered and no provider path or package was present" },
          { name: "checkpoint", state: "completed", detail: "The operation will not run apt update, add a repository, replace a partial provider, remove packages, change an operator user or group, create a libvirt network or storage pool, create a VM, attach an ISO, or accept a browser command" },
        ],
      });
    }

    const state = await inspectAptMetadata();
    if (!matchingAptMetadataState(plan, state)) throw new Error("Host state changed: create a new APT metadata refresh plan");
    store.stagePlan(plan.id, ownerId);
    return store.createJob({
      type: "prerequisite.apt-metadata.refresh",
      title: "Refresh APT package metadata",
      risk: "system-package-metadata",
      parameters: { planId: plan.id, revision: plan.revision, expectedUpdatedAt: plan.input.expectedUpdatedAt, expectedState: plan.input.expectedState },
      recovery: {
        automaticRollback: false,
        reason: "The operation changes only repository metadata and verifies the installed package database is unchanged, so package rollback is neither needed nor attempted.",
        manual: "If the job fails, inspect boxpilot-apt-refresh.service and configured Ubuntu repositories. Resolve interrupted dpkg state before creating a fresh plan.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "The exact previous APT metadata timestamp and ready dpkg state were captured without accepting a package, repository, command, option, or target from the browser" },
        { name: "checkpoint", state: "completed", detail: "The fixed unit will run only apt-get update --error-on=any, verify installed package state is unchanged, and perform no install, upgrade, removal, service control, or reboot" },
      ],
    });
  }

  async function validateJob(job) {
    if (!["prerequisite.smartmontools.install", "prerequisite.restic.install", "prerequisite.docker.install", "prerequisite.virtualization.install", "prerequisite.apt-metadata.refresh"].includes(job.type)) throw new Error("Unsupported prerequisite repair job");
    const subjectId = job.type === "prerequisite.smartmontools.install" ? "smartmontools" : job.type === "prerequisite.restic.install" ? "restic" : job.type === "prerequisite.docker.install" ? "docker" : job.type === "prerequisite.virtualization.install" ? "virtualization" : "apt-metadata";
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.type !== "prerequisite.repair" || plan.subjectId !== subjectId || plan.revision !== job.parameters.revision) throw new Error("The staged prerequisite repair plan is unavailable or changed");
    if (subjectId === "smartmontools") {
      if (plan.input.expectedVersion !== job.parameters.expectedVersion || plan.input.installedBefore !== job.parameters.installedBefore) throw new Error("The staged smartmontools repair plan does not match the job");
      const state = await inspectSmartmontools();
      if (!matchingSmartmontoolsState(plan, state)) throw new Error("Host state changed: the smartmontools package state or candidate changed");
      return { plan, state };
    }
    if (subjectId === "restic") {
      if (plan.input.expectedVersion !== job.parameters.expectedVersion || plan.input.installedBefore !== job.parameters.installedBefore) throw new Error("The staged restic repair plan does not match the job");
      const state = await inspectRestic();
      if (!matchingResticState(plan, state)) throw new Error("Host state changed: the restic package state or candidate changed");
      return { plan, state };
    }
    if (subjectId === "docker") {
      if (plan.input.expectedVersion !== job.parameters.expectedVersion || plan.input.installedBefore !== false || job.parameters.installedBefore !== false) throw new Error("The staged Docker Engine repair plan does not match the job");
      const state = await inspectDocker();
      if (!matchingDockerState(plan, state) || state.installed || !state.repairAvailable) throw new Error("Host state changed: the Docker Engine or docker.io candidate changed");
      return { plan, state };
    }
    if (subjectId === "virtualization") {
      const parameterNames = Object.keys(job.parameters.expectedPackages ?? {}).sort();
      const planNames = Object.keys(plan.input.expectedPackages ?? {}).sort();
      if (plan.input.installedBefore !== false || job.parameters.installedBefore !== false || plan.input.expectedKvmDevice !== true || job.parameters.expectedKvmDevice !== true || parameterNames.length !== planNames.length || parameterNames.some((name, index) => name !== planNames[index] || plan.input.expectedPackages[name] !== job.parameters.expectedPackages[name])) throw new Error("The staged virtualization repair plan does not match the job");
      const state = await inspectVirtualization();
      if (!matchingVirtualizationState(plan, state) || state.installed || !state.repairAvailable) throw new Error("Host state changed: the virtualization provider, hardware, or package candidates changed");
      return { plan, state };
    }
    if (plan.input.expectedUpdatedAt !== job.parameters.expectedUpdatedAt || plan.input.expectedState !== job.parameters.expectedState) throw new Error("The staged APT metadata refresh plan does not match the job");
    const state = await inspectAptMetadata();
    if (!matchingAptMetadataState(plan, state)) throw new Error("Host state changed: APT metadata or package manager state changed");
    return { plan, state };
  }

  return { inspect: inspectSmartmontools, inspectRestic, inspectDocker, inspectVirtualization, inspectAptMetadata, planSmartmontools, planRestic, planDocker, planVirtualization, planAptMetadata, stage, validateJob };
}
