import { verifyPassword } from "./security.mjs";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";

export function createJobService(store, helper, {
  validateApplicationJob = async () => {},
  validateApplicationLifecycleJob = async () => {},
  validateKeelArtifactJob = async () => {},
  validatePrerequisiteRepairJob = async () => {},
  validateLibvirtFoundationJob = async () => {},
  validateBackupJob = async () => {},
  validateApplicationProtectionJob = async () => {},
  validateControllerProtectionJob = async () => {},
  validateControllerRetentionJob = async () => {},
  validateDnsAcceptanceJob = async () => {},
  executeDnsAcceptanceJob = async () => {},
  validateFlint2AdguardJob = async () => {},
  executeFlint2AdguardJob = async () => {},
  validateMigrationTransferJob = async () => {},
  validateVmCreationJob = async () => {},
  validateVmExportJob = async () => {},
  validateVmProtectionJob = async () => {},
  validateVmRetentionJob = async () => {},
  validateVmRestoreDrillJob = async () => {},
  validateVmRecoveryJob = async () => {},
  validateKeelRecoveryJob = async () => {},
  validateKeelRecoveryDrillJob = async () => {},
  validateKeelPromotionJob = async () => {},
  validateKeelRollbackJob = async () => {},
  validateVmLifecycleJob = async () => {},
  validateVmSnapshotJob = async () => {},
  recordBackupResult = () => {},
  recordApplicationProtectionResult = () => {},
  recordControllerProtectionResult = () => {},
  recordControllerRetentionResult = () => {},
  recordDnsAcceptanceResult = () => {},
  recordFlint2AdguardResult = () => {},
  recordMigrationTransferResult = () => {},
  recordVmExportResult = () => {},
  recordVmProtectionResult = () => {},
  recordVmRetentionResult = () => {},
  recordVmRestoreDrillResult = () => {},
  recordVmRecoveryResult = () => {},
  recordKeelRecoveryResult = () => {},
  recordKeelRecoveryDrillResult = () => {},
  recordKeelPromotionResult = () => {},
  recordKeelRollbackResult = () => {},
} = {}) {
  function createCanary(ownerId) {
    return store.createJob({
      type: "helper.canary.verify",
      title: "Verify restricted helper boundary",
      risk: "none",
      parameters: {},
      recovery: {
        automaticRollback: false,
        reason: "The canary performs no host mutation, so no rollback is required.",
        manual: "If the helper is unavailable, inspect boxpilot-helper.service and retry after it is healthy.",
      },
      createdBy: ownerId,
    });
  }

  async function prepareApproval(jobId, ownerId, password) {
    const owner = store.findOwnerById(ownerId);
    if (!owner || !(await verifyPassword(password, owner.passwordHash))) throw new Error("Approval reauthentication failed");
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job not found");
    if (job.createdBy !== ownerId) throw new Error("Job not found");
    if (!["helper.canary.verify", "prerequisite.smartmontools.install", "prerequisite.restic.install", "prerequisite.docker.install", "prerequisite.virtualization.install", "prerequisite.apt-metadata.refresh", "virtualization.foundation.initialize", "application.uptime-kuma.deploy", "application.uptime-kuma.action", "application.pi-hole.deploy", "application.keel.artifact.acquire", "application.keel.stage", "application.keel.install", "controller.database.backup", "controller.database.backup.protect", "controller.database.backup.retention.apply", "application.backup.protect", "application.uptime-kuma.backup", "application.pi-hole.backup", "application.keel.backup", "application.keel.recovery.create", "application.keel.recovery-drill.run", "application.keel.promotion", "application.keel.rollback", "network.dns.acceptance.run", "network.flint2-adguard.acceptance.run", "migration.bundle.transfer", "virtualization.domain.create", "virtualization.domain.action", "virtualization.domain.snapshot.create", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(job.type)) throw new Error("Job type is not supported by this executor");
    const validatedPrerequisiteRepair = ["prerequisite.smartmontools.install", "prerequisite.restic.install", "prerequisite.docker.install", "prerequisite.virtualization.install", "prerequisite.apt-metadata.refresh"].includes(job.type) ? await validatePrerequisiteRepairJob(job) : null;
    const validatedLibvirtFoundation = job.type === "virtualization.foundation.initialize" ? await validateLibvirtFoundationJob(job) : null;
    const validatedApplicationPlan = ["application.uptime-kuma.deploy", "application.pi-hole.deploy", "application.keel.stage", "application.keel.install"].includes(job.type) ? await validateApplicationJob(job) : null;
    const validatedApplicationLifecyclePlan = job.type === "application.uptime-kuma.action" ? await validateApplicationLifecycleJob(job) : null;
    const validatedKeelArtifactPlan = job.type === "application.keel.artifact.acquire" ? await validateKeelArtifactJob(job) : null;
    if (["controller.database.backup", "application.uptime-kuma.backup", "application.pi-hole.backup", "application.keel.backup"].includes(job.type)) await validateBackupJob(job);
    const validatedControllerProtectionPlan = job.type === "controller.database.backup.protect" ? await validateControllerProtectionJob(job) : null;
    const validatedApplicationProtectionPlan = job.type === "application.backup.protect" ? await validateApplicationProtectionJob(job) : null;
    const validatedControllerRetentionPlan = job.type === "controller.database.backup.retention.apply" ? await validateControllerRetentionJob(job) : null;
    const validatedDnsAcceptancePlan = job.type === "network.dns.acceptance.run" ? await validateDnsAcceptanceJob(job) : null;
    const validatedFlint2AdguardPlan = job.type === "network.flint2-adguard.acceptance.run" ? await validateFlint2AdguardJob(job) : null;
    const validatedMigrationTransferPlan = job.type === "migration.bundle.transfer" ? await validateMigrationTransferJob(job) : null;
    const validatedVmPlan = job.type === "virtualization.domain.create" ? await validateVmCreationJob(job) : null;
    const validatedVmExportPlan = job.type === "virtualization.domain.export.create" ? await validateVmExportJob(job) : null;
    const validatedVmProtectionPlan = job.type === "virtualization.export.backup.create" ? await validateVmProtectionJob(job) : null;
    const validatedVmRetentionPlan = job.type === "virtualization.export.backup.retention.apply" ? await validateVmRetentionJob(job) : null;
    const validatedVmRestoreDrillPlan = job.type === "virtualization.export.backup.restore-drill" ? await validateVmRestoreDrillJob(job) : null;
    const validatedVmRecoveryPlan = job.type === "virtualization.backup.recovery.create" ? await validateVmRecoveryJob(job) : null;
    const validatedKeelRecoveryPlan = job.type === "application.keel.recovery.create" ? await validateKeelRecoveryJob(job) : null;
    const validatedKeelRecoveryDrillPlan = job.type === "application.keel.recovery-drill.run" ? await validateKeelRecoveryDrillJob(job) : null;
    const validatedKeelPromotionPlan = job.type === "application.keel.promotion" ? await validateKeelPromotionJob(job) : null;
    const validatedKeelRollbackPlan = job.type === "application.keel.rollback" ? await validateKeelRollbackJob(job) : null;
    const validatedVmLifecyclePlan = job.type === "virtualization.domain.action" ? await validateVmLifecycleJob(job) : null;
    const validatedVmSnapshotPlan = job.type === "virtualization.domain.snapshot.create" ? await validateVmSnapshotJob(job) : null;
    if (job.type === "virtualization.domain.create" && !validatedVmPlan?.input) throw new Error("The staged VM creation plan is unavailable or changed");
    if (job.type === "controller.database.backup.protect" && !validatedControllerProtectionPlan?.input) throw new Error("The staged controller protection plan is unavailable or changed");
    if (job.type === "application.backup.protect" && !validatedApplicationProtectionPlan?.input) throw new Error("The staged application protection plan is unavailable or changed");
    if (job.type === "controller.database.backup.retention.apply" && !validatedControllerRetentionPlan?.input) throw new Error("The staged controller retention plan is unavailable or changed");
    if (["prerequisite.smartmontools.install", "prerequisite.restic.install", "prerequisite.docker.install", "prerequisite.virtualization.install", "prerequisite.apt-metadata.refresh"].includes(job.type) && !validatedPrerequisiteRepair?.plan?.input) throw new Error("The staged prerequisite repair plan is unavailable or changed");
    if (job.type === "virtualization.foundation.initialize" && !validatedLibvirtFoundation?.plan?.input) throw new Error("The staged libvirt foundation plan is unavailable or changed");
    if (job.type === "migration.bundle.transfer" && !validatedMigrationTransferPlan?.input) throw new Error("The staged migration transfer plan is unavailable or changed");
    if (job.type === "virtualization.domain.export.create" && !validatedVmExportPlan?.input) throw new Error("The staged VM export plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.create" && !validatedVmProtectionPlan?.input) throw new Error("The staged VM protection plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.retention.apply" && !validatedVmRetentionPlan?.input) throw new Error("The staged VM retention plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.restore-drill" && !validatedVmRestoreDrillPlan?.input) throw new Error("The staged VM restore drill plan is unavailable or changed");
    if (job.type === "virtualization.backup.recovery.create" && !validatedVmRecoveryPlan?.input) throw new Error("The staged VM recovery plan is unavailable or changed");
    if (job.type === "application.keel.recovery.create" && !validatedKeelRecoveryPlan?.input) throw new Error("The staged Keel recovery plan is unavailable or changed");
    if (job.type === "application.keel.recovery-drill.run" && !validatedKeelRecoveryDrillPlan?.input) throw new Error("The staged Keel recovery drill plan is unavailable or changed");
    if (job.type === "application.keel.promotion" && !validatedKeelPromotionPlan?.input) throw new Error("The staged Keel promotion plan is unavailable or changed");
    if (job.type === "application.keel.rollback" && !validatedKeelRollbackPlan?.input) throw new Error("The staged Keel rollback plan is unavailable or changed");
    if (job.type === "virtualization.domain.action" && !validatedVmLifecyclePlan?.input) throw new Error("The staged VM lifecycle plan is unavailable or changed");
    if (job.type === "virtualization.domain.snapshot.create" && !validatedVmSnapshotPlan?.input) throw new Error("The staged VM snapshot plan is unavailable or changed");
    if (job.type === "application.pi-hole.deploy" && !validatedApplicationPlan?.input) throw new Error("The staged Pi-hole plan is unavailable or changed");
    if (job.type === "application.uptime-kuma.action" && !validatedApplicationLifecyclePlan?.input) throw new Error("The staged Uptime Kuma lifecycle plan is unavailable or changed");
    if (job.type === "application.keel.stage" && !validatedApplicationPlan?.input) throw new Error("The staged Keel release plan is unavailable or changed");
    if (job.type === "application.keel.install" && !validatedApplicationPlan?.input) throw new Error("The staged Keel install plan is unavailable or changed");
    if (job.type === "application.keel.artifact.acquire" && !validatedKeelArtifactPlan?.input) throw new Error("The staged Keel artifact plan is unavailable or changed");
    if (job.type === "network.dns.acceptance.run" && !validatedDnsAcceptancePlan?.input) throw new Error("The staged DNS acceptance plan is unavailable or changed");
    if (job.type === "network.flint2-adguard.acceptance.run" && !validatedFlint2AdguardPlan?.input) throw new Error("The staged Flint 2 AdGuard Home acceptance plan is unavailable or changed");
    const migrationHelperInput = validatedMigrationTransferPlan?.input ? {
      transferId: validatedMigrationTransferPlan.input.transferId,
      bundleId: validatedMigrationTransferPlan.input.bundleId,
      sourceFingerprint: validatedMigrationTransferPlan.input.sourceFingerprint,
      contentRevision: validatedMigrationTransferPlan.input.contentRevision,
      expectedDestinationState: validatedMigrationTransferPlan.input.expectedDestinationState,
      expectedRemainingBytes: validatedMigrationTransferPlan.input.expectedRemainingBytes,
    } : null;
    const execution = job.type === "helper.canary.verify" ? {
      operation: "canary.verify",
      parameters: {},
      applying: "Sending typed canary request over the local Unix socket",
      applied: "Restricted helper accepted the typed request",
      verified: "Helper identity and no-mutation guarantee verified",
      failed: "The helper canary did not complete successfully",
      validate: (result) => result?.verified && result?.mutationPerformed === false,
    } : job.type === "prerequisite.smartmontools.install" ? {
      operation: "prerequisite.smartmontools.install",
      parameters: { expectedVersion: validatedPrerequisiteRepair.plan.input.expectedVersion },
      timeoutMs: 15 * 60 * 1000,
      applying: validatedPrerequisiteRepair.state.installed ? "Running the fixed root-only storage evidence scan against the already installed approved smartmontools version" : "Starting the fixed package service to install only the approved smartmontools version without apt update or browser-selected arguments",
      applied: "The fixed smartmontools package state was verified and the separate root-only storage evidence scan completed",
      verified: "The approved exact smartmontools version is installed and current bounded storage evidence was produced without changing disks, mounts, SMART settings, or unrelated packages",
      failed: "The fixed smartmontools package or storage evidence verification failed; inspect APT, dpkg, and the dedicated installation service before creating a new plan",
      validate: (result) => result?.package === "smartmontools"
        && result?.installed === true
        && result?.version === validatedPrerequisiteRepair.plan.input.expectedVersion
        && result?.scan?.completed === true
        && result?.scan?.evidenceRefreshed === true
        && result?.boundary?.fixedPackage === true
        && result?.boundary?.arbitraryPackageAccepted === false
        && result?.boundary?.aptUpdatePerformed === false
        && result?.boundary?.packageRemovalPerformed === false,
    } : job.type === "prerequisite.restic.install" ? {
      operation: "prerequisite.restic.install",
      parameters: { expectedVersion: validatedPrerequisiteRepair.plan.input.expectedVersion },
      timeoutMs: 15 * 60 * 1000,
      applying: validatedPrerequisiteRepair.state.installed ? "Verifying the already installed approved restic package and fixed binary" : "Starting the fixed package service to install only the approved restic version without apt update or browser-selected arguments",
      applied: "The fixed restic package state and binary version probe completed",
      verified: "The approved exact restic package is installed without mounting storage, creating a password, initializing a repository, starting a backup, changing retention, or altering unrelated packages",
      failed: "The fixed restic package or binary verification failed; inspect APT, dpkg, and the dedicated installation service before creating a new plan",
      validate: (result) => result?.package === "restic"
        && result?.installed === true
        && result?.version === validatedPrerequisiteRepair.plan.input.expectedVersion
        && result?.binaryVerified === true
        && result?.next?.automaticSetupPerformed === false
        && result?.boundary?.fixedPackage === true
        && result?.boundary?.arbitraryPackageAccepted === false
        && result?.boundary?.aptUpdatePerformed === false
        && result?.boundary?.packageUpgradePerformed === false
        && result?.boundary?.packageRemovalPerformed === false
        && result?.boundary?.mountChanged === false
        && result?.boundary?.passwordCreated === false
        && result?.boundary?.repositoryInitialized === false,
    } : job.type === "prerequisite.docker.install" ? {
      operation: "prerequisite.docker.install",
      parameters: { expectedVersion: validatedPrerequisiteRepair.plan.input.expectedVersion },
      timeoutMs: 15 * 60 * 1000,
      applying: "Starting the fixed root-only package unit to install the exact approved docker.io candidate, then enabling and verifying only docker.service",
      applied: "The fixed docker.io package installation and Docker daemon start completed",
      verified: "The exact approved docker.io package and active daemon were verified without repository setup, provider replacement, daemon configuration, user-group changes, image pulls, or containers",
      failed: "The fixed Docker Engine package or daemon verification failed; inspect the dedicated installation unit, docker.service, APT, and dpkg before creating a new plan",
      validate: (result) => result?.package === "docker.io"
        && result?.installed === true
        && result?.version === validatedPrerequisiteRepair.plan.input.expectedVersion
        && typeof result?.engineVersion === "string"
        && result?.serviceActive === true
        && result?.engineVerified === true
        && result?.boundary?.fixedPackage === true
        && result?.boundary?.arbitraryPackageAccepted === false
        && result?.boundary?.arbitraryRepositoryAccepted === false
        && result?.boundary?.aptUpdatePerformed === false
        && result?.boundary?.packageUpgradePerformed === false
        && result?.boundary?.packageRemovalPerformed === false
        && result?.boundary?.daemonConfigurationChanged === false
        && result?.boundary?.userGroupChanged === false
        && result?.boundary?.containerCreated === false
        && result?.boundary?.imagePulled === false,
    } : job.type === "prerequisite.virtualization.install" ? {
      operation: "prerequisite.virtualization.install",
      parameters: { expectedPackages: validatedPrerequisiteRepair.plan.input.expectedPackages },
      timeoutMs: 21 * 60 * 1000,
      applying: "Starting the fixed root-only package unit to install the exact approved Ubuntu KVM, QEMU, libvirt, virt-install, and OVMF bundle, then verifying only the system libvirt service and URI",
      applied: "The fixed virtualization package installation and libvirtd start completed",
      verified: "Every approved package version, /dev/kvm, QEMU, libvirtd.service, and qemu:///system was verified without provider replacement, operator group changes, networks, pools, VMs, or browser-selected commands",
      failed: "The fixed virtualization package, hardware, service, QEMU, or system-URI verification failed; inspect the dedicated installation unit, libvirtd.service, /dev/kvm, APT, and dpkg before creating a new plan",
      validate: (result) => result?.installed === true
        && Object.keys(validatedPrerequisiteRepair.plan.input.expectedPackages).every((name) => result?.packages?.[name] === validatedPrerequisiteRepair.plan.input.expectedPackages[name])
        && result?.serviceActive === true
        && result?.connectionUri === "qemu:///system"
        && result?.qemuVerified === true
        && result?.kvmDeviceVerified === true
        && result?.boundary?.fixedPackageSet === true
        && result?.boundary?.arbitraryPackageAccepted === false
        && result?.boundary?.arbitraryRepositoryAccepted === false
        && result?.boundary?.aptUpdatePerformed === false
        && result?.boundary?.packageRemovalPerformed === false
        && result?.boundary?.existingProviderReplaced === false
        && result?.boundary?.operatorUserGroupChanged === false
        && result?.boundary?.networkCreated === false
        && result?.boundary?.storagePoolCreated === false
        && result?.boundary?.virtualMachineCreated === false,
    } : job.type === "virtualization.foundation.initialize" ? {
      operation: "virtualization.foundation.initialize",
      parameters: { foundationId: validatedLibvirtFoundation.plan.input.foundationId, expectedRevision: validatedLibvirtFoundation.plan.input.expectedRevision },
      timeoutMs: 5 * 60 * 1000,
      applying: "Starting the fixed no-argument root unit to define, start, and enable only missing or inactive canonical default libvirt resources",
      applied: "The fixed default NAT network and default directory storage pool initialization completed",
      verified: "The canonical persistent default network and pool are active with autostart; no non-default resource, VM, disk, ISO, operator group, LAN route, firewall, or Tailscale setting changed",
      failed: "The fixed libvirt foundation failed and requested rollback of only changes made by this job; inspect the dedicated unit and default resources before creating a new plan",
      validate: (result) => result?.initialized === true
        && result?.foundationId === validatedLibvirtFoundation.plan.input.foundationId
        && result?.revisionBefore === validatedLibvirtFoundation.plan.input.expectedRevision
        && result?.ready === true
        && result?.network?.name === "default"
        && result?.pool?.name === "default"
        && result?.pool?.targetPath === "/var/lib/libvirt/images"
        && result?.rollback?.automatic === true
        && result?.rollback?.limitedToJobChanges === true
        && result?.boundary?.resourceNamesFixed === true
        && result?.boundary?.otherNetworksChanged === false
        && result?.boundary?.otherPoolsChanged === false
        && result?.boundary?.virtualMachineCreated === false
        && result?.boundary?.diskCreated === false
        && result?.boundary?.bridgeModeEnabled === false
        && result?.boundary?.browserResourceAccepted === false,
    } : job.type === "prerequisite.apt-metadata.refresh" ? {
      operation: "prerequisite.apt-metadata.refresh",
      parameters: { expectedUpdatedAt: validatedPrerequisiteRepair.plan.input.expectedUpdatedAt },
      timeoutMs: 15 * 60 * 1000,
      applying: "Starting the fixed root-only APT metadata unit with the exact approved previous timestamp and no browser-selected package, repository, command, option, or target",
      applied: "The fixed APT metadata refresh completed and the installed package database was verified unchanged",
      verified: "APT metadata is current, dpkg is ready, and no package install, upgrade, removal, service mutation, or reboot occurred",
      failed: "The fixed APT metadata refresh or immutable package-state verification failed; inspect the dedicated unit and repository availability before creating a new plan",
      validate: (result) => result?.refreshed === true
        && result?.state === "current"
        && result?.packageManagerState === "ready"
        && result?.boundary?.fixedAptUpdateOnly === true
        && result?.boundary?.packageInstallPerformed === false
        && result?.boundary?.packageUpgradePerformed === false
        && result?.boundary?.packageRemovalPerformed === false
        && result?.boundary?.serviceMutationPerformed === false
        && result?.boundary?.rebootPerformed === false
        && result?.boundary?.arbitraryCommandAccepted === false
        && result?.boundary?.browserArgumentAccepted === false,
    } : job.type === "application.keel.artifact.acquire" ? {
      operation: "application.keel.artifact.acquire",
      parameters: { acquisitionId: validatedKeelArtifactPlan.input.acquisitionId },
      timeoutMs: 15 * 60 * 1000,
      applying: "Starting the separately sandboxed fixed GitHub release acquisition with no browser-selected URL, path, filename, digest, redirect, command, or argument",
      applied: "The exact root-only Keel archive was published only after complete length and SHA-256 verification",
      verified: "Fixed acquisition evidence matched the approved Keel release; the archive remains unextracted, unexecuted, uninstalled, and disconnected from services and registration",
      failed: "Keel artifact acquisition or local verification failed; fixed partial files were removed and no application installation was attempted",
      validate: (result) => result?.acquired === true
        && result?.acquisitionId === validatedKeelArtifactPlan.input.acquisitionId
        && result?.releaseTag === keelArtifactSpec.releaseTag
        && result?.releaseCommitSha === keelArtifactSpec.releaseCommitSha
        && result?.name === keelArtifactSpec.name
        && result?.sizeBytes === keelArtifactSpec.sizeBytes
        && result?.sha256 === keelArtifactSpec.digest
        && result?.locallyVerified === true
        && result?.evidenceRecorded === true
        && result?.boundary?.networkAccess === true
        && result?.boundary?.extractionPerformed === false
        && result?.boundary?.archiveExecuted === false
        && result?.boundary?.applicationInstalled === false
        && result?.boundary?.serviceChanged === false
        && result?.boundary?.registrationChanged === false
        && result?.boundary?.arbitraryUrlAccepted === false
        && result?.boundary?.arbitraryPathAccepted === false
        && result?.boundary?.browserDigestAccepted === false
        && result?.boundary?.artifactBytesReturned === false,
    } : job.type === "application.keel.stage" ? {
      operation: "application.keel.stage",
      parameters: { stageId: validatedApplicationPlan.input.stageId },
      timeoutMs: 15 * 60 * 1000,
      applying: "Rechecking the fixed artifact and runtime archive gate, then extracting into one helper-generated root-only partial release tree",
      applied: "The exact Keel 1.2.6 tree passed package identity, required-file, state-file, link, membership, and permission checks before atomic publication",
      verified: "Keel 1.2.6 is staged as inert root-only release bytes; no service, state, account, registration, listener, archive execution, or application installation occurred",
      failed: "Keel staging failed and the helper removed its generated partial or newly published release tree without touching application state or services",
      validate: (result) => result?.staged === true
        && result?.stageId === validatedApplicationPlan.input.stageId
        && result?.version === keelArtifactSpec.releaseTag.slice(1)
        && result?.releaseTag === keelArtifactSpec.releaseTag
        && result?.releaseCommitSha === keelArtifactSpec.releaseCommitSha
        && result?.artifactDigest === keelArtifactSpec.digest
        && result?.sourceMemberCount === keelArtifactSpec.archiveMembersObservedDuringAdapterReview
        && result?.regularFiles === keelArtifactSpec.archiveRegularFilesObservedDuringAdapterReview
        && result?.directories === keelArtifactSpec.archiveDirectoriesObservedDuringAdapterReview
        && result?.managedMetadataFiles === 1
        && result?.boundary?.networkAccess === false
        && result?.boundary?.extractionPerformed === true
        && result?.boundary?.archiveExecuted === false
        && result?.boundary?.applicationInstalled === false
        && result?.boundary?.applicationStateCreated === false
        && result?.boundary?.serviceChanged === false
        && result?.boundary?.registrationChanged === false
        && result?.boundary?.listenerChanged === false
        && result?.boundary?.arbitraryPathAccepted === false
        && result?.boundary?.browserArchiveAccepted === false
        && result?.boundary?.memberNamesReturned === false
        && result?.boundary?.memberContentsReturned === false,
    } : job.type === "application.keel.install" ? {
      operation: "application.keel.install",
      parameters: { installId: validatedApplicationPlan.input.installId },
      timeoutMs: 15 * 60 * 1000,
      applying: "Creating the fixed non-login account and private state, activating the exact release, and starting one hardened loopback-only systemd service",
      applied: "Keel 1.2.6 started under its dedicated account with immutable release bytes and separate writable state",
      verified: "Keel returned its exact health identity on 127.0.0.1:3000; terminal claim, registration policy, and private access handoff remain separate",
      failed: "Keel installation failed; the fixed service, unit, environment, and activation changes were rolled back while /var/lib/keel was preserved",
      validate: (result) => result?.installed === true
        && result?.installId === validatedApplicationPlan.input.installId
        && result?.healthy === true
        && result?.releaseVersion === keelArtifactSpec.releaseTag.slice(1)
        && result?.serviceActive === true
        && result?.serviceEnabled === true
        && result?.listener === "127.0.0.1:3000"
        && result?.statePreserved === true
        && result?.claimRequired === true
        && result?.privateAccessConfigured === false
        && result?.boundary?.releaseExecuted === true
        && result?.boundary?.serviceChanged === true
        && result?.boundary?.accountChanged === true
        && result?.boundary?.applicationStateCreated === true
        && result?.boundary?.listenerChanged === true
        && result?.boundary?.registrationChanged === false
        && result?.boundary?.claimChanged === false
        && result?.boundary?.tailscaleChanged === false
        && result?.boundary?.firewallChanged === false
        && result?.boundary?.routerChanged === false
        && result?.boundary?.databaseOpened === false
        && result?.boundary?.secretRead === false
        && result?.boundary?.arbitraryPathAccepted === false
        && result?.boundary?.arbitraryCommandAccepted === false
        && result?.boundary?.browserEnvironmentAccepted === false,
    } : job.type === "network.dns.acceptance.run" ? {
      run: () => executeDnsAcceptanceJob(job, validatedDnsAcceptancePlan),
      applying: "Sending four fixed direct DNS queries from the unprivileged BoxPilot controller to the exact reviewed Pi-hole address",
      applied: "The fixed local, upstream, and negative DNS queries completed without changing any network setting",
      verified: "Pi-hole answered local UDP and TCP, public forwarding, and reserved negative tests; second-device proof and router cutover remain locked",
      failed: "Direct DNS acceptance did not pass; router and client DNS remain on the independent resolver",
      validate: (result) => result?.passed === true
        && result?.origin === "boxpilot-controller"
        && result?.secondDeviceTested === false
        && result?.routerMutationPerformed === false
        && result?.dnsCutoverPerformed === false
        && result?.clientSettingsChanged === false,
    } : job.type === "network.flint2-adguard.acceptance.run" ? {
      run: () => executeFlint2AdguardJob(job, validatedFlint2AdguardPlan),
      applying: "Sending four fixed direct DNS queries from Bigbox to the one live observed gateway after immutable Flint 2 recovery declarations",
      applied: "The observed gateway answered the fixed TCP, UDP, public, and reserved-negative queries without opening a router session",
      verified: "Direct gateway DNS evidence passed; physical model identity, AdGuard settings, DHCP advertisement, and second-device paths remain operator or future acceptance checks",
      failed: "Direct gateway DNS acceptance failed; no router, DNS advertisement, DHCP, VPN, client, or Tailscale setting was changed",
      validate: (result) => result?.passed === true
        && result?.origin === "boxpilot-controller"
        && result?.modelIdentityVerified === false
        && result?.routerMutationPerformed === false
        && result?.dnsCutoverPerformed === false
        && result?.dhcpChanged === false
        && result?.clientSettingsChanged === false,
    } : job.type === "application.uptime-kuma.action" ? {
      operation: "application.uptime-kuma.action",
      parameters: validatedApplicationLifecyclePlan.input,
      applying: `${validatedApplicationLifecyclePlan.output.label} only the exact managed Uptime Kuma container through the restricted helper`,
      applied: "Restricted helper completed the fixed container action without changing the image, Compose definition, environment, port, volume, network, data, or another container",
      verified: `Uptime Kuma reached the reviewed ${validatedApplicationLifecyclePlan.output.desired.state} state and its persistent data directory remained present`,
      failed: "Uptime Kuma lifecycle execution or exact post-action identity verification failed; persistent data was not deleted",
      validate: (result) => result?.applicationId === "uptime-kuma"
        && result?.action === validatedApplicationLifecyclePlan.input.action
        && result?.expectedRevision === validatedApplicationLifecyclePlan.input.expectedRevision
        && result?.performed === true
        && result?.state === validatedApplicationLifecyclePlan.output.desired.state
        && result?.port === validatedApplicationLifecyclePlan.output.desired.port
        && result?.running === (validatedApplicationLifecyclePlan.input.action !== "stop")
        && result?.healthy === (validatedApplicationLifecyclePlan.input.action !== "stop")
        && result?.dataPreserved === true
        && result?.boundary?.exactContainerOnly === true
        && result?.boundary?.imageChanged === false
        && result?.boundary?.composeChanged === false
        && result?.boundary?.dataDeleted === false
        && result?.boundary?.networkDeleted === false
        && result?.boundary?.arbitraryContainerAccepted === false
        && result?.boundary?.arbitraryCommandAccepted === false,
    } : job.type === "application.uptime-kuma.deploy" ? {
      operation: "application.uptime-kuma.deploy",
      parameters: { hostPort: job.parameters.hostPort },
      applying: "Applying the curated digest-pinned Uptime Kuma stack through the restricted helper",
      applied: "Restricted helper applied the curated stack without exposing the Docker socket to the web process",
      verified: "Uptime Kuma container and internal HTTP health check passed",
      failed: "Uptime Kuma did not pass deployment and health verification",
      validate: (result) => result?.installed && result?.healthy && result?.dataPreserved,
    } : job.type === "application.pi-hole.deploy" ? {
      operation: "application.pi-hole.deploy",
      parameters: { lanAddress: validatedApplicationPlan.input.lanAddress, webPort: validatedApplicationPlan.input.hostPort },
      timeoutMs: 10 * 60 * 1000,
      applying: "Starting the digest-pinned Pi-hole stack on the exact reviewed Bigbox LAN binding through the restricted helper",
      applied: "Restricted helper started Pi-hole without DHCP, router writes, client DNS changes, Tailscale changes, NET_ADMIN, or wildcard host ports",
      verified: "Pi-hole container health, exact TCP and UDP DNS bindings, LAN web binding, and no-cutover evidence passed",
      failed: "Pi-hole staging or its binding verification did not complete; router and client DNS remain unchanged",
      validate: (result) => result?.installed && result?.healthy && result?.lanAddress === validatedApplicationPlan.input.lanAddress && result?.port === validatedApplicationPlan.input.hostPort && result?.dnsTcpBound === true && result?.dnsUdpBound === true && result?.dataPreserved === true && result?.secretPreserved === true && result?.routerMutationPerformed === false && result?.dnsCutoverPerformed === false && result?.dhcpEnabled === false,
    } : job.type === "controller.database.backup" ? {
      operation: "controller.database.backup.create",
      parameters: { backupId: job.parameters.backupId },
      timeoutMs: 10 * 60 * 1000,
      applying: "Creating one WAL-aware root-only SQLite snapshot and manifest through the restricted helper without stopping BoxPilot",
      applied: "The consistent local artifact passed SHA-256, integrity, foreign-key, required-schema, and owner-state verification",
      verified: "A generated isolated copy matched the artifact checksum and passed the same database checks before the drill workspace was removed",
      failed: "The controller snapshot or isolated copy-open drill failed; the production database was not replaced, stopped, checkpointed, or modified",
      validate: (result) => result?.backupId === job.parameters.backupId
        && result?.applicationId === "boxpilot-controller"
        && result?.consistentSnapshot === true
        && result?.snapshotMethod === "sqlite-vacuum-into"
        && result?.sourceServiceStopped === false
        && result?.downtimeMs === 0
        && result?.restoreDrill?.passed === true
        && result?.restoreDrill?.mode === "isolated-copy-open"
        && result?.restoreDrill?.copyChecksumMatched === true
        && result?.restoreDrill?.integrityCheck === "ok"
        && result?.restoreDrill?.foreignKeyIssues === 0
        && result?.restoreDrill?.schemaVerified === true
        && result?.restoreDrill?.ownerStatePresent === true
        && result?.restoreDrill?.workspaceRemoved === true
        && result?.restoreDrill?.productionDatabaseReplaced === false
        && result?.restoreDrill?.serviceStarted === false
        && result?.boundary?.databaseContentReturned === false
        && result?.boundary?.browserPathAccepted === false
        && result?.boundary?.browserCommandAccepted === false
        && result?.boundary?.productionDatabaseChanged === false
        && result?.boundary?.serviceStopped === false
        && result?.boundary?.networkAccessRequired === false
        && result?.boundary?.independentCopyCreated === false
        && result?.boundary?.retentionPerformed === false,
    } : job.type === "controller.database.backup.protect" ? {
      operation: "controller.database.protection.create",
      parameters: validatedControllerProtectionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Reverifying the local controller snapshot and writing it to the separate encrypted independent restic repository",
      applied: "Restic published an encrypted controller snapshot without changing the live database or local backup",
      verified: "A full repository data read, exact snapshot readback, restored hashes, and isolated SQLite copy-open checks passed",
      failed: "Independent controller protection did not complete; preserve the local backup, encrypted repository, and any generated root-only drill workspace for inspection",
      validate: (result) => result?.created === true
        && result?.protectionId === validatedControllerProtectionPlan.input.protectionId
        && result?.backupId === validatedControllerProtectionPlan.input.backupId
        && result?.encrypted === true
        && result?.independent === true
        && result?.repositoryVerified === true
        && result?.protected === true
        && result?.restoreDrill?.passed === true
        && result?.restoreDrill?.mode === "exact-snapshot-isolated-copy-open"
        && result?.restoreDrill?.network === "none"
        && result?.restoreDrill?.productionDatabaseReplaced === false,
    } : job.type === "application.backup.protect" ? {
      operation: "application.backup.protection.create",
      parameters: validatedApplicationProtectionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Reverifying the local application archive and writing it to the separate encrypted independent restic repository",
      applied: "Restic published an encrypted application snapshot without changing the running application or local backup",
      verified: "A full repository data read, exact snapshot readback, and byte-for-byte restored archive check passed",
      failed: "Independent application protection did not complete; preserve the local backup, encrypted repository, and any generated root-only drill workspace for inspection",
      validate: (result) => result?.created === true
        && result?.protectionId === validatedApplicationProtectionPlan.input.protectionId
        && result?.backupId === validatedApplicationProtectionPlan.input.backupId
        && result?.applicationId === validatedApplicationProtectionPlan.input.applicationId
        && result?.encrypted === true
        && result?.independent === true
        && result?.repositoryVerified === true
        && result?.protected === true
        && result?.restoreDrill?.passed === true
        && result?.restoreDrill?.mode === "exact-snapshot-artifact-restore"
        && result?.restoreDrill?.network === "none"
        && result?.restoreDrill?.artifactChecksumMatched === true
        && result?.restoreDrill?.applicationStarted === false
        && result?.restoreDrill?.productionStateReplaced === false,
    } : job.type === "controller.database.backup.retention.apply" ? {
      operation: "controller.database.protection.retention.apply",
      parameters: validatedControllerRetentionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Forgetting only the exact reviewed old independently protected controller snapshot references through the restricted helper",
      applied: "Restic removed the approved controller snapshot metadata without running prune or changing the live database and local artifacts",
      verified: "A full controller repository data read passed, every approved snapshot is absent, and every noncandidate snapshot remains",
      failed: "Controller retention did not complete or verify; do not retry until repository and durable protection evidence are inspected",
      validate: (result) => result?.applied && result?.complete === true && result?.retentionId === validatedControllerRetentionPlan.input.retentionId && result?.repositoryId === validatedControllerRetentionPlan.input.repositoryId && result?.repositoryVerified === true && result?.prunePerformed === false && result?.spaceReclaimed === false,
    } : job.type === "application.uptime-kuma.backup" ? {
      operation: "application.uptime-kuma.backup",
      parameters: { backupId: job.parameters.backupId },
      applying: "Stopping the source cleanly, archiving managed data, and restarting it through the restricted helper",
      applied: "Source health returned and the immutable backup artifact passed SHA-256 integrity collection",
      verified: "An isolated no-network restore container passed health verification and was removed",
      failed: "The backup or isolated restore drill did not pass verification",
      validate: (result) => result?.backupId === job.parameters.backupId && result?.sourceRestartVerified && result?.restoreDrill?.passed,
    } : job.type === "application.pi-hole.backup" ? {
      operation: "application.pi-hole.backup",
      parameters: { backupId: job.parameters.backupId },
      timeoutMs: 10 * 60 * 1000,
      applying: "Stopping Pi-hole cleanly, archiving its configuration and administrator secret, and restarting the exact source bindings through the restricted helper",
      applied: "Pi-hole health and exact bindings returned; the root-only local artifact passed SHA-256 integrity collection",
      verified: "An isolated no-network, no-published-port Pi-hole restore container passed health verification and was removed; router and client DNS were unchanged",
      failed: "The Pi-hole backup or isolated restore drill did not pass verification; keep router and client DNS on the independent resolver",
      validate: (result) => result?.backupId === job.parameters.backupId
        && result?.applicationId === "pi-hole"
        && result?.sourceRestartVerified === true
        && result?.routerMutationPerformed === false
        && result?.dnsCutoverPerformed === false
        && result?.restoreDrill?.passed === true
        && result?.restoreDrill?.network === "none"
        && result?.restoreDrill?.publishedPorts === 0
        && result?.restoreDrill?.configurationIncluded === true
        && result?.restoreDrill?.administratorSecretIncluded === true
        && result?.restoreDrill?.routerMutationPerformed === false
        && result?.restoreDrill?.dnsCutoverPerformed === false,
    } : job.type === "application.keel.backup" ? {
      operation: "application.keel.backup",
      parameters: { backupId: job.parameters.backupId },
      timeoutMs: 20 * 60 * 1000,
      applying: "Stopping only Keel, running its fixed export as the dedicated service identity, creating a root-only archive, and restarting the exact loopback service",
      applied: "Keel health returned and the immutable export artifact, manifest, complete tree digest, and SQLite evidence were recorded",
      verified: "An isolated no-network restored export passed manifest, tree, SQLite integrity, foreign-key, and schema verification without starting another application",
      failed: "The Keel backup or isolated restore drill did not pass; the fixed recovery path requested source restart and preserved production state",
      validate: (result) => result?.backupId === job.parameters.backupId
        && result?.applicationId === "keel"
        && result?.releaseVersion === "1.2.6"
        && result?.sourceRestartVerified === true
        && result?.restoreDrill?.passed === true
        && result?.restoreDrill?.mode === "isolated-keel-export-open"
        && result?.restoreDrill?.network === "none"
        && result?.restoreDrill?.publishedPorts === 0
        && result?.restoreDrill?.databaseIntegrity === "ok"
        && result?.restoreDrill?.foreignKeyIssues === 0
        && result?.restoreDrill?.schemaVerified === true
        && result?.restoreDrill?.environmentIncluded === true
        && result?.restoreDrill?.treeDigestMatched === true
        && result?.restoreDrill?.applicationStarted === false
        && result?.restoreDrill?.productionStateReplaced === false
        && result?.boundary?.sourceServiceStopped === true
        && result?.boundary?.sourceRestarted === true
        && result?.boundary?.secretContentReturned === false
        && result?.boundary?.environmentContentReturned === false
        && result?.boundary?.registrationChanged === false
        && result?.boundary?.claimChanged === false
        && result?.boundary?.tailscaleChanged === false
        && result?.boundary?.firewallChanged === false
        && result?.boundary?.routerChanged === false,
    } : job.type === "application.keel.recovery.create" ? {
      operation: "application.keel.recovery.create",
      parameters: validatedKeelRecoveryPlan.input,
      timeoutMs: 20 * 60 * 1000,
      applying: "Rehashing the selected Keel backup and extracting it into one generated root-only recovery workspace",
      applied: "The portable export was transformed into a stopped Keel state layout without changing production",
      verified: "Manifest, complete tree, managed secret, SQLite integrity, foreign keys, schema, permissions, and no-start no-network boundaries passed",
      failed: "The Keel recovery clone did not complete; production and the source backup remain unchanged and only the generated partial directory may have been removed",
      validate: (result) => result?.created === true
        && result?.recoveryId === validatedKeelRecoveryPlan.input.recoveryId
        && result?.backupId === validatedKeelRecoveryPlan.input.backupId
        && result?.destination === "managed-keel-recovery"
        && result?.sourceArtifactChecksumSha256 === validatedKeelRecoveryPlan.input.expectedArtifactChecksumSha256
        && result?.sourceManifestChecksumSha256 === validatedKeelRecoveryPlan.input.expectedManifestChecksumSha256
        && result?.sourceSizeBytes === validatedKeelRecoveryPlan.input.expectedSizeBytes
        && result?.databaseIntegrity === "ok"
        && result?.foreignKeyIssues === 0
        && result?.schemaVerified === true
        && result?.initialState === "stopped"
        && result?.network === "none"
        && result?.applicationStarted === false
        && result?.productionStateReplaced === false
        && result?.promotionPerformed === false,
    } : job.type === "application.keel.recovery-drill.run" ? {
      operation: "application.keel.recovery-drill.create",
      parameters: validatedKeelRecoveryDrillPlan.input,
      timeoutMs: 20 * 60 * 1000,
      applying: "Copying the stopped Keel recovery into one private-network disposable workspace and starting the fixed release as the dedicated account",
      applied: "The disposable Keel process returned its exact health identity and stopped cleanly",
      verified: "SQLite health, source recovery immutability, zero published ports, production isolation, and workspace removal passed",
      failed: "The isolated Keel startup rehearsal failed; only the generated drill process and partial workspace were eligible for cleanup",
      validate: (result) => result?.passed === true
        && result?.drillId === validatedKeelRecoveryDrillPlan.input.drillId
        && result?.recoveryId === validatedKeelRecoveryDrillPlan.input.recoveryId
        && result?.sourceEvidenceChecksumSha256 === validatedKeelRecoveryDrillPlan.input.expectedEvidenceChecksumSha256
        && result?.sourceStateTreeDigestSha256 === validatedKeelRecoveryDrillPlan.input.expectedStateTreeDigestSha256
        && result?.healthIdentityVerified === true && result?.databaseIntegrity === "ok" && result?.foreignKeyIssues === 0 && result?.schemaVerified === true
        && result?.processStarted === true && result?.processStopped === true && result?.network === "private-loopback-only" && result?.publishedPorts === 0
        && result?.workspaceRemoved === true && result?.sourceRecoveryUnchanged === true && result?.productionStateReplaced === false
        && result?.productionServiceChanged === false && result?.claimChanged === false && result?.registrationChanged === false
        && result?.loginTested === false && result?.promotionPerformed === false,
    } : job.type === "application.keel.promotion" ? {
      operation: "application.keel.promotion.create",
      parameters: validatedKeelPromotionPlan.input,
      timeoutMs: 20 * 60 * 1000,
      applying: "Stopping only managed Keel, atomically checkpointing current production, and activating the exact drilled recovery state",
      applied: "The drilled Keel recovery state was activated and the entire previous production state was retained in a root-only rollback checkpoint",
      verified: "Fixed health, SQLite integrity, source recovery immutability, rollback availability, and unchanged exposure boundaries passed",
      failed: "Keel promotion failed; the fixed unit attempted to restore and health-check the exact previous production state",
      validate: (result) => result?.passed === true && result?.promotionId === validatedKeelPromotionPlan.input.promotionId
        && result?.recoveryId === validatedKeelPromotionPlan.input.recoveryId && result?.drillId === validatedKeelPromotionPlan.input.drillId
        && result?.previousInstallId === validatedKeelPromotionPlan.input.expectedInstallId
        && result?.sourceEvidenceChecksumSha256 === validatedKeelPromotionPlan.input.expectedEvidenceChecksumSha256
        && result?.sourceStateTreeDigestSha256 === validatedKeelPromotionPlan.input.expectedStateTreeDigestSha256
        && result?.promotedStateTreeDigestSha256 === validatedKeelPromotionPlan.input.expectedStateTreeDigestSha256
        && result?.rollbackAvailable === true && result?.healthIdentityVerified === true && result?.databaseIntegrity === "ok"
        && result?.foreignKeyIssues === 0 && result?.schemaVerified === true && result?.productionStateReplaced === true
        && result?.sourceRecoveryUnchanged === true && result?.ownerLoginTested === false
        && result?.publishedPortsChanged === false && result?.tailscaleChanged === false && result?.firewallChanged === false && result?.routerChanged === false,
    } : job.type === "application.keel.rollback" ? {
      operation: "application.keel.rollback.create",
      parameters: validatedKeelRollbackPlan.input,
      timeoutMs: 20 * 60 * 1000,
      applying: "Stopping only managed Keel, atomically retaining current production, and activating the exact retained pre-promotion checkpoint",
      applied: "The retained pre-promotion Keel state was activated while the entire displaced current production state and original checkpoint were preserved",
      verified: "Fixed health, SQLite integrity, original-checkpoint immutability, displaced-state retention, and unchanged exposure boundaries passed",
      failed: "Keel operator rollback failed; the fixed unit attempted to restore and health-check the exact displaced current production state",
      validate: (result) => result?.passed === true && result?.rollbackId === validatedKeelRollbackPlan.input.rollbackId
        && result?.promotionId === validatedKeelRollbackPlan.input.promotionId && result?.installId === validatedKeelRollbackPlan.input.expectedInstallId
        && result?.sourceRollbackEvidenceChecksumSha256 === validatedKeelRollbackPlan.input.expectedRollbackEvidenceChecksumSha256
        && result?.sourcePreviousStateTreeDigestSha256 === validatedKeelRollbackPlan.input.expectedPreviousStateTreeDigestSha256
        && result?.restoredStateTreeDigestSha256 === validatedKeelRollbackPlan.input.expectedPreviousStateTreeDigestSha256
        && result?.displacedStateRetained === true && result?.sourceRollbackCheckpointUnchanged === true
        && result?.rollbackRequested === true && result?.productionStateReplaced === true && result?.healthIdentityVerified === true
        && result?.databaseIntegrity === "ok" && result?.foreignKeyIssues === 0 && result?.schemaVerified === true
        && result?.automaticFailureRecoveryTested === false
        && result?.ownerLoginTested === false && result?.publishedPortsChanged === false && result?.tailscaleChanged === false
        && result?.firewallChanged === false && result?.routerChanged === false,
    } : job.type === "migration.bundle.transfer" ? {
      operation: "migration.bundle.transfer",
      parameters: migrationHelperInput,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Copying or resuming the exact checksummed migration bundle into isolated managed staging",
      applied: "Restricted helper staged the immutable bundle without changing the source workload, routes, DNS, containers, or ports",
      verified: "Every staged file passed SHA-256 and complete inventory verification; activation and source deletion remain disabled",
      failed: "Migration staging did not complete; the source remains unchanged and an isolated partial destination may be resumable",
      validate: (result) => result?.created && result?.transferId === validatedMigrationTransferPlan.input.transferId && result?.bundleId === validatedMigrationTransferPlan.input.bundleId && result?.contentVerified === true && result?.sourcePreserved === true && result?.activationPerformed === false && result?.networkCutoverPerformed === false && result?.sourceDeletionPerformed === false,
    } : job.type === "virtualization.domain.create" ? {
      operation: "virtualization.domain.create",
      parameters: validatedVmPlan.input,
      applying: "Creating the exact validated VM through the restricted libvirt helper",
      applied: "Restricted helper created the domain without accepting a command, path, or argument array from the web process",
      verified: "Domain identity, allocated disk, default network, and requested autostart state were verified",
      failed: "VM creation or its post-create verification did not complete successfully",
      validate: (result) => result?.created && result?.verified && result?.domain === validatedVmPlan.input.name && result?.media === validatedVmPlan.input.isoFile,
    } : job.type === "virtualization.domain.export.create" ? {
      operation: "virtualization.domain.export.create",
      parameters: validatedVmExportPlan.input,
      timeoutMs: 6 * 60 * 60 * 1000,
      applying: "Exporting the reviewed stopped VM into a new local, root-only artifact through the restricted helper",
      applied: "Restricted helper flattened the current VM state into standalone qcow2 disks and collected SHA-256 integrity metadata",
      verified: "Exported disks passed qemu-img structural checks and source-to-export content comparison; this local unencrypted copy is not yet a protected backup",
      failed: "VM export or content verification did not complete successfully; the source VM remains unchanged",
      validate: (result) => result?.created && result?.contentVerified && result?.domain === validatedVmExportPlan.input.name && result?.exportId === validatedVmExportPlan.input.exportId && result?.protected === false && result?.encrypted === false && result?.restoreDrill?.passed === false,
    } : job.type === "virtualization.export.backup.create" ? {
      operation: "virtualization.export.backup.create",
      parameters: validatedVmProtectionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Reverifying the local export and writing an encrypted snapshot to the reviewed independent restic destination",
      applied: "Restic published an encrypted snapshot without changing the local VM export or deleting repository data",
      verified: "Local SHA-256 evidence, a full repository data read, and exact snapshot identity passed; isolated restore boot remains required before protected status",
      failed: "Encrypted independent VM backup or repository verification did not complete successfully; preserve both the local export and repository for inspection",
      validate: (result) => result?.created && result?.backupId === validatedVmProtectionPlan.input.backupId && result?.exportId === validatedVmProtectionPlan.input.exportId && result?.encrypted === true && result?.independent === true && result?.repositoryVerified === true && result?.protected === false && result?.restoreDrill?.passed === false,
    } : job.type === "virtualization.export.backup.retention.apply" ? {
      operation: "virtualization.export.backup.retention.apply",
      parameters: validatedVmRetentionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Forgetting only the exact reviewed old protected snapshot references through the restricted helper",
      applied: "Restic removed the approved snapshot metadata without running prune or changing source VMs and local exports",
      verified: "A full repository data read passed, every approved snapshot is absent, and every noncandidate snapshot remains",
      failed: "VM retention did not complete or verify; do not retry until repository and durable backup evidence are inspected",
      validate: (result) => result?.applied && result?.complete === true && result?.retentionId === validatedVmRetentionPlan.input.retentionId && result?.repositoryId === validatedVmRetentionPlan.input.repositoryId && result?.repositoryVerified === true && result?.prunePerformed === false && result?.spaceReclaimed === false,
    } : job.type === "virtualization.export.backup.restore-drill" ? {
      operation: "virtualization.export.backup.restore-drill",
      parameters: validatedVmRestoreDrillPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Restoring the exact encrypted snapshot and booting its disks as a transient no-network domain through the restricted helper",
      applied: "Restic restored and reverified the snapshot; the transient domain started without a network interface",
      verified: "Restored checksums and qcow2 structures, repeated guest-agent health, transient isolation, and complete successful cleanup passed",
      failed: "The isolated restore drill did not complete; protected status remains false and the restored workspace is preserved for inspection",
      validate: (result) => result?.passed && result?.drillId === validatedVmRestoreDrillPlan.input.drillId && result?.backupId === validatedVmRestoreDrillPlan.input.backupId && result?.network === "none" && result?.transient === true && result?.persistentDomainCreated === false && result?.guestAgentPing === true && result?.temporaryQemuDiskAccessGranted === true && result?.temporaryQemuDiskAccessRemoved === true && result?.transientFirmwareStateRemoved === true && result?.cleanupVerified === true && result?.protected === true,
    } : job.type === "virtualization.backup.recovery.create" ? {
      operation: "virtualization.backup.recovery.create",
      parameters: validatedVmRecoveryPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Restoring the exact protected snapshot and materializing verified disks in a new managed recovery directory",
      applied: "Verified recovery disks were materialized and a new persistent no-network libvirt domain was defined",
      verified: "The recovery clone is stopped, persistent, non-autostarting, network-isolated, and tied to exact protected source evidence",
      failed: "The recovery clone did not complete; BoxPilot confined rollback to the new target name and server-generated recovery directory",
      validate: (result) => result?.created && result?.restoreId === validatedVmRecoveryPlan.input.restoreId && result?.backupId === validatedVmRecoveryPlan.input.backupId && result?.domain === validatedVmRecoveryPlan.input.targetDomainName && result?.persistent === true && result?.state === "stopped" && result?.network === "none" && result?.autostart === false && result?.sourceUnchanged === true && result?.snapshotUnchanged === true,
    } : job.type === "virtualization.domain.action" ? {
      operation: "virtualization.domain.action",
      parameters: validatedVmLifecyclePlan.input,
      applying: `Requesting the reviewed ${validatedVmLifecyclePlan.output.label.toLowerCase()} operation through the restricted libvirt helper`,
      applied: "Restricted helper accepted the fixed lifecycle operation after independently matching current VM state",
      verified: "Post-operation power and autostart state matched the reviewed lifecycle plan",
      failed: "VM lifecycle execution or state verification did not complete successfully",
      validate: (result) => result?.verified && result?.domain === validatedVmLifecyclePlan.input.name && result?.action === validatedVmLifecyclePlan.input.action,
    } : {
      operation: "virtualization.domain.snapshot.create",
      parameters: validatedVmSnapshotPlan.input,
      applying: "Creating the reviewed internal snapshot for the stopped domain through the restricted libvirt helper",
      applied: "Restricted helper created the snapshot after independently matching domain UUID, stopped state, managed qcow2 disks, and snapshot inventory",
      verified: "Snapshot is current, internal, and records an offline-consistent stopped guest state",
      failed: "Snapshot creation or offline consistency verification did not complete successfully; leave the VM stopped for inspection",
      validate: (result) => result?.created && result?.verified && result?.domain === validatedVmSnapshotPlan.input.name && result?.snapshotName === validatedVmSnapshotPlan.input.snapshotName && result?.consistency === "offline-consistent" && result?.independentBackup === false,
    };
    store.addApproval(jobId, ownerId);
    store.recordAudit("job.approved", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
    store.transitionJob(jobId, "awaiting_approval", "applying");
    store.addJobStep(jobId, "approval", "completed", `Approved by ${owner.username}`);
    store.addJobStep(jobId, "apply", "running", execution.applying);
    return { job, owner, execution };
  }

  async function executePrepared({ job, owner, execution }) {
    const jobId = job.id;
    try {
      const result = execution.run
        ? await execution.run()
        : execution.timeoutMs
          ? await helper.request(execution.operation, execution.parameters, { timeoutMs: execution.timeoutMs })
          : await helper.request(execution.operation, execution.parameters);
      store.transitionJob(jobId, "applying", "verifying", { result });
      store.addJobStep(jobId, "apply", "completed", execution.applied);
      if (job.type === "virtualization.export.backup.retention.apply" && result?.applied === true) recordVmRetentionResult(job, result);
      if (job.type === "controller.database.backup.retention.apply" && result?.applied === true) recordControllerRetentionResult(job, result);
      if (!execution.validate(result)) throw new Error(execution.run ? "Operation returned an invalid result" : "Helper returned an invalid operation result");
      if (["controller.database.backup", "application.uptime-kuma.backup", "application.pi-hole.backup", "application.keel.backup"].includes(job.type)) recordBackupResult(job, result);
      if (job.type === "controller.database.backup.protect") recordControllerProtectionResult(job, result);
      if (job.type === "application.backup.protect") recordApplicationProtectionResult(job, result);
      if (job.type === "network.dns.acceptance.run") recordDnsAcceptanceResult(job, result);
      if (job.type === "network.flint2-adguard.acceptance.run") recordFlint2AdguardResult(job, result);
      if (job.type === "migration.bundle.transfer") recordMigrationTransferResult(job, result);
      if (job.type === "virtualization.domain.export.create") recordVmExportResult(job, result);
      if (job.type === "virtualization.export.backup.create") recordVmProtectionResult(job, result);
      if (job.type === "virtualization.export.backup.restore-drill") recordVmRestoreDrillResult(job, result);
      if (job.type === "virtualization.backup.recovery.create") recordVmRecoveryResult(job, result);
      if (job.type === "application.keel.recovery.create") recordKeelRecoveryResult(job, result);
      if (job.type === "application.keel.recovery-drill.run") recordKeelRecoveryDrillResult(job, result);
      if (job.type === "application.keel.promotion") recordKeelPromotionResult(job, result);
      if (job.type === "application.keel.rollback") recordKeelRollbackResult(job, result);
      store.addJobStep(jobId, "verify", "completed", execution.verified);
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      return completed;
    } catch (error) {
      const current = store.getJob(jobId);
      if (["applying", "verifying"].includes(current?.state)) {
        store.addJobStep(jobId, "verify", "failed", execution.failed);
        if (job.type === "application.uptime-kuma.deploy" && error.message.includes("Automated rollback completed")) {
          store.addJobStep(jobId, "rollback", "completed", "Managed container and network were removed or the previous Compose definition was restored; data was preserved");
        }
        if (job.type === "application.pi-hole.deploy" && error.message.includes("Automated rollback completed")) {
          store.addJobStep(jobId, "rollback", "completed", "Managed Pi-hole was removed or its previous Compose definition was restored; configuration and the administrator secret were preserved; router and client DNS were unchanged");
        }
        if (job.type === "virtualization.domain.create" && error.message.includes("Automated rollback completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The newly created exact-name domain and its allocated storage were removed");
        }
        if (job.type === "virtualization.domain.export.create" && error.message.includes("Automated export cleanup completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The incomplete new export directory was removed; the source domain and disks were not changed");
        }
        if (job.type === "virtualization.export.backup.restore-drill" && error.message.includes("Transient drill domain cleanup completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The server-generated transient drill domain was removed; restored files were preserved for inspection");
        }
        if (job.type === "virtualization.backup.recovery.create" && error.message.includes("Automatic recovery-clone rollback removed")) {
          store.addJobStep(jobId, "rollback", "completed", "The incomplete new recovery domain definition and its server-generated disk directory were removed; protected source evidence was unchanged");
        }
        if (job.type === "application.keel.rollback" && error.message.includes("automatic recovery restored")) {
          store.addJobStep(jobId, "rollback", "completed", "The displaced current Keel production state was restored and its fixed loopback health identity passed");
        }
        if (job.type === "migration.bundle.transfer") {
          store.addJobStep(jobId, "recovery", "required", "The source is unchanged. Reinspect and create a new plan to resume only exact verified staged files; no activation or source deletion occurred");
        }
        store.transitionJob(jobId, current.state, "failed", { error: error.message });
      }
      store.recordAudit("job.failed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      throw error;
    }
  }

  async function approveAndRun(jobId, ownerId, password) {
    return executePrepared(await prepareApproval(jobId, ownerId, password));
  }

  async function approveAndStart(jobId, ownerId, password) {
    const prepared = await prepareApproval(jobId, ownerId, password);
    void executePrepared(prepared).catch(() => {});
    return store.getJob(jobId);
  }

  return { createCanary, approveAndRun, approveAndStart };
}
