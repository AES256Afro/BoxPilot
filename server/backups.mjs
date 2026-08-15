import { randomUUID } from "node:crypto";

export function createBackupService({ store, prerequisites, helper }) {
  async function inspectSource() {
    try {
      return await helper.request("application.uptime-kuma.inspect", {});
    } catch {
      return { installed: false, healthy: false, state: "unavailable", detail: "Application inventory is unavailable" };
    }
  }

  async function list() {
    const source = await inspectSource();
    const backups = store.listBackups();
    const latest = backups.find((backup) => backup.applicationId === "uptime-kuma") ?? null;
    const state = !source.installed ? "not-installed" : latest?.restoreDrill?.passed ? "verified" : "unprotected";
    return {
      coverage: [{
        applicationId: "uptime-kuma",
        name: "Uptime Kuma",
        source,
        state,
        protected: state === "verified",
        latestBackup: latest,
        requirement: "A successful local artifact plus an isolated no-network restore drill",
      }],
      backups,
      limitations: ["The current destination is on Bigbox itself. Add an independent NAS or encrypted offsite copy before treating it as 3-2-1 protection."],
    };
  }

  async function plan(applicationId, ownerId) {
    if (applicationId !== "uptime-kuma") throw new Error("Backup adapter not found");
    const source = await inspectSource();
    const inventory = await prerequisites.inspect();
    const required = new Set(["storage.state", "helper.boundary", "containers.docker"]);
    const blockers = inventory.checks.filter((item) => required.has(item.id) && item.status !== "ready")
      .map((item) => ({ id: item.id, summary: item.summary, repair: item.repair }));
    if (!source.installed) blockers.push({ id: "application.uptime-kuma", summary: "Uptime Kuma is not installed", repair: { kind: "guided", description: "Deploy the curated Uptime Kuma adapter first" } });
    else if (!source.healthy) blockers.push({ id: "application.uptime-kuma.health", summary: "Uptime Kuma is not healthy", repair: { kind: "manual", description: "Restore application health before creating a backup" } });

    const output = {
      applicationId,
      destination: "local-managed",
      executable: blockers.length === 0,
      blockers,
      changes: [
        "Stop Uptime Kuma cleanly so its SQLite database is consistent",
        "Create a compressed archive in the confined BoxPilot-managed backup directory",
        "Restart the source container and require its Docker health check to pass",
        "Compute and record a SHA-256 checksum for the completed artifact",
        "Restore into a temporary container with no network and no published ports",
        "Delete only the temporary restore workspace after evidence is recorded",
      ],
      warnings: [
        "The source will have brief measured downtime while its consistent archive is created.",
        "A local-only artifact is verified recovery evidence, but it is not yet protection from failure of Bigbox itself.",
      ],
      recovery: "If the archive step fails, BoxPilot restarts Uptime Kuma and verifies source health. It never deletes an existing backup artifact.",
    };
    return store.createPlan({ type: "application.backup", subjectId: applicationId, input: { destination: "local-managed" }, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "application.backup") throw new Error("Backup plan not found");
    if (plan.revision !== revision) throw new Error("Backup plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("Backup plan has unresolved blockers");
    const source = await inspectSource();
    if (!source.installed || !source.healthy) throw new Error("Host state changed: Uptime Kuma is not installed and healthy");
    store.stagePlan(plan.id, ownerId);
    const backupId = randomUUID();
    return store.createJob({
      type: "application.uptime-kuma.backup",
      title: "Back up and restore-test Uptime Kuma",
      risk: "medium",
      parameters: { planId: plan.id, revision: plan.revision, backupId },
      recovery: {
        automaticRollback: true,
        reason: "The source container is restarted and health checked even when archive creation fails.",
        manual: "If source restart verification fails, run docker start boxpilot-uptime-kuma and inspect its health before attempting another backup.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Source health, helper, Docker, storage, and fixed destination validated" },
        { name: "checkpoint", state: "completed", detail: "Existing backup artifacts are immutable and the source restart path is recorded" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.uptime-kuma.backup") throw new Error("Unsupported backup job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.revision !== job.parameters.revision) throw new Error("The staged backup plan is unavailable or changed");
    const source = await inspectSource();
    if (!source.installed || !source.healthy) throw new Error("Host state changed: Uptime Kuma is not installed and healthy");
    return plan;
  }

  function recordResult(job, result) {
    const expectedSuffix = `/backups/uptime-kuma/${job.parameters.backupId}.tar.gz`;
    if (
      result.backupId !== job.parameters.backupId
      || result.applicationId !== "uptime-kuma"
      || result.destination !== "local-managed"
      || typeof result.artifactPath !== "string"
      || !result.artifactPath.endsWith(expectedSuffix)
      || !/^[a-f0-9]{64}$/.test(result.checksumSha256)
      || !Number.isInteger(result.sizeBytes) || result.sizeBytes < 1
      || !Number.isInteger(result.downtimeMs) || result.downtimeMs < 0
      || !result.restoreDrill?.passed
      || result.restoreDrill.network !== "none"
      || result.restoreDrill.publishedPorts !== 0
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
