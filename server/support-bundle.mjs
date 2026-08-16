import { createRedactor, loadRedactionPolicy } from "./redaction.mjs";

const productVersion = "0.53.0";
const logSources = ["boxpilot", "docker", "tailscale", "virtualization"];

function settled(result) {
  return result.status === "fulfilled" ? { status: "available", data: result.value } : { status: "unavailable" };
}

export function createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper, loadPolicy = loadRedactionPolicy, now = () => new Date(), version = productVersion } = {}) {
  async function inspect() {
    const policy = await loadPolicy().catch(() => ({ status: "unavailable", additionalLiterals: [], additionalPathPrefixes: [] }));
    const redactor = createRedactor(policy);
    const [inventoryResult, prerequisiteResult, actionResult, auditResult, ...logResults] = await Promise.allSettled([
      inventory.inspect(),
      prerequisites.inspect(),
      actionCenter.inspect(),
      audit.list(100),
      ...logSources.map((source) => helper.request("system.logs.inspect", { source, limit: 50 })),
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
