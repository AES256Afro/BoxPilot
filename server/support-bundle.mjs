import { createRedactor, loadRedactionPolicy } from "./redaction.mjs";
import { productVersion } from "./version.mjs";

const logSources = ["boxpilot", "docker", "tailscale", "virtualization"];

function settled(result) {
  return result.status === "fulfilled" ? { status: "available", data: result.value } : { status: "unavailable" };
}

/**
 * `inspect({ actorId })` is the bundle for an account that is not the owner (M29.4): its audit trail
 * is what that account did, and its failed-job count is of that account's jobs. The owner's bundle
 * (no actorId) has every account's.
 */
export function createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper, store = null, loadPolicy = loadRedactionPolicy, now = () => new Date(), version = productVersion } = {}) {
  async function inspect({ actorId } = {}) {
    const policy = await loadPolicy().catch(() => ({ status: "unavailable", additionalLiterals: [], additionalPathPrefixes: [] }));
    const redactor = createRedactor(policy);
    const scoped = actorId !== undefined;
    // The audit trail people mean is the one in the database. The file-backed log has a single
    // writer (one VM-plan event), so a bundle labelled "audit" was empty on essentially every box.
    const auditEvents = async (limit) => {
      if (scoped && !actorId) return [];
      if (store?.listAudit) return store.listAudit(limit, scoped ? { actorId } : {});
      const listed = await audit.list(limit);
      return scoped ? { ...listed, events: (listed.events ?? []).filter((event) => event.actorId === actorId) } : listed;
    };
    const [inventoryResult, prerequisiteResult, actionResult, auditResult, ...logResults] = await Promise.allSettled([
      inventory.inspect(),
      prerequisites.inspect(),
      actionCenter.inspect(scoped ? { createdBy: actorId } : {}),
      auditEvents(100),
      ...logSources.map((source) => helper.request("logs.read", { kind: "group", target: source, lines: 50 }, { timeoutMs: 60_000 })),
    ]);
    const logs = Object.fromEntries(logSources.map((source, index) => [source, settled(logResults[index])]));
    const bundle = {
      schemaVersion: 1,
      generatedAt: now().toISOString(),
      product: { name: "BoxPilot", version },
      mode: "authenticated-redacted-read-only-support-evidence",
      sources: {
        inventory: settled(inventoryResult),
        prerequisites: settled(prerequisiteResult),
        actionCenter: settled(actionResult),
        audit: settled(auditResult),
        logs,
      },
      redactionPolicy: redactor.metadata(),
      boundary: {
        mutationPerformed: false,
        databaseIncluded: false,
        backupPayloadIncluded: false,
        environmentIncluded: false,
        credentialsIncluded: false,
        arbitraryCommandsAccepted: false,
        arbitraryLogsAccepted: false,
        peerInventoryIncluded: false,
      },
    };
    return redactor.redact(bundle);
  }

  return { inspect };
}

export const supportBundleInternals = { logSources, productVersion, settled };
