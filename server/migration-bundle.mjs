import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const migrationBundleLimits = {
  maximumFiles: 10000,
  maximumManifestBytes: 8 * 1024 * 1024,
  maximumTotalBytes: 500 * 1024 * 1024 * 1024,
};

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const workloadPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const composeNames = new Set(["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]);
const reservedNames = new Set(["manifest.json", "boxpilot-transfer.json", ".boxpilot-transfer-in-progress.json"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function safeRelativeFile(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !reservedNames.has(part) && !part.endsWith(".boxpilot-part"));
}

export function isSensitiveMigrationPath(relativePath) {
  const lowered = relativePath.toLowerCase();
  const base = path.posix.basename(lowered);
  return base === ".env" || base.startsWith(".env.") || base.includes("secret") || base.includes("credential")
    || base === "id_rsa" || base === "id_ed25519" || base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12") || base.endsWith(".pfx");
}

export function migrationBundleRevision(manifestWithoutRevision) {
  return createHash("sha256").update(canonical(manifestWithoutRevision)).digest("hex");
}

export async function digestFile(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

export function validateMigrationBundleManifest(value, expectedBundleId = null) {
  const errors = [];
  const topKeys = ["bundleId", "composeFile", "contentRevision", "createdAt", "files", "schemaVersion", "sourceFingerprint", "totalBytes", "workloadName"];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, topKeys)) return ["Manifest fields are invalid"];
  if (value.schemaVersion !== 1) errors.push("Manifest schema version is unsupported");
  if (typeof value.bundleId !== "string" || !uuidPattern.test(value.bundleId) || (expectedBundleId && value.bundleId !== expectedBundleId)) errors.push("Bundle id is invalid");
  if (typeof value.workloadName !== "string" || !workloadPattern.test(value.workloadName)) errors.push("Workload name is invalid");
  if (typeof value.sourceFingerprint !== "string" || !fingerprintPattern.test(value.sourceFingerprint)) errors.push("Source fingerprint is invalid");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) errors.push("Creation timestamp is invalid");
  if (!composeNames.has(value.composeFile)) errors.push("Exactly one supported root Compose file is required");
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > migrationBundleLimits.maximumFiles) {
    errors.push("Manifest file inventory is invalid");
  } else {
    const seen = new Set();
    let total = 0;
    let previous = null;
    for (const item of value.files) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item, ["path", "sensitive", "sha256", "sizeBytes"])) {
        errors.push("Manifest file fields are invalid");
        continue;
      }
      if (!safeRelativeFile(item.path) || seen.has(item.path) || (previous !== null && previous.localeCompare(item.path) >= 0)) errors.push("Manifest file paths must be safe, unique, and sorted");
      seen.add(item.path);
      previous = item.path;
      if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) errors.push("Manifest file size is invalid");
      else total += item.sizeBytes;
      if (typeof item.sha256 !== "string" || !shaPattern.test(item.sha256)) errors.push("Manifest file checksum is invalid");
      if (typeof item.sensitive !== "boolean" || item.sensitive !== isSensitiveMigrationPath(item.path)) errors.push("Manifest sensitive-file classification is invalid");
    }
    if (!seen.has(value.composeFile)) errors.push("The declared Compose file is missing from the inventory");
    if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes !== total || total < 1 || total > migrationBundleLimits.maximumTotalBytes) errors.push("Manifest total size is invalid");
  }
  if (typeof value.contentRevision !== "string" || !shaPattern.test(value.contentRevision)) {
    errors.push("Manifest content revision is invalid");
  } else {
    const { contentRevision: _contentRevision, ...revisionInput } = value;
    if (migrationBundleRevision(revisionInput) !== value.contentRevision) errors.push("Manifest content revision does not match its immutable inventory");
  }
  return [...new Set(errors)];
}

async function walkRegularFiles(root, current = "") {
  const directory = path.join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const absolute = path.join(root, ...relative.split("/"));
    if (entry.isSymbolicLink()) throw new Error("Migration bundles cannot contain symbolic links");
    if (entry.isDirectory()) files.push(...await walkRegularFiles(root, relative));
    else if (entry.isFile()) {
      const metadata = await lstat(absolute);
      if (metadata.nlink !== 1) throw new Error("Migration bundles cannot contain hard-linked files");
      files.push(relative);
    } else throw new Error("Migration bundles may contain only regular files and directories");
    if (files.length > migrationBundleLimits.maximumFiles) throw new Error("Migration bundle file limit exceeded");
  }
  return files;
}

function confined(root, relative) {
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Migration bundle path escaped its root");
  return target;
}

export async function inspectMigrationBundleDirectory(inboxRoot, bundleId) {
  if (!uuidPattern.test(bundleId)) throw new Error("Migration bundle id is invalid");
  const directory = path.resolve(inboxRoot, bundleId);
  if (path.dirname(directory) !== path.resolve(inboxRoot)) throw new Error("Migration bundle path escaped its inbox");
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Migration bundle must be a real directory");
  const manifestPath = path.join(directory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > migrationBundleLimits.maximumManifestBytes) throw new Error("Migration bundle manifest is invalid");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Migration bundle manifest is not valid JSON");
  }
  const errors = validateMigrationBundleManifest(manifest, bundleId);
  if (errors.length) throw new Error(errors.join(" | "));
  const payloadRoot = path.join(directory, "payload");
  const payloadMetadata = await lstat(payloadRoot);
  if (!payloadMetadata.isDirectory() || payloadMetadata.isSymbolicLink()) throw new Error("Migration bundle payload is invalid");
  const discovered = await walkRegularFiles(payloadRoot);
  const expected = manifest.files.map((item) => item.path);
  if (JSON.stringify(discovered) !== JSON.stringify(expected)) throw new Error("Migration bundle payload inventory does not match the manifest");
  let totalBytes = 0;
  for (const item of manifest.files) {
    const filePath = confined(payloadRoot, item.path);
    const fileMetadata = await lstat(filePath);
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.size !== item.sizeBytes || await digestFile(filePath) !== item.sha256) {
      throw new Error("Migration bundle payload checksum verification failed");
    }
    totalBytes += fileMetadata.size;
  }
  if (totalBytes !== manifest.totalBytes) throw new Error("Migration bundle payload size verification failed");
  return {
    directory,
    payloadRoot,
    manifest,
    sensitiveFileCount: manifest.files.filter((item) => item.sensitive).length,
  };
}

async function stableSourceInventory(sourceRoot) {
  const names = await walkRegularFiles(sourceRoot);
  if (!names.length) throw new Error("The source directory contains no files");
  if (names.some((name) => !safeRelativeFile(name))) throw new Error("The source contains an unsupported path");
  const composeFiles = names.filter((name) => composeNames.has(name));
  if (composeFiles.length !== 1) throw new Error("The source must contain exactly one supported Compose file at its root");
  return { names, composeFile: composeFiles[0] };
}

export async function createMigrationBundle({ sourceDirectory, workloadName, sourceFingerprint, inboxRoot = "/var/lib/boxpilot-migration/inbox", bundleId = randomUUID(), now = () => new Date() }) {
  if (!workloadPattern.test(workloadName ?? "")) throw new Error("Workload name must be a lowercase slug with letters, numbers, and hyphens");
  if (!fingerprintPattern.test(sourceFingerprint ?? "")) throw new Error("Source fingerprint must be copied exactly from the BoxPilot migration manifest");
  if (!uuidPattern.test(bundleId)) throw new Error("Bundle id is invalid");
  const sourceRoot = await realpath(path.resolve(sourceDirectory));
  const sourceMetadata = await stat(sourceRoot);
  if (!sourceMetadata.isDirectory()) throw new Error("Migration source must be a directory");
  const resolvedInbox = path.resolve(inboxRoot);
  if (sourceRoot === resolvedInbox || sourceRoot.startsWith(`${resolvedInbox}${path.sep}`) || resolvedInbox.startsWith(`${sourceRoot}${path.sep}`)) throw new Error("Migration source and inbox must be separate trees");
  await mkdir(resolvedInbox, { recursive: true, mode: 0o700 });
  await chmod(resolvedInbox, 0o700);
  const finalDirectory = path.join(resolvedInbox, bundleId);
  const partialDirectory = path.join(resolvedInbox, `${bundleId}.partial`);
  try {
    await lstat(finalDirectory);
    throw new Error("A migration bundle with this id already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await lstat(partialDirectory);
    throw new Error("A partial migration bundle with this id already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let createdPartial = false;
  try {
    const beforeInventory = await stableSourceInventory(sourceRoot);
    await mkdir(path.join(partialDirectory, "payload"), { recursive: true, mode: 0o700 });
    createdPartial = true;
    const files = [];
    let totalBytes = 0;
    for (const relative of beforeInventory.names) {
      const sourcePath = confined(sourceRoot, relative);
      const destinationPath = confined(path.join(partialDirectory, "payload"), relative);
      const before = await lstat(sourcePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Migration source changed during capture");
      const beforeDigest = await digestFile(sourcePath);
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
      const after = await lstat(sourcePath);
      const afterDigest = await digestFile(sourcePath);
      const destinationDigest = await digestFile(destinationPath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || beforeDigest !== afterDigest || beforeDigest !== destinationDigest) {
        throw new Error("Migration source changed during capture");
      }
      totalBytes += before.size;
      if (totalBytes > migrationBundleLimits.maximumTotalBytes) throw new Error("Migration bundle size limit exceeded");
      files.push({ path: relative, sensitive: isSensitiveMigrationPath(relative), sha256: beforeDigest, sizeBytes: before.size });
    }
    const afterInventory = await stableSourceInventory(sourceRoot);
    if (JSON.stringify(beforeInventory) !== JSON.stringify(afterInventory)) throw new Error("Migration source inventory changed during capture");
    const revisionInput = {
      bundleId,
      composeFile: beforeInventory.composeFile,
      createdAt: now().toISOString(),
      files,
      schemaVersion: 1,
      sourceFingerprint,
      totalBytes,
      workloadName,
    };
    const manifest = { ...revisionInput, contentRevision: migrationBundleRevision(revisionInput) };
    const manifestErrors = validateMigrationBundleManifest(manifest, bundleId);
    if (manifestErrors.length) throw new Error(manifestErrors.join(" | "));
    const manifestHandle = await open(path.join(partialDirectory, "manifest.json"), "wx", 0o600);
    await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await manifestHandle.sync();
    await manifestHandle.close();
    await rename(partialDirectory, finalDirectory);
    createdPartial = false;
    await inspectMigrationBundleDirectory(resolvedInbox, bundleId);
    return {
      bundleId,
      workloadName,
      sourceFingerprint,
      contentRevision: manifest.contentRevision,
      composeFile: manifest.composeFile,
      fileCount: manifest.files.length,
      sensitiveFileCount: manifest.files.filter((item) => item.sensitive).length,
      totalBytes,
      sourcePreserved: true,
    };
  } catch (error) {
    if (createdPartial) await rm(partialDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export const migrationBundleInternals = { canonical, confined, exactKeys, safeRelativeFile, stableSourceInventory, uuidPattern, shaPattern, fingerprintPattern, workloadPattern };
