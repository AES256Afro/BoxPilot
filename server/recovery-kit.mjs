import { productVersion } from "./version.mjs";
import { shared } from "./cache.mjs";
import { cloudTarget, sealedFolder, sealedRemote } from "./backup-cloud.mjs";

function check(id, state, title, evidence, action) {
  return { id, state, title, evidence, action };
}

function settledValue(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

const KINDS = [["cloud", "cloud"], ["ssh", "another machine"], ["drive", "a backup drive"]];

/**
 * Whether a copy of the backups exists anywhere other than this server: the server's copy of
 * `offBoxVerdict` in src/offBox.ts, which the Backups page judges by. The browser does not import
 * server code, so the rule is written twice and src/offBox.test.ts runs every case through both.
 *
 * @param {{ cloud?: { configured: boolean, lastSyncAt: string | null, skipped?: number } | null, ssh?: { configured: boolean, lastSyncAt: string | null, skipped?: number } | null, drive?: { configured: boolean, lastSyncAt: string | null, skipped?: number } | null }} inputs
 * @param {{ now?: number, staleAfterDays?: number, newestLocalBackupAt?: string | null, behindSlackHours?: number }} [options]
 */
export function offBoxVerdict(inputs, { now = Date.now(), staleAfterDays = 7, newestLocalBackupAt = null, behindSlackHours = 12 } = {}) {
  /** @type {string[]} */
  const where = [];
  let newest = null;
  let skipped = 0;
  for (const [key, label] of KINDS) {
    const destination = inputs[key];
    if (!destination?.configured) continue;
    where.push(label);
    const at = destination.lastSyncAt ? Date.parse(destination.lastSyncAt) : Number.NaN;
    if (Number.isFinite(at) && (newest === null || at > newest)) { newest = at; skipped = destination.skipped ?? 0; }
  }
  const ageDays = newest === null ? null : Math.floor((now - newest) / 86_400_000);
  const localAt = newestLocalBackupAt ? Date.parse(newestLocalBackupAt) : Number.NaN;
  const behind = newest !== null && Number.isFinite(localAt) && localAt > newest && now - localAt > behindSlackHours * 3_600_000;
  const state = where.length === 0 ? "none"
    : newest === null ? "never"
    : behind ? "behind"
    : (ageDays ?? 0) > staleAfterDays ? "stale"
    : "ok";
  const behindHours = state === "behind" ? Math.floor((now - localAt) / 3_600_000) : null;
  return { configured: where.length > 0, lastSyncAt: newest === null ? null : new Date(newest).toISOString(), ageDays, where, state, behindHours, skipped };
}

/**
 * The rebuild checklist's word on the copy off this server. App backups read "verified" as soon as
 * each app had one archive, with every archive on the disk that would die (M91), so the copy is a
 * check of its own, built from what the Backups page judges by: no destination, or one that has
 * fallen behind, is action required.
 */
function offBoxCheck({ store, drive, driveRead, now }) {
  const cloud = store.getSetting("cloudDestination", null);
  const ssh = store.getSetting("backupDestination", null);
  const inputs = {
    cloud: { configured: Boolean(cloud), lastSyncAt: store.getSetting("cloudDestinationLastSync", null)?.completedAt ?? null },
    ssh: { configured: Boolean(ssh), lastSyncAt: store.getSetting("backupDestinationLastSync", null)?.completedAt ?? null },
    drive: { configured: drive?.sync?.mount?.mounted === true, lastSyncAt: drive?.sync?.lastSync?.completedAt ?? null, skipped: drive?.sync?.lastSync?.skippedCount ?? 0 },
  };
  const newestLocalBackupAt = store.listBackups(50).reduce((newest, backup) => (newest === null || backup.createdAt > newest ? backup.createdAt : newest), null);
  const verdict = offBoxVerdict(inputs, { now: now().getTime(), newestLocalBackupAt });
  const title = "A copy of the backups off this server";
  const where = verdict.where.join(", ");
  // "Only on this server" is a claim about all three destinations: with the drive unread and
  // nothing else set up, it is not known.
  if (verdict.state === "none" && !driveRead) return check("offbox.copy", "unavailable", title, "No cloud or SSH destination is saved, and the backup drive could not be read, so whether anything is copied off this server is unknown.", "Check that BoxPilot's admin service is running, then generate the kit again.");
  if (verdict.state === "none") return check("offbox.copy", "action-required", title, "Every backup is on this server only: no backup drive is mounted and no cloud or SSH destination is saved. A disk failure would take the backups with it.", "Open Backups, Off this server, and set up a backup drive, another machine over SSH or a cloud bucket; then schedule the nightly copy.");
  if (verdict.state === "never") return check("offbox.copy", "action-required", title, `A destination is set up (${where}) but nothing has been copied to it yet.`, "Open Backups, Off this server, and run a sync; then schedule the nightly copy.");
  if (verdict.state === "behind") return check("offbox.copy", "action-required", title, `Backups newer than the copy off this server have been waiting ${verdict.behindHours} hours; the sync that should have followed them has not run.`, "Open Backups, Off this server, and run a sync; check that the nightly copy is scheduled and not failing.");
  if (verdict.state === "stale") return check("offbox.copy", "action-required", title, `The newest copy off this server (${where}) is ${verdict.ageDays} days old.`, "Open Backups, Off this server, and run a sync; check that the nightly copy is scheduled and not failing.");
  if (verdict.skipped) return check("offbox.copy", "operator-check", title, `The last copy off this server left ${verdict.skipped} file(s) out.`, "Open Backups, Off this server, to see which files were left out and why.");
  return check("offbox.copy", "verified", title, `The backups were copied to ${where} on ${verdict.lastSyncAt}.`, "Keep the nightly copy scheduled, and keep the keys or passphrase it needs somewhere other than this server.");
}

/**
 * How to open the cloud copy with rclone alone, on any machine (M91). The mirror seals every file
 * through a crypt remote whose settings are not rclone's defaults (names left readable, no salt
 * password), and nothing wrote them down: an owner with the passphrase and the bucket keys still
 * could not read a byte without guessing them. The crypt lines are built from the same constants as
 * renderRcloneConfig in backup-cloud.mjs, and recovery-kit.test.mjs holds them to what it writes.
 * The bucket and folder are the saved destination's when there is one; never a key or the passphrase.
 */
function cloudCopyGuide(destination) {
  const saved = destination && typeof destination === "object" && typeof destination.provider === "string" ? destination : null;
  let plainRemote = "boxpilot:<bucket>/<folder>";
  if (saved) { try { plainRemote = cloudTarget(saved); } catch { /* a saved destination this version cannot read: keep the placeholder */ } }
  return {
    configured: Boolean(saved),
    provider: saved?.provider ?? null,
    config: [
      "[boxpilot]",
      `type = ${saved?.provider ?? "<provider: b2, s3, webdav, drive, onedrive or dropbox>"}`,
      "<the provider's account and keys, as `rclone config` asks for them>",
      "",
      `[${sealedRemote}]`,
      "type = crypt",
      `remote = ${plainRemote}/${sealedFolder}`,
      "filename_encryption = off",
      "directory_name_encryption = false",
      "password = <the output of: rclone obscure 'your passphrase'>",
    ],
    notes: [
      "Leave password2 out: the copies were sealed with no salt password.",
      "In the bucket each file's name ends in .bin; read through the crypt remote, it has its own name again.",
      `\`rclone lsf ${sealedRemote}:\` lists controller-backups/, application-backups/ and machine-snapshots/; \`rclone copy ${sealedRemote}:machine-snapshots /var/lib/boxpilot-managed/machine-snapshots\` fetches the snapshots into the folder a new server restores from (application-backups goes to /var/lib/boxpilot-managed/backups/catalog, controller-backups to /var/lib/boxpilot-managed/backups/boxpilot-controller).`,
    ],
  };
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
  lines.push("", "## Opening the cloud copy without BoxPilot", "", kit.cloudCopy.configured ? `This server mirrors to ${kit.cloudCopy.provider}. With its keys and your passphrase, any machine with rclone can read the copies through this configuration:` : "No cloud destination is saved. If you set one up, any machine with rclone can read its copies, with the provider's keys and your passphrase, through this configuration:", "", "```ini", ...kit.cloudCopy.config, "```", "");
  for (const note of kit.cloudCopy.notes) lines.push(`- ${note}`);
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
/** @param {{ store?: any, prerequisites?: any, helper?: any, libvirt?: any, now?: () => Date, version?: string }} [options] */
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
    const [prerequisiteResult, applicationResult, domainResult, driveResult] = await Promise.allSettled([
      prerequisites.inspect(),
      catalogInventory(),
      libvirt.listDomains(),
      helper.request("host.snapshot.inspect", {}, { timeoutMs: 60_000 }),
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
        ? check("applications.backup", "unavailable", "Catalog application backups", "Catalog application inventory is unavailable, so backup coverage cannot be evaluated.", "Check that BoxPilot's admin service is running, then generate the kit again.")
        : installedApplications.length === 0
        ? check("applications.backup", "not-applicable", "Catalog application backups", "No catalog application is currently installed.", "Re-run this kit after installing an application.")
        : !backupCountsKnown
        ? check("applications.backup", "unavailable", "Catalog application backups", "The application backup folder could not be read, so how many backups each app has is unknown.", "Check that BoxPilot's admin service is running, then generate the kit again.")
        : unbackedApplications.length > 0
          ? check("applications.backup", "action-required", "Catalog application backups", `${unbackedApplications.length} of ${installedApplications.length} installed application(s) have no recorded backup: ${unbackedApplications.map((item) => item.id).join(", ")}.`, "Back up each listed application from its catalog card, or schedule recurring backups on the System page.")
          : check("applications.backup", "verified", "Catalog application backups", `All ${installedApplications.length} installed application(s) have at least one recorded checksummed backup archive. Folders you pointed an app at yourself are not inside those archives.`, "Copy the application backup directory to independent storage, keep backup schedules enabled, and make sure any media or photo folders you chose are backed up too."),
      offBoxCheck({ store, drive: settledValue(driveResult, null), driveRead: driveResult.status === "fulfilled", now }),
      domainInventory.connected !== true
        ? check("virtualization.backup", "unavailable", "Virtual-machine recovery", "Libvirt domain inventory is unavailable, so VM coverage cannot be evaluated.", "Check that BoxPilot's admin service can reach libvirt, then generate the kit again.")
        : domains.length === 0
          ? check("virtualization.backup", "not-applicable", "Virtual-machine recovery", "No libvirt domains are currently detected.", "Re-run this kit after creating or importing a VM.")
          : unprotectedDomains.length === 0
            ? check("virtualization.backup", "verified", "Virtual-machine recovery", `${domains.length} VM(s) have retained encrypted independent backups with passing isolated restore drills.`, "Keep the restic repository and its password in separate failure domains and periodically repeat restore drills.")
            : check("virtualization.backup", "action-required", "Virtual-machine recovery", `${unprotectedDomains.length} of ${domains.length} VM(s) lack retained protected backup evidence.`, "Create a stopped export, encrypted independent restic copy, and isolated no-network restore drill for each uncovered VM."),
      !prerequisiteInventoryAvailable
        ? check("host.prerequisites", "unavailable", "Host prerequisite review", "Prerequisite inventory is unavailable.", "Restore the read-only prerequisite collector and regenerate the kit before recovery work.")
        : nonReadyPrerequisites.length === 0
        ? check("host.prerequisites", "verified", "Host prerequisite review", `${prerequisiteInventory.checks.length} reported prerequisite checks are ready.`, "Re-run the inspection before a recovery or high-impact change.")
        : check("host.prerequisites", "operator-check", "Host prerequisite review", `${nonReadyPrerequisites.length} prerequisite check(s) need review; some checks are feature-specific rather than global failures.`, "Open Repair and resolve only the requirements for the recovery operation you intend to perform."),
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
        { order: 3, title: "Bring the backups back", instruction: "Plug in the backup drive and mount it on the Storage page; Backups, Restore then finds the snapshots on it. With no drive, copy the backups back from the other machine over SSH, or from the cloud with rclone (see Opening the cloud copy without BoxPilot), into the same folders on this server." },
        { order: 4, title: "Restore the machine snapshot", instruction: "Backups, Restore: pick the newest snapshot. It reinstalls your apps with the settings and secrets they had and restores each app's data from its newest verified backup on this server or the backup drive (or beside the snapshot), even one taken after the snapshot, falling back to the archive the snapshot lists when none checks out; the restore says which newer backups it passed over and why. Untick Use each app's newest backup on the Restore tab to use only the snapshot's own. Network, firewall, fstab, VM definitions and BoxPilot's database copy are unpacked beside the snapshot for you to look at and apply yourself." },
        { order: 5, title: "Put BoxPilot's database back", instruction: "Backups, This server, Restore the database copy: choose the copy the snapshot restore staged, or a newer verified database backup from the drive. BoxPilot then knows your accounts, schedules, destinations and history again; sign in with the password you had then. By hand instead: stop boxpilot; check that the SHA-256 of the staged boxpilot.sqlite3 (under /var/lib/boxpilot-managed/machine-snapshots/restored/<time>/controller/) matches the checksumSha256 in the manifest.json beside it; copy it over /var/lib/boxpilot/boxpilot.sqlite3 as boxpilot:boxpilot mode 0600; delete the -wal and -shm files beside it; start boxpilot." },
        { order: 6, title: "Check each app's data", instruction: "Open each app and check its data is there and how recent it is. If the restore passed over a newer backup you want (one an earlier BoxPilot wrote, say), restore it from the app's Backups tab in Apps." },
        { order: 7, title: "Restore virtual machines", instruction: "Restore protected snapshots into stopped clones with no network, and decide about networking once you have looked inside." },
        { order: 8, title: "Check it, then make a new kit", instruction: "Confirm the apps are healthy and the backups are running again, then download a fresh recovery kit and keep it somewhere other than this server." },
      ],
      cloudCopy: cloudCopyGuide(store.getSetting("cloudDestination", null)),
      externalItems: [
        "Controller restic repository media and a separately stored repository password",
        "The cloud copy's encryption passphrase, and the provider's keys: without the passphrase nobody, you included, can read the cloud copy",
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

