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

  /** Pin the staged ISO identity for the registry operation. */
  async function prepareOperation({ filename } = {}) {
    if (!safeIsoFilename(filename)) throw new Error("Select a staged ISO from the fixed upload area");
    const state = await inspect();
    const candidate = state.inbox.candidates.find((item) => item.name === filename);
    if (!candidate) throw new Error("The staged ISO is unavailable or incomplete");
    if (state.library.images.some((item) => item.name === filename)) throw new Error("A managed ISO with this filename already exists");
    return {
      importId: randomUUID(),
      filename: candidate.name,
      expectedSizeBytes: candidate.sizeBytes,
      expectedSha256: candidate.sha256,
      expectedRevision: candidate.revision,
    };
  }



  return { inspect, upload, prepareOperation };
}

export const vmMediaInternals = { expectedUploadSize, reserveBytes };
