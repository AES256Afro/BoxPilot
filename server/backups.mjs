import { randomUUID } from "node:crypto";
import http from "node:http";

async function defaultKeelHealthInspector() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port: 3000, path: "/api/health", timeout: 2500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 8192) request.destroy(); });
      response.on("end", () => {
        try { const value = JSON.parse(body); resolve(response.statusCode === 200 && value?.app === "keel" && value?.ok === true); } catch { resolve(false); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

export function createBackupService({ store, prerequisites, helper, inspectKeelHealth = defaultKeelHealthInspector }) {
  const adapters = {
    "boxpilot-controller": { name: "BoxPilot controller", sourceKind: "controller-state", inspectOperation: "controller.database.backup.inspect", jobType: "controller.database.backup", requiredChecks: ["storage.state", "helper.boundary"] },
    "uptime-kuma": { name: "Uptime Kuma", sourceKind: "application-state", inspectOperation: "application.uptime-kuma.inspect", jobType: "application.uptime-kuma.backup", requiredChecks: ["storage.state", "helper.boundary", "containers.docker"] },
    "pi-hole": { name: "Pi-hole", sourceKind: "application-state", inspectOperation: "application.pi-hole.inspect", jobType: "application.pi-hole.backup", requiredChecks: ["storage.state", "helper.boundary", "containers.docker"] },
    "keel": { name: "Keel Notes", sourceKind: "application-state", inspectOperation: "application.keel.install.inspect", jobType: "application.keel.backup", requiredChecks: ["storage.state", "helper.boundary", "runtime.node"] },
  };

  async function inspectSource(applicationId) {
    try {
      const source = await helper.request(adapters[applicationId].inspectOperation, {});
      if (applicationId === "keel" && source.installed) {
        const healthy = await inspectKeelHealth();
        return { ...source, healthy, state: healthy ? "installed" : "degraded", detail: healthy ? "The exact managed Keel service is healthy on loopback and ready for a consistent export" : "The managed Keel service exists but its loopback health identity is unavailable" };
      }
      return source;
    } catch {
      return { installed: false, healthy: false, state: "unavailable", detail: `${adapters[applicationId].name} backup inventory is unavailable` };
    }
  }

  async function list() {
    const backups = store.listBackups();
    const controllerProtections = store.listControllerBackupProtections();
    const applicationProtections = store.listApplicationBackupProtections();
    const coverage = await Promise.all(Object.entries(adapters).map(async ([applicationId, adapter]) => {
      const source = await inspectSource(applicationId);
      const latest = backups.find((backup) => backup.applicationId === applicationId) ?? null;
      const latestProtection = latest ? (applicationId === "boxpilot-controller"
        ? controllerProtections.find((protection) => protection.backupId === latest.id) ?? null
        : applicationProtections.find((protection) => protection.backupId === latest.id) ?? null) : null;
      const state = !source.installed ? "not-installed" : latestProtection?.protected ? "protected" : latest?.restoreDrill?.passed ? "locally-verified" : "unprotected";
      return {
        applicationId,
        name: adapter.name,
        sourceKind: adapter.sourceKind,
        source,
        state,
        protected: state === "protected",
        latestBackup: latest,
        latestProtection,
        requirement: applicationId === "boxpilot-controller"
          ? "A WAL-aware SQLite snapshot plus an isolated copy-open integrity and schema drill"
          : "A successful local artifact plus an isolated no-network restore drill",
      };
    }));
    return {
      coverage,
      backups,
      limitations: ["Local restore verification is not disaster protection. Controller and application backups use separate encrypted restic repositories and separate recovery keys on an independently mounted filesystem."],
    };
  }

  async function plan(applicationId, ownerId) {
    const adapter = adapters[applicationId];
    if (!adapter) throw new Error("Backup adapter not found");
    const source = await inspectSource(applicationId);
    const inventory = await prerequisites.inspect();
    const required = new Set(adapter.requiredChecks);
    const blockers = inventory.checks.filter((item) => required.has(item.id) && item.status !== "ready")
      .map((item) => ({ id: item.id, summary: item.summary, repair: item.repair }));
    if (!source.installed) blockers.push({ id: applicationId === "boxpilot-controller" ? "controller.database" : `application.${applicationId}`, summary: applicationId === "boxpilot-controller" ? "Controller database backup inspection is unavailable" : `${adapter.name} is not installed`, repair: { kind: "guided", description: applicationId === "boxpilot-controller" ? "Restore the restricted helper and fixed controller state path" : `Deploy the curated ${adapter.name} adapter first` } });
    else if (!source.healthy) blockers.push({ id: applicationId === "boxpilot-controller" ? "controller.database.health" : `application.${applicationId}.health`, summary: `${adapter.name} is not healthy`, repair: { kind: "manual", description: applicationId === "boxpilot-controller" ? "Resolve database integrity, foreign-key, schema, or owner-state evidence before creating a snapshot" : "Restore application health before creating a backup" } });

    const controller = applicationId === "boxpilot-controller";
    const keel = applicationId === "keel";
    const output = {
      applicationId,
      destination: "local-managed",
      executable: blockers.length === 0,
      blockers,
      changes: controller ? [
        "Read the fixed live BoxPilot SQLite database through the restricted helper without returning database content",
        "Create one transactionally consistent WAL-aware snapshot with SQLite VACUUM INTO in a generated root-only directory",
        "Compute the artifact SHA-256 and verify integrity, foreign keys, required schema, and owner-state presence",
        "Copy the artifact into one generated isolated restore workspace and verify the exact checksum, integrity, foreign keys, and schema again",
        "Write a root-only recovery manifest and remove only the generated restore copy after verification",
        "Keep the live database and BoxPilot service unchanged throughout the operation",
      ] : keel ? [
        "Reverify the exact managed Keel 1.2.6 installation, dedicated account, active unit, private state, and loopback health identity",
        "Stop only keel.service cleanly and run the fixed upstream export as the non-login keel account",
        "Include the consistent SQLite database, WAL companions when present, managed-secret companion when present, uploads, and the fixed environment without returning their contents",
        "Harden the generated tree to root-only ownership, create one immutable compressed artifact, and record complete SHA-256 and manifest evidence",
        "Restart keel.service and require the exact loopback health identity before the isolated restore drill",
        "Extract only into a generated no-network workspace, reject links and changed membership, open the restored SQLite copy, and verify integrity, foreign keys, schema, manifest, and complete tree digest",
        "Remove the successful drill workspace while keeping the production database, claim, registration, listener, Tailscale, firewall, DNS, DHCP, and router unchanged",
      ] : [
        `Stop ${adapter.name} cleanly so its application state is consistent`,
        "Create a compressed archive in the confined BoxPilot-managed backup directory",
        "Restart the source container and require its Docker health check to pass",
        "Compute and record a SHA-256 checksum for the completed artifact",
        "Restore into a temporary container with no network and no published ports",
        "Delete only the temporary restore workspace after evidence is recorded",
      ],
      warnings: controller ? [
        "This artifact contains password hashes, sessions, agent identities, plans, jobs, and audit state. Keep the root-only mode and treat any copied file as sensitive.",
        "The verified destination remains on Bigbox. Copy the complete backup directory and manifest to encrypted independent storage before treating it as disaster protection.",
        "The isolated drill proves database open, checksum, integrity, foreign keys, and schema. It does not start a second BoxPilot service or test owner login.",
      ] : keel ? [
        "Keel has brief measured downtime while the upstream export reads a stopped database. The source is restarted before the restore drill begins.",
        "The artifact can contain notes, users, sessions, encrypted credentials, the managed-secret companion, uploads, and private configuration. It remains root-only and must be treated as sensitive.",
        "The isolated drill opens only the restored SQLite copy and starts no application process. A local artifact is not protection from failure of Bigbox itself until its separate encrypted restic copy also passes an exact restore.",
      ] : [
        "The source will have brief measured downtime while its consistent archive is created.",
        "A local-only artifact is verified recovery evidence, but it is not yet protection from failure of Bigbox itself.",
      ],
      recovery: controller
        ? "If snapshot or drill verification fails, the helper removes only the newly generated backup and drill paths. The production database is never replaced, stopped, checkpointed, truncated, or modified."
        : keel
          ? "If the Keel Notes export or drill verification fails, the static backup unit and helper request keel.service restart. Only the generated partial, drill, and unrecorded artifact paths may be removed. The production database, managed-secret key, uploads, environment, claim, and registration state are never replaced."
        : `If the archive step fails, BoxPilot restarts ${adapter.name} and verifies source health. It never deletes an existing backup artifact.${applicationId === "pi-hole" ? " Router and client DNS are never changed by this workflow." : ""}`,
    };
    return store.createPlan({ type: "application.backup", subjectId: applicationId, input: { destination: "local-managed" }, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "application.backup") throw new Error("Backup plan not found");
    if (plan.revision !== revision) throw new Error("Backup plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("Backup plan has unresolved blockers");
    const adapter = adapters[plan.subjectId];
    if (!adapter) throw new Error("Backup adapter not found");
    const source = await inspectSource(plan.subjectId);
    if (!source.installed || !source.healthy) throw new Error(`Host state changed: ${adapter.name} is not installed and healthy`);
    store.stagePlan(plan.id, ownerId);
    const backupId = randomUUID();
    return store.createJob({
      type: adapter.jobType,
      title: `Back up and restore-test ${adapter.name}`,
      risk: plan.subjectId === "pi-hole" ? "network-critical" : "medium",
      parameters: { planId: plan.id, revision: plan.revision, backupId, applicationId: plan.subjectId },
      recovery: {
        automaticRollback: true,
        reason: plan.subjectId === "boxpilot-controller" ? "Only the new helper-owned artifact and restore workspace can be removed; the live database is never changed." : plan.subjectId === "keel" ? "The static backup unit and helper recovery request the fixed source service restart and remove only generated unrecorded paths." : "The source container is restarted and health checked even when archive creation fails.",
        manual: plan.subjectId === "boxpilot-controller" ? "Keep BoxPilot running. Inspect helper logs and storage, then create a new immutable plan; never copy only the live SQLite main file while WAL mode is active." : plan.subjectId === "keel" ? "If source restart verification fails, run sudo systemctl start keel.service, confirm curl http://127.0.0.1:3000/api/health, and preserve all of /var/lib/keel before another backup." : plan.subjectId === "pi-hole" ? "If source restart verification fails, keep router and client DNS on the independent resolver, run docker start boxpilot-pi-hole, and inspect health before another backup." : "If source restart verification fails, run docker start boxpilot-uptime-kuma and inspect its health before attempting another backup.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: plan.subjectId === "boxpilot-controller" ? "Live database health, helper, storage, and fixed root-only destination validated" : "Source health, helper, Docker, storage, and fixed destination validated" },
        { name: "checkpoint", state: "completed", detail: plan.subjectId === "boxpilot-controller" ? "Existing artifacts remain immutable and the production database no-change boundary is recorded" : "Existing backup artifacts are immutable and the source restart path is recorded" },
      ],
    });
  }

  async function validateJob(job) {
    if (!["controller.database.backup", "application.uptime-kuma.backup", "application.pi-hole.backup", "application.keel.backup"].includes(job.type)) throw new Error("Unsupported backup job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.revision !== job.parameters.revision) throw new Error("The staged backup plan is unavailable or changed");
    const expectedApplicationId = job.type === "controller.database.backup" ? "boxpilot-controller" : job.type === "application.pi-hole.backup" ? "pi-hole" : job.type === "application.keel.backup" ? "keel" : "uptime-kuma";
    if (plan.subjectId !== expectedApplicationId || job.parameters.applicationId !== expectedApplicationId) throw new Error("The staged backup plan does not match the requested adapter");
    const source = await inspectSource(expectedApplicationId);
    if (!source.installed || !source.healthy) throw new Error(`Host state changed: ${adapters[expectedApplicationId].name} is not installed and healthy`);
    return plan;
  }

  function recordResult(job, result) {
    const expectedApplicationId = job.type === "controller.database.backup" ? "boxpilot-controller" : job.type === "application.pi-hole.backup" ? "pi-hole" : job.type === "application.keel.backup" ? "keel" : "uptime-kuma";
    const expectedSuffix = expectedApplicationId === "boxpilot-controller" ? `/backups/boxpilot-controller/${job.parameters.backupId}/boxpilot.sqlite3` : `/backups/${expectedApplicationId}/${job.parameters.backupId}.tar.gz`;
    if (
      result.backupId !== job.parameters.backupId
      || result.applicationId !== expectedApplicationId
      || result.destination !== "local-managed"
      || typeof result.artifactPath !== "string"
      || !result.artifactPath.endsWith(expectedSuffix)
      || !/^[a-f0-9]{64}$/.test(result.checksumSha256)
      || !Number.isInteger(result.sizeBytes) || result.sizeBytes < 1
      || !Number.isInteger(result.downtimeMs) || result.downtimeMs < 0
      || !result.restoreDrill?.passed
      || result.restoreDrill.network !== "none"
      || result.restoreDrill.publishedPorts !== 0
      || (expectedApplicationId !== "boxpilot-controller" && result.sourceRestartVerified !== true)
      || (expectedApplicationId === "boxpilot-controller" && (
        result.consistentSnapshot !== true
        || result.snapshotMethod !== "sqlite-vacuum-into"
        || result.sourceServiceStopped !== false
        || !/^[a-f0-9]{64}$/.test(result.manifestChecksumSha256)
        || typeof result.manifestPath !== "string"
        || !result.manifestPath.endsWith(`/backups/boxpilot-controller/${job.parameters.backupId}/manifest.json`)
        || result.restoreDrill.mode !== "isolated-copy-open"
        || result.restoreDrill.copyChecksumMatched !== true
        || result.restoreDrill.manifestChecksumSha256 !== result.manifestChecksumSha256
        || result.restoreDrill.integrityCheck !== "ok"
        || result.restoreDrill.foreignKeyIssues !== 0
        || result.restoreDrill.schemaVerified !== true
        || result.restoreDrill.ownerStatePresent !== true
        || result.restoreDrill.workspaceRemoved !== true
        || result.restoreDrill.productionDatabaseReplaced !== false
        || result.restoreDrill.serviceStarted !== false
        || result.boundary?.databaseContentReturned !== false
        || result.boundary?.browserPathAccepted !== false
        || result.boundary?.browserCommandAccepted !== false
        || result.boundary?.productionDatabaseChanged !== false
        || result.boundary?.serviceStopped !== false
        || result.boundary?.networkAccessRequired !== false
        || result.boundary?.independentCopyCreated !== false
        || result.boundary?.retentionPerformed !== false
      ))
      || (expectedApplicationId === "pi-hole" && (result.restoreDrill.configurationIncluded !== true || result.restoreDrill.administratorSecretIncluded !== true || result.restoreDrill.routerMutationPerformed !== false || result.restoreDrill.dnsCutoverPerformed !== false || result.routerMutationPerformed !== false || result.dnsCutoverPerformed !== false))
      || (expectedApplicationId === "keel" && (
        result.releaseVersion !== "1.2.6"
        || !/^[a-f0-9]{64}$/.test(result.manifestChecksumSha256)
        || result.restoreDrill.mode !== "isolated-keel-export-open"
        || result.restoreDrill.databaseIntegrity !== "ok"
        || result.restoreDrill.foreignKeyIssues !== 0
        || result.restoreDrill.schemaVerified !== true
        || result.restoreDrill.environmentIncluded !== true
        || result.restoreDrill.treeDigestMatched !== true
        || result.restoreDrill.manifestChecksumSha256 !== result.manifestChecksumSha256
        || result.restoreDrill.workspaceRemoved !== true
        || result.restoreDrill.applicationStarted !== false
        || result.restoreDrill.productionStateReplaced !== false
        || result.boundary?.browserPathAccepted !== false
        || result.boundary?.browserCommandAccepted !== false
        || result.boundary?.browserTokenAccepted !== false
        || result.boundary?.databaseOpened !== true
        || result.boundary?.secretContentReturned !== false
        || result.boundary?.environmentContentReturned !== false
        || result.boundary?.sourceServiceStopped !== true
        || result.boundary?.sourceRestarted !== true
        || result.boundary?.networkAccessRequiredForDrill !== false
        || result.boundary?.productionStateReplaced !== false
        || result.boundary?.registrationChanged !== false
        || result.boundary?.claimChanged !== false
        || result.boundary?.tailscaleChanged !== false
        || result.boundary?.firewallChanged !== false
        || result.boundary?.routerChanged !== false
        || result.boundary?.independentCopyCreated !== false
        || result.boundary?.retentionPerformed !== false
        || result.boundary?.prunePerformed !== false
      ))
    ) throw new Error("Backup result failed evidence validation");
    return store.recordBackup({
      id: result.backupId,
      applicationId: result.applicationId,
      destination: result.destination,
      artifactPath: result.artifactPath,
      checksumSha256: result.checksumSha256,
      sizeBytes: result.sizeBytes,
      downtimeMs: result.downtimeMs,
      restoreDrill: result.restoreDrill,
      createdBy: job.createdBy,
    });
  }

  return { list, plan, stage, validateJob, recordResult };
}
