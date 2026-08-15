import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestFile, inspectMigrationBundleDirectory, migrationBundleInternals, migrationBundleLimits } from "./migration-bundle.mjs";

const { uuidPattern, shaPattern, fingerprintPattern } = migrationBundleInternals;
const metadataNames = new Set(["manifest.json", "boxpilot-transfer.json", ".boxpilot-transfer-in-progress.json", ".manifest.json.part", ".boxpilot-transfer.json.part", "..boxpilot-transfer-in-progress.json.part"]);

function exactKeys(value, expected) {
  const keys = Object.keys(value ?? {}).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function validateMigrationTransferInput(value) {
  const errors = [];
  const keys = ["bundleId", "contentRevision", "expectedDestinationState", "expectedRemainingBytes", "sourceFingerprint", "transferId"];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, keys)) return ["Transfer accepts only fixed typed evidence fields"];
  if (!uuidPattern.test(value.transferId ?? "")) errors.push("Transfer id is invalid");
  if (!uuidPattern.test(value.bundleId ?? "")) errors.push("Bundle id is invalid");
  if (!fingerprintPattern.test(value.sourceFingerprint ?? "")) errors.push("Source fingerprint is invalid");
  if (!shaPattern.test(value.contentRevision ?? "")) errors.push("Content revision is invalid");
  if (!["empty", "resumable", "completed"].includes(value.expectedDestinationState)) errors.push("Destination state is invalid");
  if (!Number.isSafeInteger(value.expectedRemainingBytes) || value.expectedRemainingBytes < 0) errors.push("Expected remaining size is invalid");
  return errors;
}

async function walkDestination(root, current = "", counter = { entries: 0 }) {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    counter.entries += 1;
    if (counter.entries > (migrationBundleLimits.maximumFiles * 3) + 16) throw new Error("Staging destination inventory limit exceeded");
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Staging destination contains a symbolic link");
    if (entry.isDirectory()) files.push(...await walkDestination(root, relative, counter));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("Staging destination contains an unsupported file type");
  }
  return files;
}

function destinationPath(stagingRoot, bundleId) {
  const resolved = path.resolve(stagingRoot, bundleId);
  if (path.dirname(resolved) !== path.resolve(stagingRoot)) throw new Error("Staging destination escaped its root");
  return resolved;
}

function payloadPath(payloadRoot, relative) {
  const resolved = path.resolve(payloadRoot, ...relative.split("/"));
  if (!resolved.startsWith(`${path.resolve(payloadRoot)}${path.sep}`)) throw new Error("Staging payload escaped its root");
  return resolved;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("Staging metadata is invalid");
  }
}

async function inspectDestination(stagingRoot, bundle) {
  const directory = destinationPath(stagingRoot, bundle.manifest.bundleId);
  try {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("Staging destination collides with an unsupported entry");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "empty", remainingBytes: bundle.manifest.totalBytes, verifiedBytes: 0, verifiedFiles: 0, directory };
    throw error;
  }
  const discovered = await walkDestination(directory);
  const expectedFinal = new Set(bundle.manifest.files.map((item) => `payload/${item.path}`));
  const expectedPartial = new Set(bundle.manifest.files.map((item) => `payload/${item.path}.boxpilot-part`));
  for (const relative of discovered) {
    if (!metadataNames.has(relative) && !expectedFinal.has(relative) && !expectedPartial.has(relative)) throw new Error("Staging destination contains files outside the reviewed bundle inventory");
  }
  const destinationManifestPath = path.join(directory, "manifest.json");
  if (discovered.includes("manifest.json")) {
    const destinationManifest = await readJson(destinationManifestPath);
    if (destinationManifest.contentRevision !== bundle.manifest.contentRevision || JSON.stringify(destinationManifest) !== JSON.stringify(bundle.manifest)) throw new Error("Staging destination manifest collides with this bundle");
  }
  let verifiedBytes = 0;
  let verifiedFiles = 0;
  const payloadRoot = path.join(directory, "payload");
  for (const item of bundle.manifest.files) {
    const relative = `payload/${item.path}`;
    if (!discovered.includes(relative)) continue;
    const target = payloadPath(payloadRoot, item.path);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== item.sizeBytes || await digestFile(target) !== item.sha256) {
      throw new Error("Staging destination contains a conflicting payload file");
    }
    verifiedBytes += item.sizeBytes;
    verifiedFiles += 1;
  }
  const transferPath = path.join(directory, "boxpilot-transfer.json");
  if (discovered.includes("boxpilot-transfer.json")) {
    const transfer = await readJson(transferPath);
    if (!exactKeys(transfer, ["activationPerformed", "bundleId", "complete", "contentRevision", "fileCount", "sizeBytes", "sourceFingerprint", "sourcePreserved", "transferId"]) || transfer.complete !== true
      || !uuidPattern.test(transfer.transferId ?? "") || transfer.bundleId !== bundle.manifest.bundleId || transfer.contentRevision !== bundle.manifest.contentRevision
      || transfer.sourceFingerprint !== bundle.manifest.sourceFingerprint || transfer.fileCount !== bundle.manifest.files.length || transfer.sizeBytes !== bundle.manifest.totalBytes
      || transfer.sourcePreserved !== true || transfer.activationPerformed !== false || verifiedFiles !== bundle.manifest.files.length) {
      throw new Error("Completed staging evidence is invalid");
    }
    return { state: "completed", remainingBytes: 0, verifiedBytes, verifiedFiles, directory, transferId: transfer.transferId };
  }
  return { state: "resumable", remainingBytes: bundle.manifest.totalBytes - verifiedBytes, verifiedBytes, verifiedFiles, directory };
}

async function writeJsonAtomic(directory, name, value) {
  const temporary = path.join(directory, `.${name}.part`);
  await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path.join(directory, name));
}

function sanitizeBundle(bundle, destination, freeBytes) {
  const manifest = bundle.manifest;
  const capacityReady = destination.remainingBytes <= freeBytes;
  const blockers = [];
  if (!capacityReady) blockers.push("Managed staging does not report enough free space for the remaining verified copy");
  return {
    bundleId: manifest.bundleId,
    workloadName: manifest.workloadName,
    sourceFingerprint: manifest.sourceFingerprint,
    createdAt: manifest.createdAt,
    composeFile: manifest.composeFile,
    contentRevision: manifest.contentRevision,
    fileCount: manifest.files.length,
    sensitiveFileCount: bundle.sensitiveFileCount,
    totalBytes: manifest.totalBytes,
    destinationState: destination.state,
    remainingBytes: destination.remainingBytes,
    verifiedBytes: destination.verifiedBytes,
    completedTransferId: destination.transferId ?? null,
    executable: destination.state !== "completed" && capacityReady,
    reconcilable: destination.state === "completed",
    blockers,
  };
}

export function createMigrationTransferHelper({
  inboxRoot = process.env.BOXPILOT_MIGRATION_INBOX ?? "/var/lib/boxpilot-migration/inbox",
  stagingRoot = process.env.BOXPILOT_MIGRATION_STAGING_ROOT ?? "/var/lib/boxpilot-managed/migration-staging",
} = {}) {
  const resolvedInbox = path.resolve(inboxRoot);
  const resolvedStaging = path.resolve(stagingRoot);
  if (resolvedInbox === resolvedStaging || resolvedInbox.startsWith(`${resolvedStaging}${path.sep}`) || resolvedStaging.startsWith(`${resolvedInbox}${path.sep}`)) throw new Error("Migration inbox and staging roots must be separate");

  async function initialize() {
    await mkdir(resolvedInbox, { recursive: true, mode: 0o700 });
    await mkdir(resolvedStaging, { recursive: true, mode: 0o700 });
    await chmod(resolvedInbox, 0o700);
    await chmod(resolvedStaging, 0o700);
  }

  async function inspectOne(bundleId) {
    const bundle = await inspectMigrationBundleDirectory(resolvedInbox, bundleId);
    const destination = await inspectDestination(resolvedStaging, bundle);
    const capacity = await statfs(resolvedStaging, { bigint: true });
    const freeBytesBig = capacity.bavail * capacity.bsize;
    const freeBytes = freeBytesBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(freeBytesBig);
    return { bundle, destination, public: sanitizeBundle(bundle, destination, freeBytes) };
  }

  async function inspect() {
    const entries = (await readdir(resolvedInbox, { withFileTypes: true })).filter((entry) => uuidPattern.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 100);
    const bundles = [];
    const invalidBundles = [];
    for (const entry of entries) {
      try {
        bundles.push((await inspectOne(entry.name)).public);
      } catch (error) {
        invalidBundles.push({ bundleId: entry.name, reason: error.message.slice(0, 240) });
      }
    }
    bundles.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { ready: true, bundles, invalidBundles, activationSupported: false, sourceMutationSupported: false };
  }

  async function transfer(parameters) {
    const errors = validateMigrationTransferInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const inspected = await inspectOne(parameters.bundleId);
    const current = inspected.public;
    const evidenceChanged = current.sourceFingerprint !== parameters.sourceFingerprint || current.contentRevision !== parameters.contentRevision
      || current.destinationState !== parameters.expectedDestinationState || current.remainingBytes !== parameters.expectedRemainingBytes;
    if (evidenceChanged) {
      throw new Error("Migration bundle, capacity, or managed staging state changed after approval");
    }
    if (current.destinationState === "completed") {
      if (current.completedTransferId !== parameters.transferId) throw new Error("Completed migration staging evidence belongs to a different transfer");
      return {
        created: true,
        reconciled: true,
        transferId: parameters.transferId,
        bundleId: parameters.bundleId,
        workloadName: inspected.bundle.manifest.workloadName,
        sourceFingerprint: parameters.sourceFingerprint,
        contentRevision: parameters.contentRevision,
        destination: `managed-migration-staging/${parameters.bundleId}`,
        fileCount: inspected.bundle.manifest.files.length,
        sizeBytes: inspected.bundle.manifest.totalBytes,
        copiedFiles: 0,
        resumedFiles: inspected.bundle.manifest.files.length,
        contentVerified: true,
        sourcePreserved: true,
        activationPerformed: false,
        networkCutoverPerformed: false,
        sourceDeletionPerformed: false,
      };
    }
    if (!current.executable) {
      throw new Error("Migration bundle, capacity, or managed staging state changed after approval");
    }
    const { bundle, destination } = inspected;
    await mkdir(path.join(destination.directory, "payload"), { recursive: true, mode: 0o700 });
    await chmod(destination.directory, 0o700);
    const progress = {
      transferId: parameters.transferId,
      bundleId: parameters.bundleId,
      sourceFingerprint: parameters.sourceFingerprint,
      contentRevision: parameters.contentRevision,
    };
    await writeJsonAtomic(destination.directory, ".boxpilot-transfer-in-progress.json", progress);
    let copiedFiles = 0;
    let resumedFiles = 0;
    for (const item of bundle.manifest.files) {
      const source = payloadPath(bundle.payloadRoot, item.path);
      const target = payloadPath(path.join(destination.directory, "payload"), item.path);
      try {
        const existing = await lstat(target);
        if (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1 && existing.size === item.sizeBytes && await digestFile(target) === item.sha256) {
          resumedFiles += 1;
          continue;
        }
        throw new Error("Managed staging contains a conflicting payload file");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (await digestFile(source) !== item.sha256) throw new Error("Migration source bundle changed during transfer");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const partial = `${target}.boxpilot-part`;
      await unlink(partial).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await copyFile(source, partial);
      await chmod(partial, 0o600);
      if (await digestFile(partial) !== item.sha256) throw new Error("Migration staging copy checksum verification failed");
      await rename(partial, target);
      copiedFiles += 1;
    }
    const sourceAfter = await inspectMigrationBundleDirectory(resolvedInbox, parameters.bundleId);
    if (sourceAfter.manifest.contentRevision !== parameters.contentRevision) throw new Error("Migration source bundle changed during transfer");
    await writeJsonAtomic(destination.directory, "manifest.json", bundle.manifest);
    const evidence = {
      transferId: parameters.transferId,
      bundleId: parameters.bundleId,
      sourceFingerprint: parameters.sourceFingerprint,
      contentRevision: parameters.contentRevision,
      fileCount: bundle.manifest.files.length,
      sizeBytes: bundle.manifest.totalBytes,
      complete: true,
      sourcePreserved: true,
      activationPerformed: false,
    };
    await writeJsonAtomic(destination.directory, "boxpilot-transfer.json", evidence);
    await unlink(path.join(destination.directory, ".boxpilot-transfer-in-progress.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    const verified = await inspectDestination(resolvedStaging, bundle);
    if (verified.state !== "completed" || verified.transferId !== parameters.transferId || verified.verifiedFiles !== bundle.manifest.files.length) throw new Error("Migration staging verification did not complete");
    return {
      created: true,
      transferId: parameters.transferId,
      bundleId: parameters.bundleId,
      workloadName: bundle.manifest.workloadName,
      sourceFingerprint: parameters.sourceFingerprint,
      contentRevision: parameters.contentRevision,
      destination: `managed-migration-staging/${parameters.bundleId}`,
      fileCount: bundle.manifest.files.length,
      sizeBytes: bundle.manifest.totalBytes,
      copiedFiles,
      resumedFiles,
      contentVerified: true,
      sourcePreserved: true,
      activationPerformed: false,
      networkCutoverPerformed: false,
      sourceDeletionPerformed: false,
    };
  }

  return { initialize, inspect, transfer };
}

export const migrationTransferHelperInternals = { destinationPath, inspectDestination, payloadPath, sanitizeBundle, walkDestination };
