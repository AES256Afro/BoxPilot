import { networkInternals } from "./network.mjs";

const firmwarePattern = /^[A-Za-z0-9][A-Za-z0-9._()+ -]{0,63}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const maxCheckpointBytes = 64 * 1024 * 1024;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function createRouterCheckpointService({ store }) {
  const catalog = networkInternals.routerCatalog.map(({ id, name, roles, officialSource }) => ({ id, name, roles, officialSource }));
  const modelIds = new Set(catalog.map((model) => model.id));

  function inspect() {
    const checkpoints = store.listRouterCheckpoints();
    return {
      catalog,
      checkpoints,
      latestByModel: Object.fromEntries(catalog.map((model) => [model.id, checkpoints.find((checkpoint) => checkpoint.modelId === model.id) ?? null])),
      boundary: {
        hashing: "operator-browser-reported-sha256",
        configurationUploaded: false,
        credentialsAccepted: false,
        routerSessionOpened: false,
        routerMutationSupported: false,
        dnsCutoverSupported: false,
        maximumFileBytes: maxCheckpointBytes,
      },
      limitations: [
        "The configuration file remains on the operator device and must be retained outside BoxPilot.",
        "A checksum record proves file identity, not that the router can restore it successfully.",
        "The authenticated browser reports the digest; this is attributable operator evidence, not remote attestation.",
        "No router login, live firmware discovery, configuration diff, setting change, or rollback execution exists.",
      ],
    };
  }

  function record(body, ownerId) {
    if (!exactKeys(body, ["checksumSha256", "fileRetainedByOperator", "firmwareVersion", "modelId", "sizeBytes"])) throw new Error("Router checkpoint accepts only model, firmware, checksum, size, and file-retention evidence");
    if (!modelIds.has(body.modelId)) throw new Error("Choose a supported router model declaration");
    if (typeof body.firmwareVersion !== "string" || !firmwarePattern.test(body.firmwareVersion)) throw new Error("Firmware version must be 1 to 64 safe characters");
    if (typeof body.checksumSha256 !== "string" || !checksumPattern.test(body.checksumSha256)) throw new Error("Router checkpoint requires a lowercase SHA-256 checksum");
    if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 64 || body.sizeBytes > maxCheckpointBytes) throw new Error("Router backup must be between 64 bytes and 64 MiB");
    if (body.fileRetainedByOperator !== true) throw new Error("Confirm that the original router backup remains stored outside BoxPilot");
    return store.recordRouterCheckpoint({
      modelId: body.modelId,
      firmwareVersion: body.firmwareVersion,
      checksumSha256: body.checksumSha256,
      sizeBytes: body.sizeBytes,
      hashOrigin: "operator-browser-reported-sha256",
      configurationUploaded: false,
      fileRetainedByOperator: true,
      createdBy: ownerId,
    });
  }

  return { inspect, record };
}

export const routerCheckpointInternals = { checksumPattern, exactKeys, firmwarePattern, maxCheckpointBytes };
