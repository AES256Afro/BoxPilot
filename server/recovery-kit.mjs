import { productVersion } from "./version.mjs";

function latestBy(items, key) {
  const result = new Map();
  for (const item of items) if (!result.has(item[key])) result.set(item[key], item);
  return result;
}

function check(id, state, title, evidence, action) {
  return { id, state, title, evidence, action };
}

function settledValue(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

function renderRunbook(kit) {
  const lines = [
    `# BoxPilot ${kit.product.version} disaster recovery kit`,
    "",
    `Generated: ${kit.generatedAt}`,
    "",
    "> Private operator document. It contains no stored credential, private key, application data, router configuration, database file, backup passphrase, or arbitrary log output. It is evidence and guidance, not a backup.",
    "",
    "## Readiness",
    "",
    `Status: ${kit.summary.status}`,
    `Verified: ${kit.summary.verified} | Action required: ${kit.summary.actionRequired} | Operator checks: ${kit.summary.operatorChecks} | Not applicable: ${kit.summary.notApplicable}`,
    "",
  ];
  for (const item of kit.checks) {
    lines.push(`### ${item.title}`, "", `State: ${item.state}`, "", item.evidence, "", `Next action: ${item.action}`, "");
  }
  lines.push("## Recovery order", "");
  for (const item of kit.recoveryOrder) lines.push(`${item.order}. ${item.title}: ${item.instruction}`);
  lines.push("", "## Evidence inventory", "", `Recent jobs: ${kit.evidence.jobs.length}`, `Controller backups: ${kit.evidence.controllerBackups.length}`, `Protected controller snapshots: ${kit.evidence.controllerProtections.length}`, `Controller retention runs: ${kit.evidence.controllerRetentionRuns.length}`, `Application backups: ${kit.evidence.applicationBackups.length}`, `Protected application snapshots: ${kit.evidence.applicationProtections.length}`, `Application retention runs: ${kit.evidence.applicationRetentionRuns.length}`, `Retained VM backups: ${kit.evidence.vmBackups.length}`, `Router checkpoints: ${kit.evidence.routerCheckpoints.length}`, `Verified migration transfers: ${kit.evidence.migrationTransfers.length}`, `Fleet agents: ${kit.evidence.fleet.activeAgents} active, ${kit.evidence.fleet.revokedAgents} revoked`, "", "## External items BoxPilot cannot prove", "");
  for (const item of kit.externalItems) lines.push(`- ${item}`);
  lines.push("", "## Export boundary", "");
  for (const item of kit.boundary.excluded) lines.push(`- Excluded: ${item}`);
  lines.push("");
  return lines.join("\n");
}

export function createRecoveryKitService({ store, prerequisites, applications, libvirt, now = () => new Date(), version = productVersion } = {}) {
  async function inspect() {
    const [prerequisiteResult, applicationResult, domainResult] = await Promise.allSettled([
      prerequisites.inspect(),
      applications.list(),
      libvirt.listDomains(),
    ]);
    const prerequisiteInventory = settledValue(prerequisiteResult, { checks: [] });
    const applicationInventory = settledValue(applicationResult, { applications: [] });
    const domainInventory = settledValue(domainResult, { connected: false, domains: [] });
    const prerequisiteInventoryAvailable = prerequisiteResult.status === "fulfilled";
    const applicationInventoryAvailable = applicationResult.status === "fulfilled";
    const jobs = store.listJobs(100);
    const allBackups = store.listBackups(200);
    const controllerBackups = allBackups.filter((item) => item.applicationId === "boxpilot-controller");
    const controllerProtections = store.listControllerBackupProtections(200).filter((item) => item.protected && item.encrypted && item.independent && item.repositoryVerified && item.restoreDrill?.passed);
    const controllerRetentionRuns = store.listControllerRetentionRuns?.(200) ?? [];
    const applicationRetentionRuns = store.listApplicationRetentionRuns?.(200) ?? [];
    const protectedControllerBackup = controllerBackups.find((backup) => controllerProtections.some((protection) => protection.backupId === backup.id)) ?? null;
    const applicationBackups = allBackups.filter((item) => item.applicationId !== "boxpilot-controller");
    const applicationProtections = (store.listApplicationBackupProtections?.(200) ?? []).filter((item) => item.protected && item.encrypted && item.independent && item.repositoryVerified && item.restoreDrill?.passed && item.restoreDrill?.artifactChecksumMatched);
    const vmBackups = store.listVmBackups(200).filter((item) => item.retained !== false);
    const routerCheckpoints = store.listRouterCheckpoints(200);
    const migrationTransfers = store.listMigrationTransfers(200);
    const fleetAgents = store.listFleetAgents(200);
    const fleetEvidence = store.listFleetEvidence(200);
    const dnsAcceptances = store.listDnsAcceptances(200);

    const installedApplications = applicationInventory.applications.filter((item) => item.live?.installed === true);
    const latestApplicationBackup = latestBy(applicationBackups, "applicationId");
    const locallyUnverifiedApplications = installedApplications.filter((item) => latestApplicationBackup.get(item.id)?.restoreDrill?.passed !== true);
    const independentlyUnprotectedApplications = installedApplications.filter((item) => {
      const latest = latestApplicationBackup.get(item.id);
      return !latest || !applicationProtections.some((protection) => protection.backupId === latest.id && protection.applicationId === item.id);
    });
    const domains = domainInventory.connected === true ? domainInventory.domains : [];
    const protectedDomainNames = new Set(vmBackups.filter((item) => item.protected && item.encrypted && item.independent && item.repositoryVerified && item.restoreDrill?.passed).map((item) => item.domainName));
    const unprotectedDomains = domains.filter((item) => !protectedDomainNames.has(item.name));
    const passingDirectDnsEvidence = dnsAcceptances.filter((item) => item.passed && item.origin === "boxpilot-controller");
    const directAcceptanceIds = new Set(passingDirectDnsEvidence.map((item) => item.id));
    const passingLinkedSecondDeviceEvidence = fleetEvidence.filter((item) => item.passed === true && item.result?.secondDeviceTested === true && directAcceptanceIds.has(item.result?.controllerAcceptanceId) && item.result?.routerMutationPerformed === false && item.result?.dnsCutoverPerformed === false && item.result?.clientSettingsChanged === false);
    const directDnsEvidence = passingDirectDnsEvidence.length > 0;
    const secondDeviceEvidence = passingLinkedSecondDeviceEvidence.length > 0;
    const nonReadyPrerequisites = prerequisiteInventory.checks.filter((item) => item.status !== "ready");

    const checks = [
      protectedControllerBackup
        ? check("controller.database", "verified", "Independent BoxPilot database recovery", `Controller backup ${protectedControllerBackup.id} has an encrypted independent restic snapshot, a complete repository read, and an exact isolated database restore drill.`, "Keep the repository and its separate recovery password in different failure domains. Repeat protection after material controller-state changes.")
        : controllerBackups[0]?.restoreDrill?.passed === true
        ? check("controller.database", "operator-check", "Independent BoxPilot database copy", `A WAL-aware local controller snapshot passed its isolated copy-open drill at ${controllerBackups[0].verifiedAt}, but it remains on this server.`, "Copy the complete root-only backup directory and manifest to encrypted independent storage, verify both recorded SHA-256 values there, and retain the restore procedure.")
        : check("controller.database", "action-required", "Verified BoxPilot database snapshot", "No WAL-aware local controller snapshot with passing isolated copy-open evidence is recorded.", "Open Backups and run the BoxPilot controller workflow. Then copy the verified directory and manifest to encrypted independent storage."),
      check("controller.source", "operator-check", "Exact BoxPilot source and install notes", `This kit records BoxPilot ${version}, but the running controller does not attest its Git commit or retain an independent source archive.`, "Keep the exact release archive, file manifest, Ubuntu bootstrap notes, systemd units, and Tailscale Serve command outside this server."),
      !applicationInventoryAvailable
        ? check("applications.backup", "unavailable", "Managed application recovery", "Application inventory is unavailable, so managed workload backup coverage cannot be evaluated.", "Restore application inventory and regenerate the kit.")
        : installedApplications.length === 0
        ? check("applications.backup", "not-applicable", "Managed application recovery", "No executable BoxPilot-managed application is currently detected.", "Re-run this kit after deploying an application.")
        : locallyUnverifiedApplications.length > 0
          ? check("applications.backup", "action-required", "Managed application recovery", `${locallyUnverifiedApplications.length} of ${installedApplications.length} installed managed application(s) lack latest local application-aware restore evidence.`, "Open Backups and complete the local application-aware backup and isolated no-network boot drill for each listed application.")
          : independentlyUnprotectedApplications.length === 0
            ? check("applications.backup", "verified", "Managed application recovery", `${installedApplications.length} managed application(s) have latest local no-network restore evidence plus encrypted independent snapshots with exact restored archive hashes.`, "Keep the application restic repository and its separate password in different failure domains. Repeat local backup and protection after material application changes.")
            : check("applications.backup", "action-required", "Managed application recovery", `${independentlyUnprotectedApplications.length} of ${installedApplications.length} installed managed application(s) have local restore evidence but lack encrypted independent exact-restore protection.`, "Open Backups and protect each latest verified application archive in the fixed application restic repository."),
      domainInventory.connected !== true
        ? check("virtualization.backup", "unavailable", "Virtual-machine recovery", "Libvirt domain inventory is unavailable, so VM coverage cannot be evaluated.", "Restore restricted-helper libvirt access and regenerate the kit.")
        : domains.length === 0
          ? check("virtualization.backup", "not-applicable", "Virtual-machine recovery", "No libvirt domains are currently detected.", "Re-run this kit after creating or importing a VM.")
          : unprotectedDomains.length === 0
            ? check("virtualization.backup", "verified", "Virtual-machine recovery", `${domains.length} VM(s) have retained encrypted independent backups with passing isolated restore drills.`, "Keep the restic repository and its password in separate failure domains and periodically repeat restore drills.")
            : check("virtualization.backup", "action-required", "Virtual-machine recovery", `${unprotectedDomains.length} of ${domains.length} VM(s) lack retained protected backup evidence.`, "Create a stopped export, encrypted independent restic copy, and isolated no-network restore drill for each uncovered VM."),
      routerCheckpoints.length > 0
        ? check("router.checkpoint", "verified", "Router configuration checkpoint", `${routerCheckpoints.length} browser-hashed router checkpoint record(s) exist; the actual files remain operator-held.`, "Confirm each original configuration file is readable on independent storage and export a new file after firmware or topology changes.")
        : check("router.checkpoint", "action-required", "Router configuration checkpoint", "No router backup identity is recorded.", "Export the active router configuration, keep it outside this server, and record its browser-computed SHA-256 in Router Checkpoints."),
      migrationTransfers.length === 0
        ? check("migration.source", "not-applicable", "Migration source preservation", "No verified migration transfer is recorded.", "Keep every source workload unchanged until a future destination activation is separately accepted.")
        : migrationTransfers.every((item) => item.contentVerified && item.sourcePreserved && !item.activationPerformed)
          ? check("migration.source", "verified", "Migration source preservation", `${migrationTransfers.length} staged transfer(s) retain verified content and source-preserved, non-activated evidence.`, "Keep source systems available until isolated destination health and rollback are proven.")
          : check("migration.source", "action-required", "Migration source preservation", "At least one migration record lacks full source-preservation or no-activation evidence.", "Stop and review the affected transfer before any destination activation."),
      directDnsEvidence
        ? secondDeviceEvidence
          ? check("dns.second-device", "verified", "Independent DNS proof", "Passing fixed DNS evidence exists from this server and a signed enrolled device.", "Repeat both proofs after any Pi-hole, router, DHCP, or topology change.")
          : check("dns.second-device", "action-required", "Independent DNS proof", "Server-side direct DNS evidence exists, but no passing signed second-device record exists.", "Run the fixed DNS task from an enrolled LAN device before considering any router advertisement change.")
        : check("dns.second-device", "not-applicable", "Independent DNS proof", "No passing server-side Pi-hole acceptance record exists.", "Keep current DNS unchanged. Complete deployment, backup, and direct server-side proof before second-device testing."),
      !prerequisiteInventoryAvailable
        ? check("host.prerequisites", "unavailable", "Host prerequisite review", "Prerequisite inventory is unavailable.", "Restore the read-only prerequisite collector and regenerate the kit before recovery work.")
        : nonReadyPrerequisites.length === 0
        ? check("host.prerequisites", "verified", "Host prerequisite review", `${prerequisiteInventory.checks.length} reported prerequisite checks are ready.`, "Re-run the inspection before a recovery or high-impact change.")
        : check("host.prerequisites", "operator-check", "Host prerequisite review", `${nonReadyPrerequisites.length} prerequisite check(s) need review; some checks are feature-specific rather than global failures.`, "Open Repair Center and resolve only the requirements for the recovery operation you intend to perform."),
    ];

    const summary = {
      status: checks.some((item) => ["action-required", "unavailable"].includes(item.state)) ? "action-required" : checks.some((item) => item.state === "operator-check") ? "operator-checks-required" : "verified",
      verified: checks.filter((item) => item.state === "verified").length,
      actionRequired: checks.filter((item) => ["action-required", "unavailable"].includes(item.state)).length,
      operatorChecks: checks.filter((item) => item.state === "operator-check").length,
      notApplicable: checks.filter((item) => item.state === "not-applicable").length,
      total: checks.length,
    };

    const kit = {
      schemaVersion: 1,
      generatedAt: now().toISOString(),
      product: { name: "BoxPilot", version },
      mode: "secret-free-readiness-and-runbook",
      summary,
      checks,
      recoveryOrder: [
        { order: 1, title: "Stabilize the host", instruction: "Use local console access, verify disks and filesystems, and do not change router or DNS settings while server health is uncertain." },
        { order: 2, title: "Restore private access", instruction: "Bring up Tailscale and BoxPilot on loopback with Funnel off; keep owner authentication enabled." },
        { order: 3, title: "Restore controller state", instruction: "Use the recorded controller restic repository and exact snapshot id to restore the complete backup directory. With BoxPilot stopped, recheck both hashes and SQLite integrity, restore the database with boxpilot ownership and mode 0600, then start and verify health." },
        { order: 4, title: "Inspect before mutation", instruction: "Run Repair Center and live inventory. Treat missing feature-specific prerequisites as scoped blockers, not permission for broad repair commands." },
        { order: 5, title: "Restore applications", instruction: "Use adapter-aware artifacts and isolated restore tests. Keep unclaimed services loopback-only and never copy a live SQLite database." },
        { order: 6, title: "Restore virtual machines", instruction: "Restore only exact protected restic snapshots into stopped no-network clones before deciding whether to attach networking." },
        { order: 7, title: "Re-establish DNS", instruction: "Keep the independent resolver active, then require direct server-side and signed second-device evidence before any router or client DNS change." },
        { order: 8, title: "Validate and record", instruction: "Verify application health, backup integrity, access boundaries, and rollback; generate a new kit and store it away from this server." },
      ],
      externalItems: [
        "Controller restic repository media and a separately stored repository password",
        "Application restic repository media and its separately stored application repository password",
        "Exact BoxPilot source archive and file manifest",
        "Router configuration files matching recorded hashes",
        "Restic repository password and recovery media stored separately from the repository",
        "Tailscale account recovery access and a local-console path",
        "Application credentials and encryption keys kept outside BoxPilot exports",
      ],
      evidence: {
        jobs: jobs.map((item) => ({ id: item.id, type: item.type, title: item.title, state: item.state, risk: item.risk, createdAt: item.createdAt })),
        controllerBackups: controllerBackups.map((item) => ({ id: item.id, destination: item.destination, checksumSha256: item.checksumSha256, sizeBytes: item.sizeBytes, downtimeMs: item.downtimeMs, restorePassed: item.restoreDrill?.passed === true, integrityCheck: item.restoreDrill?.integrityCheck ?? null, foreignKeyIssues: item.restoreDrill?.foreignKeyIssues ?? null, schemaVerified: item.restoreDrill?.schemaVerified === true, manifestChecksumSha256: item.restoreDrill?.manifestChecksumSha256 ?? null, createdAt: item.createdAt, verifiedAt: item.verifiedAt })),
        controllerProtections: controllerProtections.map((item) => ({ id: item.id, backupId: item.backupId, destination: item.destination, repositoryId: item.repositoryId, snapshotId: item.snapshotId, sizeBytes: item.sizeBytes, encrypted: item.encrypted, independent: item.independent, repositoryVerified: item.repositoryVerified, protected: item.protected, restorePassed: item.restoreDrill?.passed === true, restoreMode: item.restoreDrill?.mode ?? null, createdAt: item.createdAt })),
        controllerRetentionRuns: controllerRetentionRuns.map((item) => ({ id: item.id, repositoryId: item.repositoryId, beforeCount: item.beforeCount, afterCount: item.afterCount, forgottenCount: item.forgotten?.length ?? 0, repositoryVerified: item.repositoryVerified, complete: item.complete, prunePerformed: item.prunePerformed, createdAt: item.createdAt })),
        applications: applicationInventory.applications.map((item) => ({ id: item.id, name: item.name, execution: item.execution, installed: item.live?.installed === true, state: item.live?.state ?? "unknown", backupState: item.live?.backup?.state ?? null })),
        applicationBackups: applicationBackups.map((item) => ({ id: item.id, applicationId: item.applicationId, destination: item.destination, checksumSha256: item.checksumSha256, sizeBytes: item.sizeBytes, downtimeMs: item.downtimeMs, restorePassed: item.restoreDrill?.passed === true, createdAt: item.createdAt, verifiedAt: item.verifiedAt })),
        applicationProtections: applicationProtections.map((item) => ({ id: item.id, backupId: item.backupId, applicationId: item.applicationId, destination: item.destination, repositoryId: item.repositoryId, snapshotId: item.snapshotId, sizeBytes: item.sizeBytes, encrypted: item.encrypted, independent: item.independent, repositoryVerified: item.repositoryVerified, protected: item.protected, restorePassed: item.restoreDrill?.passed === true, restoreMode: item.restoreDrill?.mode ?? null, artifactChecksumMatched: item.restoreDrill?.artifactChecksumMatched === true, createdAt: item.createdAt })),
        applicationRetentionRuns: applicationRetentionRuns.map((item) => ({ id: item.id, repositoryId: item.repositoryId, beforeCount: item.beforeCount, afterCount: item.afterCount, forgottenCount: item.forgotten?.length ?? 0, repositoryVerified: item.repositoryVerified, complete: item.complete, prunePerformed: item.prunePerformed, createdAt: item.createdAt })),
        virtualMachines: { inventoryAvailable: domainInventory.connected === true, domains: domains.map((item) => ({ name: item.name, state: item.state, autostart: item.autostart === true })) },
        vmBackups: vmBackups.map((item) => ({ id: item.id, domainName: item.domainName, repositoryId: item.repositoryId, snapshotId: item.snapshotId, sizeBytes: item.sizeBytes, encrypted: item.encrypted, independent: item.independent, repositoryVerified: item.repositoryVerified, protected: item.protected, restorePassed: item.restoreDrill?.passed === true, retained: item.retained !== false, createdAt: item.createdAt })),
        routerCheckpoints: routerCheckpoints.map((item) => ({ id: item.id, modelId: item.modelId, firmwareVersion: item.firmwareVersion, checksumSha256: item.checksumSha256, sizeBytes: item.sizeBytes, fileRetainedByOperator: item.fileRetainedByOperator, createdAt: item.createdAt })),
        migrationTransfers: migrationTransfers.map((item) => ({ id: item.id, workloadName: item.workloadName, fileCount: item.fileCount, sizeBytes: item.sizeBytes, contentVerified: item.contentVerified, sourcePreserved: item.sourcePreserved, activationPerformed: item.activationPerformed, createdAt: item.createdAt })),
        fleet: { activeAgents: fleetAgents.filter((item) => item.status === "active").length, revokedAgents: fleetAgents.filter((item) => item.status === "revoked").length, passingEvidence: fleetEvidence.filter((item) => item.passed).length },
        dns: { passingControllerAcceptances: passingDirectDnsEvidence.length, passingLinkedSecondDeviceEvidence: passingLinkedSecondDeviceEvidence.length },
        prerequisites: prerequisiteInventory.checks.map((item) => ({ id: item.id, name: item.name, group: item.group, status: item.status, summary: item.summary, repair: item.repair ? { kind: item.repair.kind, description: item.repair.description } : null })),
      },
      boundary: {
        mutationsPerformed: false,
        databaseCopied: false,
        backupDataIncluded: false,
        configurationFilesIncluded: false,
        credentialsIncluded: false,
        excluded: ["owner names and password hashes", "sessions and CSRF tokens", "agent public keys and signatures", "backup artifact paths and application data", "router configuration bytes", "arbitrary logs and environment values"],
      },
    };
    return { ...kit, runbookMarkdown: renderRunbook(kit) };
  }

  return { inspect };
}

export const recoveryKitInternals = { latestBy, productVersion, renderRunbook };
