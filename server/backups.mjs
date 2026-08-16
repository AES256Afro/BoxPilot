import { randomUUID } from "node:crypto";

export function createBackupService({ store, prerequisites, helper }) {
  const adapters = {
    "uptime-kuma": { name: "Uptime Kuma", inspectOperation: "application.uptime-kuma.inspect", jobType: "application.uptime-kuma.backup" },
    "pi-hole": { name: "Pi-hole", inspectOperation: "application.pi-hole.inspect", jobType: "application.pi-hole.backup" },
  };

  async function inspectSource(applicationId) {
    try {
      return await helper.request(adapters[applicationId].inspectOperation, {});
    } catch {
      return { installed: false, healthy: false, state: "unavailable", detail: "Application inventory is unavailable" };
    }
  }

  async function list() {
    const backups = store.listBackups();
    const coverage = await Promise.all(Object.entries(adapters).map(async ([applicationId, adapter]) => {
      const source = await inspectSource(applicationId);
      const latest = backups.find((backup) => backup.applicationId === applicationId) ?? null;
      const state = !source.installed ? "not-installed" : latest?.restoreDrill?.passed ? "verified" : "unprotected";
      return {
        applicationId,
        name: adapter.name,
        source,
        state,
        protected: state === "verified",
        latestBackup: latest,
        requirement: "A successful local artifact plus an isolated no-network restore drill",
      };
    }));
    return {
      coverage,
      backups,
      limitations: ["The current destination is on Bigbox itself. Add an independent NAS or encrypted offsite copy before treating it as 3-2-1 protection."],
    };
  }

  async function plan(applicationId, ownerId) {
    const adapter = adapters[applicationId];
    if (!adapter) throw new Error("Backup adapter not found");
    const source = await inspectSource(applicationId);
    const inventory = await prerequisites.inspect();
    const required = new Set(["storage.state", "helper.boundary", "containers.docker"]);
    const blockers = inventory.checks.filter((item) => required.has(item.id) && item.status !== "ready")
      .map((item) => ({ id: item.id, summary: item.summary, repair: item.repair }));
    if (!source.installed) blockers.push({ id: `application.${applicationId}`, summary: `${adapter.name} is not installed`, repair: { kind: "guided", description: `Deploy the curated ${adapter.name} adapter first` } });
    else if (!source.healthy) blockers.push({ id: `application.${applicationId}.health`, summary: `${adapter.name} is not healthy`, repair: { kind: "manual", description: "Restore application health before creating a backup" } });

    const output = {
      applicationId,
      destination: "local-managed",
      executable: blockers.length === 0,
      blockers,
      changes: [
        `Stop ${adapter.name} cleanly so its application state is consistent`,
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
      recovery: `If the archive step fails, BoxPilot restarts ${adapter.name} and verifies source health. It never deletes an existing backup artifact.${applicationId === "pi-hole" ? " Router and client DNS are never changed by this workflow." : ""}`,
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
        reason: "The source container is restarted and health checked even when archive creation fails.",
        manual: plan.subjectId === "pi-hole" ? "If source restart verification fails, keep router and client DNS on the independent resolver, run docker start boxpilot-pi-hole, and inspect health before another backup." : "If source restart verification fails, run docker start boxpilot-uptime-kuma and inspect its health before attempting another backup.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Source health, helper, Docker, storage, and fixed destination validated" },
        { name: "checkpoint", state: "completed", detail: "Existing backup artifacts are immutable and the source restart path is recorded" },
      ],
    });
  }

  async function validateJob(job) {
    if (!["application.uptime-kuma.backup", "application.pi-hole.backup"].includes(job.type)) throw new Error("Unsupported backup job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.revision !== job.parameters.revision) throw new Error("The staged backup plan is unavailable or changed");
    const expectedApplicationId = job.type === "application.pi-hole.backup" ? "pi-hole" : "uptime-kuma";
    if (plan.subjectId !== expectedApplicationId || job.parameters.applicationId !== expectedApplicationId) throw new Error("The staged backup plan does not match the requested adapter");
    const source = await inspectSource(expectedApplicationId);
    if (!source.installed || !source.healthy) throw new Error(`Host state changed: ${adapters[expectedApplicationId].name} is not installed and healthy`);
    return plan;
  }

  function recordResult(job, result) {
    const expectedApplicationId = job.type === "application.pi-hole.backup" ? "pi-hole" : "uptime-kuma";
    const expectedSuffix = `/backups/${expectedApplicationId}/${job.parameters.backupId}.tar.gz`;
    if (
      result.backupId !== job.parameters.backupId
      || result.applicationId !== expectedApplicationId
      || result.destination !== "local-managed"
      || typeof result.artifactPath !== "string"
      || !result.artifactPath.endsWith(expectedSuffix)
      || !/^[a-f0-9]{64}$/.test(result.checksumSha256)
      || !Number.isInteger(result.sizeBytes) || result.sizeBytes < 1
      || !Number.isInteger(result.downtimeMs) || result.downtimeMs < 0
      || result.sourceRestartVerified !== true
      || !result.restoreDrill?.passed
      || result.restoreDrill.network !== "none"
      || result.restoreDrill.publishedPorts !== 0
      || (expectedApplicationId === "pi-hole" && (result.restoreDrill.configurationIncluded !== true || result.restoreDrill.administratorSecretIncluded !== true || result.restoreDrill.routerMutationPerformed !== false || result.restoreDrill.dnsCutoverPerformed !== false || result.routerMutationPerformed !== false || result.dnsCutoverPerformed !== false))
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
