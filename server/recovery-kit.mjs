import { productVersion } from "./version.mjs";
import { shared } from "./cache.mjs";

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

/**
 * The Repair page asks two routes for this at once - the recovery kit itself and the action centre
 * derived from it - so without sharing, one page load ran the VM inventory and walked the backup
 * root twice. Concurrent callers share one read; nothing is held afterwards.
 */
export function createRecoveryKitService({ store, prerequisites, helper, libvirt, now = () => new Date(), version = productVersion } = {}) {
  async function catalogInventory() {
    // Two reads for the whole catalog, not one per installed app: the kit only asks whether each
    // app has any backup at all.
    const [live, counted] = await Promise.all([
      helper.request("app.inspect", {}, { timeoutMs: 30_000 }),
      helper.request("app.backups.counts", {}, { timeoutMs: 30_000 }).catch(() => ({ available: false, counts: {} })),
    ]);
    const installed = (live.applications ?? []).filter((item) => item.installed === true);
    // A count that could not be taken is not a count of zero; the check reports unavailable.
    const known = counted.available !== false;
    return installed.map((item) => ({ ...item, backupCount: known ? counted.counts?.[item.id] ?? 0 : null }));
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

    const backupCountsKnown = installedApplications.every((item) => item.backupCount !== null);
    const unbackedApplications = installedApplications.filter((item) => item.backupCount === 0);
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
      // Informational, not an action: nothing the owner does on this server can clear it, and
      // treating it as outstanding meant the Action Center could never report a quiet box.
      check("controller.source", "informational", "Exact BoxPilot source and install notes", `This kit records BoxPilot ${version}. Rebuilding needs the release itself, which lives on GitHub rather than on this server.`, "Keep the release tag, your Ubuntu install notes and the Tailscale command with your other recovery material."),
      !applicationInventoryAvailable
        ? check("applications.backup", "unavailable", "Catalog application backups", "Catalog application inventory is unavailable, so backup coverage cannot be evaluated.", "Restore the helper connection and regenerate the kit.")
        : installedApplications.length === 0
        ? check("applications.backup", "not-applicable", "Catalog application backups", "No catalog application is currently installed.", "Re-run this kit after installing an application.")
        : !backupCountsKnown
        ? check("applications.backup", "unavailable", "Catalog application backups", "The application backup folder could not be read, so how many backups each app has is unknown.", "Check that the BoxPilot helper is running, then generate the kit again.")
        : unbackedApplications.length > 0
          ? check("applications.backup", "action-required", "Catalog application backups", `${unbackedApplications.length} of ${installedApplications.length} installed application(s) have no recorded backup: ${unbackedApplications.map((item) => item.id).join(", ")}.`, "Back up each listed application from its catalog card, or schedule recurring backups on the System page.")
          : check("applications.backup", "verified", "Catalog application backups", `All ${installedApplications.length} installed application(s) have at least one recorded checksummed backup archive. Folders you pointed an app at yourself are not inside those archives.`, "Copy the application backup directory to independent storage, keep backup schedules enabled, and make sure any media or photo folders you chose are backed up too."),
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
      // The order the owner actually follows, and the one docs/RECOVERY.md prints. It includes the
      // machine snapshot, which is how apps and their settings come back, and is written for
      // somebody rebuilding a server rather than as a statement of what BoxPilot will not do.
      recoveryOrder: [
        { order: 1, title: "Get the server back", instruction: "Install Ubuntu Server, then install BoxPilot at the release this kit names. Use a keyboard and monitor, or another machine on the LAN; do not change your router or DNS while you are still finding your feet." },
        { order: 2, title: "Get back in privately", instruction: "Bring up Tailscale and sign in to BoxPilot. Keep it on the tailnet rather than opening anything on your router." },
        { order: 3, title: "Restore BoxPilot's own database", instruction: "Restore the recorded controller snapshot from the encrypted repository. You will need the repository password you kept elsewhere. BoxPilot then knows your accounts, settings and history again." },
        { order: 4, title: "Restore the machine snapshot", instruction: "This reinstalls your apps with the settings and secrets they had. Network, firewall, fstab and VM definitions are unpacked beside the snapshot for you to look at and apply yourself." },
        { order: 5, title: "Restore each app's data", instruction: "Restore every app from its newest backup archive, which is checked against its recorded checksum before anything is replaced." },
        { order: 6, title: "Restore virtual machines", instruction: "Restore protected snapshots into stopped clones with no network, and decide about networking once you have looked inside." },
        { order: 7, title: "Check it, then make a new kit", instruction: "Confirm the apps are healthy and the backups are running again, then download a fresh recovery kit and keep it somewhere other than this server." },
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
        // How many backups each app has, not every artifact: the kit is a readiness report, and
        // listing every archive of every app made it grow without telling the reader anything more.
        applications: installedApplications.map((item) => ({ id: item.id, installed: true, container: item.container?.state ?? "unknown", backupCount: item.backupCount ?? 0 })),
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

  return { inspect: shared(inspect) };
}

export const recoveryKitInternals = { productVersion, renderRunbook };
