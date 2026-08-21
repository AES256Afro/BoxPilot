import { productVersion } from "./version.mjs";

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
  lines.push("", "## Evidence inventory", "", `Recent jobs: ${kit.evidence.jobs.length}`, `Controller backups: ${kit.evidence.controllerBackups.length}`, `Protected controller snapshots: ${kit.evidence.controllerProtections.length}`, `Controller retention runs: ${kit.evidence.controllerRetentionRuns.length}`, `Installed catalog applications: ${kit.evidence.applications.filter((item) => item.installed).length}`, `Retained VM backups: ${kit.evidence.vmBackups.length}`, "", "## External items BoxPilot cannot prove", "");
  for (const item of kit.externalItems) lines.push(`- ${item}`);
  lines.push("", "## Export boundary", "");
  for (const item of kit.boundary.excluded) lines.push(`- Excluded: ${item}`);
  lines.push("");
  return lines.join("\n");
}

export function createRecoveryKitService({ store, prerequisites, helper, libvirt, now = () => new Date(), version = productVersion } = {}) {
  async function catalogInventory() {
    const live = await helper.request("app.inspect", {}, { timeoutMs: 30_000 });
    const installed = (live.applications ?? []).filter((item) => item.installed === true);
    const withBackups = await Promise.all(installed.map(async (item) => {
      const backups = await helper.request("app.backups.inspect", { id: item.id }, { timeoutMs: 30_000 }).then((result) => result.backups ?? []).catch(() => []);
      return { ...item, backups };
    }));
    return withBackups;
  }

  async function inspect() {
    const [prerequisiteResult, applicationResult, domainResult] = await Promise.allSettled([
      prerequisites.inspect(),
      catalogInventory(),
      libvirt.listDomains(),
    ]);
    const prerequisiteInventory = settledValue(prerequisiteResult, { checks: [] });
    const installedApplications = settledValue(applicationResult, []);
    const domainInventory = settledValue(domainResult, { connected: false, domains: [] });
    const prerequisiteInventoryAvailable = prerequisiteResult.status === "fulfilled";
    const applicationInventoryAvailable = applicationResult.status === "fulfilled";
    const jobs = store.listJobs(100);
    const controllerBackups = store.listBackups(200).filter((item) => item.applicationId === "boxpilot-controller");
    const controllerProtections = store.listControllerBackupProtections(200).filter((item) => item.protected && item.encrypted && item.independent && item.repositoryVerified && item.restoreDrill?.passed);
    const controllerRetentionRuns = store.listControllerRetentionRuns?.(200) ?? [];
    const protectedControllerBackup = controllerBackups.find((backup) => controllerProtections.some((protection) => protection.backupId === backup.id)) ?? null;
    const vmBackups = store.listVmBackups(200).filter((item) => item.retained !== false);

    const unbackedApplications = installedApplications.filter((item) => item.backups.length === 0);
    const domains = domainInventory.connected === true ? domainInventory.domains : [];
    const protectedDomainNames = new Set(vmBackups.filter((item) => item.protected && item.encrypted && item.independent && item.repositoryVerified && item.restoreDrill?.passed).map((item) => item.domainName));
    const unprotectedDomains = domains.filter((item) => !protectedDomainNames.has(item.name));
    const nonReadyPrerequisites = prerequisiteInventory.checks.filter((item) => item.status !== "ready");

    const checks = [
      protectedControllerBackup
        ? check("controller.database", "verified", "Independent BoxPilot database recovery", `Controller backup ${protectedControllerBackup.id} has an encrypted independent restic snapshot, a complete repository read, and an exact isolated database restore drill.`, "Keep the repository and its separate recovery password in different failure domains. Repeat protection after material controller-state changes.")
        : controllerBackups[0]?.restoreDrill?.passed === true
        ? check("controller.database", "operator-check", "Independent BoxPilot database copy", `A WAL-aware local controller snapshot passed its isolated copy-open drill at ${controllerBackups[0].verifiedAt}, but it remains on this server.`, "Open Backups and protect the snapshot into the encrypted independent restic repository, then keep the repository password in a separate failure domain.")
        : check("controller.database", "action-required", "Verified BoxPilot database snapshot", "No WAL-aware local controller snapshot with passing isolated copy-open evidence is recorded.", "Open Backups and click Back up now; then protect the verified snapshot independently."),
      check("controller.source", "operator-check", "Exact BoxPilot source and install notes", `This kit records BoxPilot ${version}, but the running controller does not attest its Git commit or retain an independent source archive.`, "Keep the exact release archive, Ubuntu bootstrap notes, systemd units, and Tailscale Serve command outside this server."),
      !applicationInventoryAvailable
        ? check("applications.backup", "unavailable", "Catalog application backups", "Catalog application inventory is unavailable, so backup coverage cannot be evaluated.", "Restore the helper connection and regenerate the kit.")
        : installedApplications.length === 0
        ? check("applications.backup", "not-applicable", "Catalog application backups", "No catalog application is currently installed.", "Re-run this kit after installing an application.")
        : unbackedApplications.length > 0
          ? check("applications.backup", "action-required", "Catalog application backups", `${unbackedApplications.length} of ${installedApplications.length} installed application(s) have no recorded backup: ${unbackedApplications.map((item) => item.id).join(", ")}.`, "Back up each listed application from its catalog card, or schedule recurring backups on the System page.")
          : check("applications.backup", "verified", "Catalog application backups", `All ${installedApplications.length} installed application(s) have at least one recorded checksummed backup archive.`, "Copy the application backup directory to independent storage and keep backup schedules enabled."),
      domainInventory.connected !== true
        ? check("virtualization.backup", "unavailable", "Virtual-machine recovery", "Libvirt domain inventory is unavailable, so VM coverage cannot be evaluated.", "Restore restricted-helper libvirt access and regenerate the kit.")
        : domains.length === 0
          ? check("virtualization.backup", "not-applicable", "Virtual-machine recovery", "No libvirt domains are currently detected.", "Re-run this kit after creating or importing a VM.")
          : unprotectedDomains.length === 0
            ? check("virtualization.backup", "verified", "Virtual-machine recovery", `${domains.length} VM(s) have retained encrypted independent backups with passing isolated restore drills.`, "Keep the restic repository and its password in separate failure domains and periodically repeat restore drills.")
            : check("virtualization.backup", "action-required", "Virtual-machine recovery", `${unprotectedDomains.length} of ${domains.length} VM(s) lack retained protected backup evidence.`, "Create a stopped export, encrypted independent restic copy, and isolated no-network restore drill for each uncovered VM."),
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
      schemaVersion: 2,
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
        { order: 5, title: "Restore applications", instruction: "Reinstall each catalog application, then restore its data from the newest checksummed backup archive. Keep unclaimed services loopback-only and never copy a live SQLite database." },
        { order: 6, title: "Restore virtual machines", instruction: "Restore only exact protected restic snapshots into stopped no-network clones before deciding whether to attach networking." },
        { order: 7, title: "Validate and record", instruction: "Verify application health, backup integrity, access boundaries, and rollback; generate a new kit and store it away from this server." },
      ],
      externalItems: [
        "Controller restic repository media and a separately stored repository password",
        "A copy of the application backup directory on independent storage",
        "Exact BoxPilot source archive and install notes",
        "Tailscale account recovery access and a local-console path",
        "Application credentials and encryption keys kept outside BoxPilot exports",
      ],
      evidence: {
        jobs: jobs.map((item) => ({ id: item.id, type: item.type, title: item.title, state: item.state, risk: item.risk, createdAt: item.createdAt })),
        controllerBackups: controllerBackups.map((item) => ({ id: item.id, destination: item.destination, checksumSha256: item.checksumSha256, sizeBytes: item.sizeBytes, downtimeMs: item.downtimeMs, restorePassed: item.restoreDrill?.passed === true, integrityCheck: item.restoreDrill?.integrityCheck ?? null, foreignKeyIssues: item.restoreDrill?.foreignKeyIssues ?? null, schemaVerified: item.restoreDrill?.schemaVerified === true, manifestChecksumSha256: item.restoreDrill?.manifestChecksumSha256 ?? null, createdAt: item.createdAt, verifiedAt: item.verifiedAt })),
        controllerProtections: controllerProtections.map((item) => ({ id: item.id, backupId: item.backupId, destination: item.destination, repositoryId: item.repositoryId, snapshotId: item.snapshotId, sizeBytes: item.sizeBytes, encrypted: item.encrypted, independent: item.independent, repositoryVerified: item.repositoryVerified, protected: item.protected, restorePassed: item.restoreDrill?.passed === true, restoreMode: item.restoreDrill?.mode ?? null, createdAt: item.createdAt })),
        controllerRetentionRuns: controllerRetentionRuns.map((item) => ({ id: item.id, repositoryId: item.repositoryId, beforeCount: item.beforeCount, afterCount: item.afterCount, forgottenCount: item.forgotten?.length ?? 0, repositoryVerified: item.repositoryVerified, complete: item.complete, prunePerformed: item.prunePerformed, createdAt: item.createdAt })),
        applications: installedApplications.map((item) => ({ id: item.id, installed: true, container: item.container?.state ?? "unknown", backups: item.backups.map((backup) => ({ artifact: backup.artifact, sizeBytes: backup.sizeBytes, checksumSha256: backup.checksumSha256, createdAt: backup.createdAt })) })),
        virtualMachines: { inventoryAvailable: domainInventory.connected === true, domains: domains.map((item) => ({ name: item.name, state: item.state, autostart: item.autostart === true })) },
        vmBackups: vmBackups.map((item) => ({ id: item.id, domainName: item.domainName, repositoryId: item.repositoryId, snapshotId: item.snapshotId, sizeBytes: item.sizeBytes, encrypted: item.encrypted, independent: item.independent, repositoryVerified: item.repositoryVerified, protected: item.protected, restorePassed: item.restoreDrill?.passed === true, retained: item.retained !== false, createdAt: item.createdAt })),
        prerequisites: prerequisiteInventory.checks.map((item) => ({ id: item.id, name: item.name, group: item.group, status: item.status, summary: item.summary, repair: item.repair ? { kind: item.repair.kind, description: item.repair.description } : null })),
      },
      boundary: {
        mutationsPerformed: false,
        databaseCopied: false,
        backupDataIncluded: false,
        configurationFilesIncluded: false,
        credentialsIncluded: false,
        excluded: ["owner names and password hashes", "sessions and CSRF tokens", "backup artifact paths and application data", "arbitrary logs and environment values"],
      },
    };
    return { ...kit, runbookMarkdown: renderRunbook(kit) };
  }

  return { inspect };
}

export const recoveryKitInternals = { productVersion, renderRunbook };
