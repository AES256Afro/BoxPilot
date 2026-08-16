import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { safeIsoFilename, vmMediaHelperInternals } from "./vm-media-helper.mjs";

const reserveBytes = 1024 ** 3;

function expectedUploadSize(request) {
  const value = request.get("x-boxpilot-size") ?? request.get("content-length");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > vmMediaHelperInternals.maximumIsoBytes) throw new Error("ISO size must be between 1 byte and 16 GiB");
  return parsed;
}

export function createVmMediaService({
  store,
  helper,
  inboxRoot = process.env.BOXPILOT_VM_MEDIA_INBOX ?? "/var/lib/boxpilot-managed/vm-media-inbox",
  filesystemStats = statfs,
} = {}) {
  const resolvedInboxRoot = path.resolve(inboxRoot);

  async function inspect() {
    return helper.request("virtualization.media.inspect", {});
  }

  async function upload(request) {
    if (request.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") throw new Error("ISO upload requires application/octet-stream");
    const filename = request.get("x-boxpilot-filename");
    if (!safeIsoFilename(filename)) throw new Error("Select one ISO file with a safe filename");
    const expectedSizeBytes = expectedUploadSize(request);
    await mkdir(resolvedInboxRoot, { recursive: true, mode: 0o700 });
    const filesystem = await filesystemStats(resolvedInboxRoot);
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isSafeInteger(availableBytes) || availableBytes < expectedSizeBytes + reserveBytes) throw new Error("The VM media staging area does not have enough free space for this upload");
    const target = path.join(resolvedInboxRoot, filename);
    const metadataTarget = path.join(resolvedInboxRoot, `${filename}.boxpilot.json`);
    if (path.dirname(target) !== resolvedInboxRoot || path.dirname(metadataTarget) !== resolvedInboxRoot) throw new Error("The ISO upload escaped the fixed staging directory");
    for (const item of [target, metadataTarget]) {
      await lstat(item).then(() => { throw new Error("A staged ISO with this filename already exists"); }, (error) => { if (error.code !== "ENOENT") throw error; });
    }
    const uploadId = randomUUID();
    const partial = path.join(resolvedInboxRoot, `.upload-${uploadId}.partial`);
    const metadataPartial = path.join(resolvedInboxRoot, `.upload-${uploadId}.json.partial`);
    const digest = createHash("sha256");
    let receivedBytes = 0;
    const writer = createWriteStream(partial, { flags: "wx", mode: 0o600 });
    const meterStream = async function* () {
      for await (const chunk of request) {
        receivedBytes += chunk.length;
        if (receivedBytes > expectedSizeBytes || receivedBytes > vmMediaHelperInternals.maximumIsoBytes) throw new Error("The ISO upload exceeded its declared size");
        digest.update(chunk);
        yield chunk;
      }
    };
    let publishedData = false;
    let publishedMetadata = false;
    try {
      await pipeline(meterStream(), writer);
      if (receivedBytes !== expectedSizeBytes) throw new Error("The ISO upload byte count did not match its declaration");
      const handle = await open(partial, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      const sha256 = digest.digest("hex");
      const uploadedAt = new Date().toISOString();
      await writeFile(metadataPartial, `${JSON.stringify({ schemaVersion: 1, name: filename, sizeBytes: receivedBytes, sha256, uploadedAt, source: "authenticated-browser-upload" })}\n`, { flag: "wx", mode: 0o600 });
      await link(partial, target);
      publishedData = true;
      await link(metadataPartial, metadataTarget);
      publishedMetadata = true;
      await unlink(partial);
      await unlink(metadataPartial);
      return { name: filename, sizeBytes: receivedBytes, sha256, uploadedAt };
    } catch (error) {
      await Promise.allSettled([
        unlink(partial), unlink(metadataPartial),
        ...(publishedData ? [unlink(target)] : []),
        ...(publishedMetadata ? [unlink(metadataTarget)] : []),
      ]);
      throw error;
    }
  }

  async function plan(filename, ownerId) {
    if (!safeIsoFilename(filename)) throw new Error("Select a staged ISO from the fixed upload area");
    const state = await inspect();
    const candidate = state.inbox.candidates.find((item) => item.name === filename);
    if (!candidate) throw new Error("The staged ISO is unavailable or incomplete");
    if (state.library.images.some((item) => item.name === filename)) throw new Error("A managed ISO with this filename already exists");
    const input = {
      importId: randomUUID(),
      filename: candidate.name,
      expectedSizeBytes: candidate.sizeBytes,
      expectedSha256: candidate.sha256,
      expectedRevision: candidate.revision,
    };
    const output = {
      executable: true,
      candidate,
      destination: state.library.path,
      changes: [
        `Copy the exact ${candidate.sizeBytes}-byte staged ISO into the fixed managed libvirt media library`,
        "Publish the new ISO atomically only after its complete SHA-256 matches",
        "Remove the staging pair after the managed copy passes final verification",
      ],
      verification: [
        "Recheck the staged filename, byte count, SHA-256, and revision after approval",
        "Require enough free space for the copy plus a fixed 1 GiB reserve",
        "Rehash both the staged source and final managed ISO",
      ],
      boundaries: [
        "No existing ISO is overwritten",
        "No browser path or destination is accepted",
        "No VM, network, storage pool, firewall, Tailscale, or router state changes",
      ],
      recovery: "If import fails, remove only the generated partial or newly published exact-name ISO and preserve the staged upload.",
      adapterRevision: candidate.revision,
    };
    const draft = store.createPlan({ type: "virtualization.media.import", subjectId: filename, input, output, createdBy: ownerId });
    return { ...draft.output, id: draft.id, revision: draft.revision, status: draft.status, expiresAt: draft.expiresAt, input: draft.input };
  }

  async function validateDraft(draft) {
    const state = await inspect();
    const candidate = state.inbox.candidates.find((item) => item.name === draft.input.filename);
    if (!candidate || candidate.revision !== draft.input.expectedRevision || candidate.sizeBytes !== draft.input.expectedSizeBytes || candidate.sha256 !== draft.input.expectedSha256) throw new Error("Host state changed: the staged ISO no longer matches the reviewed plan");
    if (state.library.images.some((item) => item.name === draft.input.filename)) throw new Error("Host state changed: a managed ISO with this filename now exists");
    return draft;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.media.import") throw new Error("VM media import plan not found");
    if (draft.revision !== revision) throw new Error("VM media import plan revision does not match");
    await validateDraft(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.media.import",
      title: `Import VM installation media ${draft.subjectId}`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: "Inspect only the fixed VM media staging and managed library directories before retrying." },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact staged filename, byte count, SHA-256, revision, and destination absence validated" },
        { name: "checkpoint", state: "completed", detail: "Existing media is immutable; rollback is confined to this import id and exact new filename" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.media.import") throw new Error("Unsupported VM media import job");
    const draft = store.getPlan(job.parameters.planId);
    if (!draft || draft.status !== "staged" || draft.revision !== job.parameters.revision || draft.createdBy !== job.createdBy) throw new Error("The staged VM media import plan is unavailable or changed");
    if (JSON.stringify(job.parameters.input) !== JSON.stringify(draft.input)) throw new Error("The staged VM media import job inputs do not match the approved plan");
    return validateDraft(draft);
  }

  return { inspect, upload, plan, stage, validateJob };
}

export const vmMediaInternals = { expectedUploadSize, reserveBytes };
