import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, open, readdir, readFile, rm, statfs, unlink } from "node:fs/promises";
import path from "node:path";

const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const maximumIsoBytes = 16 * 1024 ** 3;
const reserveBytes = 1024 ** 3;

export function safeIsoFilename(value) {
  return typeof value === "string"
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._ -]*\.iso$/i.test(value)
    && path.basename(value) === value;
}

export function validateVmMediaImportInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["A VM media import object is required"];
  const errors = [];
  const keys = Object.keys(value).sort();
  const expectedKeys = ["expectedRevision", "expectedSha256", "expectedSizeBytes", "filename", "importId"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) errors.push("VM media import accepts only the fixed evidence fields");
  if (!safeIsoFilename(value.filename)) errors.push("The ISO filename is invalid");
  if (!Number.isSafeInteger(value.expectedSizeBytes) || value.expectedSizeBytes <= 0 || value.expectedSizeBytes > maximumIsoBytes) errors.push("The ISO byte count is invalid");
  if (!sha256Pattern.test(String(value.expectedSha256 ?? ""))) errors.push("The ISO SHA-256 is invalid");
  if (!sha256Pattern.test(String(value.expectedRevision ?? ""))) errors.push("The staging revision is invalid");
  if (!uuidPattern.test(String(value.importId ?? ""))) errors.push("The import id is invalid");
  return errors;
}

async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function revisionOf(candidate) {
  return createHash("sha256").update(JSON.stringify({
    name: candidate.name,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    modifiedAt: candidate.modifiedAt,
  })).digest("hex");
}

export function createVmMediaHelper({
  inboxRoot = process.env.BOXPILOT_VM_MEDIA_INBOX ?? "/var/lib/boxpilot-managed/vm-media-inbox",
  mediaRoot = process.env.BOXPILOT_ISO_DIRECTORY ?? "/var/lib/libvirt/boot",
  readDirectory = readdir,
  statFile = lstat,
  readText = readFile,
  filesystemStats = statfs,
  copy = copyFile,
} = {}) {
  const resolvedInboxRoot = path.resolve(inboxRoot);
  const resolvedMediaRoot = path.resolve(mediaRoot);

  function dataPath(filename) {
    return path.join(resolvedInboxRoot, filename);
  }

  function metadataPath(filename) {
    return path.join(resolvedInboxRoot, `${filename}.boxpilot.json`);
  }

  async function stagedCandidates() {
    let entries;
    try {
      entries = await readDirectory(resolvedInboxRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES") return [];
      throw error;
    }
    const names = entries
      .filter((entry) => entry.isFile() && safeIsoFilename(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 50);
    const candidates = [];
    for (const name of names) {
      try {
        const [file, metadataFile] = await Promise.all([statFile(dataPath(name)), statFile(metadataPath(name))]);
        if (!file.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > maximumIsoBytes) continue;
        if (!metadataFile.isFile() || metadataFile.isSymbolicLink() || metadataFile.size <= 0 || metadataFile.size > 4096) continue;
        const metadata = JSON.parse(await readText(metadataPath(name), "utf8"));
        const validUploadedAt = typeof metadata?.uploadedAt === "string" && Number.isFinite(Date.parse(metadata.uploadedAt)) && new Date(metadata.uploadedAt).toISOString() === metadata.uploadedAt;
        if (metadata?.schemaVersion !== 1 || metadata?.name !== name || metadata?.sizeBytes !== file.size || !sha256Pattern.test(String(metadata?.sha256 ?? "")) || !validUploadedAt) continue;
        const candidate = {
          name,
          sizeBytes: file.size,
          sha256: metadata.sha256,
          uploadedAt: metadata.uploadedAt,
          modifiedAt: file.mtime.toISOString(),
        };
        candidates.push({ ...candidate, revision: revisionOf(candidate) });
      } catch {
        // Ignore incomplete or malformed staging pairs. They cannot be selected.
      }
    }
    return candidates;
  }

  async function managedImages() {
    let entries;
    try {
      entries = await readDirectory(resolvedMediaRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES") return [];
      throw error;
    }
    const images = [];
    for (const entry of entries.filter((item) => item.isFile() && safeIsoFilename(item.name)).slice(0, 100)) {
      try {
        const file = await statFile(path.join(resolvedMediaRoot, entry.name));
        if (file.isFile() && !file.isSymbolicLink() && file.size > 0) images.push({ name: entry.name, sizeBytes: file.size, modifiedAt: file.mtime.toISOString() });
      } catch {
        // Ignore entries that changed during bounded inventory.
      }
    }
    return images.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function inspect() {
    const [candidates, managed] = await Promise.all([stagedCandidates(), managedImages()]);
    return {
      inbox: { path: resolvedInboxRoot, candidates },
      library: { path: resolvedMediaRoot, images: managed },
      limits: { maximumIsoBytes },
      boundary: {
        browserPathAccepted: false,
        arbitraryDestinationAccepted: false,
        checksumVerifiedDuringImport: true,
        existingMediaOverwritten: false,
        mutationPerformed: false,
      },
    };
  }

  async function importMedia(parameters) {
    const errors = validateVmMediaImportInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const before = await inspect();
    const candidate = before.inbox.candidates.find((item) => item.name === parameters.filename);
    if (!candidate || candidate.revision !== parameters.expectedRevision || candidate.sha256 !== parameters.expectedSha256 || candidate.sizeBytes !== parameters.expectedSizeBytes) {
      throw new Error("The staged ISO changed after approval");
    }
    const source = dataPath(candidate.name);
    const destination = path.join(resolvedMediaRoot, candidate.name);
    const partial = path.join(resolvedMediaRoot, `.boxpilot-import-${parameters.importId}.partial`);
    if (path.dirname(source) !== resolvedInboxRoot || path.dirname(destination) !== resolvedMediaRoot || path.dirname(partial) !== resolvedMediaRoot) throw new Error("VM media paths escaped their fixed roots");
    await statFile(destination).then(() => { throw new Error("A managed ISO with this filename already exists"); }, (error) => { if (error.code !== "ENOENT") throw error; });
    await statFile(partial).then(() => { throw new Error("The generated VM media partial path already exists"); }, (error) => { if (error.code !== "ENOENT") throw error; });
    const filesystem = await filesystemStats(resolvedMediaRoot);
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isSafeInteger(availableBytes) || availableBytes < candidate.sizeBytes + reserveBytes) throw new Error("The managed ISO library does not have enough free space for an atomic verified import");
    const sourceSha256 = await sha256(source);
    if (sourceSha256 !== candidate.sha256) throw new Error("The staged ISO SHA-256 no longer matches the reviewed upload");
    let published = false;
    try {
      await copy(source, partial, constants.COPYFILE_EXCL);
      await chmod(partial, 0o444);
      const handle = await open(partial, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      const destinationSha256 = await sha256(partial);
      if (destinationSha256 !== candidate.sha256) throw new Error("The copied ISO SHA-256 does not match the reviewed upload");
      await link(partial, destination);
      published = true;
      await unlink(partial);
      const publishedFile = await statFile(destination);
      if (!publishedFile.isFile() || publishedFile.isSymbolicLink() || publishedFile.size !== candidate.sizeBytes || await sha256(destination) !== candidate.sha256) {
        throw new Error("The published managed ISO failed final verification");
      }
    } catch (error) {
      await rm(partial, { force: true });
      if (published) await rm(destination, { force: true });
      throw new Error(`${error.message} Existing managed media was unchanged; the staged upload was preserved.`);
    }
    const cleanup = await Promise.allSettled([unlink(source), unlink(metadataPath(candidate.name))]);
    return {
      imported: true,
      verified: true,
      importId: parameters.importId,
      filename: candidate.name,
      sizeBytes: candidate.sizeBytes,
      sha256: candidate.sha256,
      destination: "managed-libvirt-media-library",
      stagingRemoved: cleanup.every((result) => result.status === "fulfilled"),
      boundary: {
        existingMediaOverwritten: false,
        arbitraryPathAccepted: false,
        arbitraryDestinationAccepted: false,
        virtualMachineCreated: false,
        libvirtChanged: false,
        networkChanged: false,
      },
    };
  }

  return { inspect, importMedia };
}

export const vmMediaHelperInternals = { maximumIsoBytes, reserveBytes, revisionOf, sha256Pattern, uuidPattern };
