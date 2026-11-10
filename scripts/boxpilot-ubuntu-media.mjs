#!/usr/local/bin/node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import https from "node:https";
import { chmod, link, lstat, mkdir, open, readFile, statfs, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { getUbuntuMediaSpec, ubuntuMediaAcquisitionPaths, ubuntuMediaCatalogRevision, ubuntuMediaPaths, validUbuntuMediaAcquisitionId } from "../server/ubuntu-media-spec.mjs";

const reserveBytes = 1024 ** 3;

function parseApproval(raw, now, { resolveSpec = getUbuntuMediaSpec, catalogRevision = ubuntuMediaCatalogRevision } = {}) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Ubuntu media approval marker is invalid"); }
  const expected = ["acquisitionId", "approvedAt", "expectedCatalogRevision", "imageId"];
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("The Ubuntu media approval marker has unexpected fields");
  if (!validUbuntuMediaAcquisitionId(value.acquisitionId) || !resolveSpec(value.imageId) || value.expectedCatalogRevision !== catalogRevision) throw new Error("The Ubuntu media approval identity does not match the fixed catalog");
  const approvedAt = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedAt;
  if (!Number.isFinite(approvedAt) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The Ubuntu media approval marker is stale");
  return value;
}

function validateSourceUrl(spec) {
  const url = new URL(spec.sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "releases.ubuntu.com" || url.username || url.password || url.port || url.href !== spec.sourceUrl) throw new Error("The Ubuntu media source left the fixed official HTTPS location");
  return url;
}

function defaultRequest(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: "application/x-iso9660-image", "User-Agent": "BoxPilot-Ubuntu-Media/0.62.0" }, timeout: 30000 }, resolve);
    request.once("timeout", () => request.destroy(new Error("The Ubuntu media request timed out")));
    request.once("error", reject);
  });
}

async function getFixedResponse(request, spec) {
  const response = await request(validateSourceUrl(spec));
  const status = Number(response.statusCode ?? 0);
  if (status !== 200) {
    response.resume?.();
    throw new Error(`The fixed Ubuntu media request returned HTTP ${status || "unknown"}`);
  }
  const length = Number.parseInt(String(response.headers?.["content-length"] ?? ""), 10);
  if (length !== spec.sizeBytes) throw new Error("The Ubuntu media response length does not match the fixed catalog");
  response.setTimeout?.(30000, () => response.destroy(new Error("The Ubuntu media response timed out")));
  return response;
}

async function optionalMetadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function sha256File(target) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  return digest.digest("hex");
}

export async function acquireApprovedUbuntuMedia({
  paths = ubuntuMediaPaths,
  loadApproval = () => readFile(paths.approval, "utf8"),
  request = defaultRequest,
  now = () => new Date(),
  resolveSpec = getUbuntuMediaSpec,
  catalogRevision = ubuntuMediaCatalogRevision,
} = {}) {
  const approval = parseApproval(await loadApproval(), now(), { resolveSpec, catalogRevision });
  const spec = resolveSpec(approval.imageId);
  await mkdir(paths.inboxRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.evidenceRoot, { recursive: true, mode: 0o700 });
  for (const root of [paths.inboxRoot, paths.evidenceRoot]) {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The fixed Ubuntu media acquisition directory is unsafe");
    await chmod(root, 0o700);
  }
  const available = await statfs(paths.inboxRoot);
  const availableBytes = Number(available.bavail) * Number(available.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < spec.sizeBytes + reserveBytes) throw new Error("The VM media staging area lacks the fixed 1 GiB post-download reserve");
  const generated = ubuntuMediaAcquisitionPaths(approval.acquisitionId, spec, paths);
  for (const [label, target] of Object.entries(generated)) if (await optionalMetadata(target)) throw new Error(`The generated Ubuntu media ${label} path is already occupied`);
  const digest = createHash("sha256");
  let sizeBytes = 0;
  let targetPublished = false;
  let metadataPublished = false;
  let evidencePublished = false;
  try {
    const response = await getFixedResponse(request, spec);
    const meter = async function* () {
      for await (const raw of response) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        sizeBytes += chunk.length;
        if (sizeBytes > spec.sizeBytes) throw new Error("The Ubuntu media response exceeded the fixed catalog size");
        digest.update(chunk);
        yield chunk;
      }
    };
    await pipeline(meter(), createWriteStream(generated.partial, { flags: "wx", mode: 0o600 }));
    if (sizeBytes !== spec.sizeBytes) throw new Error("The Ubuntu media byte count does not match the fixed catalog");
    const sha256 = digest.digest("hex");
    if (sha256 !== spec.sha256) throw new Error("The Ubuntu media SHA-256 does not match the fixed catalog");
    const dataHandle = await open(generated.partial, "r");
    try { await dataHandle.sync(); } finally { await dataHandle.close(); }
    if (await sha256File(generated.partial) !== spec.sha256) throw new Error("The complete local Ubuntu media hash did not match after write");
    const downloadedAt = now().toISOString();
    await writeFile(generated.metadataPartial, `${JSON.stringify({ schemaVersion: 1, name: spec.name, sizeBytes, sha256, uploadedAt: downloadedAt, source: "fixed-ubuntu-release", imageId: spec.id, acquisitionId: approval.acquisitionId })}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(generated.evidencePartial, `${JSON.stringify({ schemaVersion: 1, acquisitionId: approval.acquisitionId, imageId: spec.id, catalogRevision, name: spec.name, sizeBytes, sha256, downloadedAt, sourceHost: "releases.ubuntu.com", checksumUrl: spec.checksumUrl, signatureUrl: spec.signatureUrl, staged: true, imported: false, virtualMachineCreated: false }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    for (const target of [generated.metadataPartial, generated.evidencePartial]) {
      const handle = await open(target, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await link(generated.partial, generated.target);
    targetPublished = true;
    await link(generated.metadataPartial, generated.metadata);
    metadataPublished = true;
    await link(generated.evidencePartial, generated.evidence);
    evidencePublished = true;
    await unlink(generated.partial);
    await unlink(generated.metadataPartial);
    await unlink(generated.evidencePartial);
    return { acquisitionId: approval.acquisitionId, imageId: spec.id, sizeBytes, sha256, downloadedAt };
  } catch (error) {
    if (evidencePublished) await unlink(generated.evidence).catch(() => {});
    if (metadataPublished) await unlink(generated.metadata).catch(() => {});
    if (targetPublished) await unlink(generated.target).catch(() => {});
    await Promise.allSettled([unlink(generated.partial), unlink(generated.metadataPartial), unlink(generated.evidencePartial)]);
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Ubuntu media acquisition accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await acquireApprovedUbuntuMedia();
      console.log(`Verified fixed Ubuntu media ${result.acquisitionId} (${result.sizeBytes} bytes)`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const ubuntuMediaScriptInternals = { defaultRequest, getFixedResponse, optionalMetadata, parseApproval, reserveBytes, sha256File, validateSourceUrl };
