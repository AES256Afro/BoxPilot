import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createVmMediaHelper } from "./vm-media-helper.mjs";
import { getUbuntuMediaSpec, ubuntuMediaAcquisitionPaths, ubuntuMediaCatalogRevision, ubuntuMediaPaths, validUbuntuMediaAcquisitionId } from "./ubuntu-media-spec.mjs";

const execFile = promisify(execFileCallback);

export function validateUbuntuMediaAcquireInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["An Ubuntu media acquisition object is required"];
  const errors = [];
  const expected = ["acquisitionId", "expectedCatalogRevision", "imageId"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) errors.push("Ubuntu media acquisition accepts only the fixed identity fields");
  if (!validUbuntuMediaAcquisitionId(value.acquisitionId)) errors.push("The Ubuntu media acquisition id is invalid");
  if (!getUbuntuMediaSpec(value.imageId)) errors.push("The Ubuntu media catalog id is invalid");
  if (value.expectedCatalogRevision !== ubuntuMediaCatalogRevision) errors.push("The Ubuntu media catalog revision is invalid");
  return errors;
}

async function defaultRun(binary, args, { timeout = 3 * 60 * 60 * 1000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", code: error.code ?? null };
  }
}

async function optionalMetadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function createUbuntuMediaHelper({
  paths = ubuntuMediaPaths,
  inspectMedia = () => createVmMediaHelper({ inboxRoot: paths.inboxRoot }).inspect(),
  now = () => new Date(),
  run = defaultRun,
  systemctlBinary = "/usr/bin/systemctl",
} = {}) {
  async function inspectEvidence(acquisitionId, spec) {
    const target = ubuntuMediaAcquisitionPaths(acquisitionId, spec, paths).evidence;
    const metadata = await optionalMetadata(target);
    if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 8192) return null;
    try { return JSON.parse(await readFile(target, "utf8")); } catch { return null; }
  }

  async function acquire(parameters) {
    const errors = validateUbuntuMediaAcquireInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const spec = getUbuntuMediaSpec(parameters.imageId);
    const before = await inspectMedia();
    if (before.inbox.candidates.some((item) => item.name === spec.name) || before.library.images.some((item) => item.name === spec.name)) throw new Error("Host state changed: the fixed Ubuntu ISO filename is already present");
    await mkdir(paths.inboxRoot, { recursive: true, mode: 0o700 });
    await mkdir(paths.evidenceRoot, { recursive: true, mode: 0o700 });
    for (const root of [paths.inboxRoot, paths.evidenceRoot]) {
      const metadata = await lstat(root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The fixed Ubuntu media acquisition directory is unsafe");
      await chmod(root, 0o700);
    }
    const generated = ubuntuMediaAcquisitionPaths(parameters.acquisitionId, spec, paths);
    if (await optionalMetadata(generated.evidence)) throw new Error("The Ubuntu media acquisition evidence id already exists");
    await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await writeFile(paths.approval, `${JSON.stringify({ acquisitionId: parameters.acquisitionId, approvedAt: now().toISOString(), expectedCatalogRevision: parameters.expectedCatalogRevision, imageId: parameters.imageId })}\n`, { flag: "wx", mode: 0o600 });
    await chmod(paths.approval, 0o640);
    let started;
    try {
      started = await run(systemctlBinary, ["start", "boxpilot-ubuntu-media.service"], { timeout: 3 * 60 * 60 * 1000 });
    } finally {
      await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    if (!started.ok) throw new Error("The fixed Ubuntu media acquisition service failed; generated partial files were removed and no existing media was changed");
    const [after, evidence] = await Promise.all([inspectMedia(), inspectEvidence(parameters.acquisitionId, spec)]);
    const candidate = after.inbox.candidates.find((item) => item.name === spec.name);
    if (!candidate || candidate.sizeBytes !== spec.sizeBytes || candidate.sha256 !== spec.sha256
      || evidence?.schemaVersion !== 1 || evidence?.acquisitionId !== parameters.acquisitionId || evidence?.imageId !== spec.id
      || evidence?.name !== spec.name || evidence?.sizeBytes !== spec.sizeBytes || evidence?.sha256 !== spec.sha256
      || evidence?.catalogRevision !== ubuntuMediaCatalogRevision || evidence?.sourceHost !== "releases.ubuntu.com") {
      throw new Error("The fixed Ubuntu media acquisition did not produce matching local evidence");
    }
    return {
      acquired: true,
      acquisitionId: parameters.acquisitionId,
      imageId: spec.id,
      name: spec.name,
      sizeBytes: spec.sizeBytes,
      sha256: spec.sha256,
      staged: true,
      locallyVerified: true,
      evidenceRecorded: true,
      boundary: { fixedOfficialSource: true, arbitraryUrlAccepted: false, browserDigestAccepted: false, existingMediaOverwritten: false, virtualMachineCreated: false, libvirtChanged: false, networkConfigurationChanged: false },
    };
  }

  return { acquire };
}

export const ubuntuMediaHelperInternals = { defaultRun, optionalMetadata };
