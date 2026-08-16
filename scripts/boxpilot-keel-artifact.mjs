#!/usr/local/bin/node
import { createHash } from "node:crypto";
import https from "node:https";
import { chmod, link, lstat, open, readFile, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { keelArtifactPaths, keelArtifactSpec, validUuid } from "../server/keel-artifact-spec.mjs";

const allowedRedirectHosts = new Set(["github.com", "release-assets.githubusercontent.com"]);

function parseApproval(raw, now, spec = keelArtifactSpec) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel artifact approval marker is invalid"); }
  const expectedKeys = ["acquisitionId", "approvedAt", "digest", "name", "releaseCommitSha", "releaseTag", "sizeBytes", "sourceUrl"];
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("The Keel artifact approval marker has unexpected fields");
  if (!validUuid(value.acquisitionId) || typeof value.approvedAt !== "string") throw new Error("The Keel artifact approval identity is invalid");
  if (value.digest !== spec.digest || value.name !== spec.name || value.releaseCommitSha !== spec.releaseCommitSha || value.releaseTag !== spec.releaseTag || value.sizeBytes !== spec.sizeBytes || value.sourceUrl !== spec.sourceUrl) throw new Error("The approved Keel artifact identity does not match the fixed release");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The Keel artifact approval marker is stale");
  return value;
}

function validateRequestUrl(value, redirectNumber, spec = keelArtifactSpec) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedRedirectHosts.has(url.hostname) || url.username || url.password || url.port) throw new Error("The Keel artifact redirect left the fixed HTTPS host allowlist");
  if (redirectNumber === 0 && url.href !== spec.sourceUrl) throw new Error("The Keel artifact source URL changed");
  if (redirectNumber > 0 && url.hostname !== "release-assets.githubusercontent.com") throw new Error("The Keel artifact redirect target is not the fixed GitHub release asset host");
  if (redirectNumber > 0 && !url.pathname.startsWith("/github-production-release-asset/")) throw new Error("The Keel artifact redirect path is not a GitHub release asset");
  return url;
}

function defaultRequest(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: "application/octet-stream", "User-Agent": "BoxPilot-Keel-Artifact/0.47.0" },
      timeout: 30000,
    }, resolve);
    request.once("timeout", () => request.destroy(new Error("The Keel artifact request timed out")));
    request.once("error", reject);
  });
}

async function getFixedResponse(request, spec = keelArtifactSpec) {
  let current = spec.sourceUrl;
  for (let redirectNumber = 0; redirectNumber <= 2; redirectNumber += 1) {
    const url = validateRequestUrl(current, redirectNumber, spec);
    const response = await request(url);
    const statusCode = Number(response.statusCode ?? 0);
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      if (redirectNumber >= 2 || typeof response.headers?.location !== "string") throw new Error("The Keel artifact redirect chain is invalid");
      response.resume?.();
      current = new URL(response.headers.location, url).href;
      continue;
    }
    if (statusCode !== 200) throw new Error(`The fixed Keel artifact request returned HTTP ${statusCode || "unknown"}`);
    if (redirectNumber === 0) throw new Error("The fixed GitHub release URL did not use the reviewed release-asset redirect");
    const length = Number.parseInt(String(response.headers?.["content-length"] ?? ""), 10);
    if (length !== spec.sizeBytes) throw new Error("The Keel artifact response length does not match the fixed release");
    return response;
  }
  throw new Error("The Keel artifact redirect chain exceeded its fixed limit");
}

async function optionalMetadata(filePath) {
  try { return await lstat(filePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function removeFixedRegularFile(filePath, label) {
  const metadata = await optionalMetadata(filePath);
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a real regular file`);
  await unlink(filePath);
  return true;
}

export async function acquireApprovedKeelArtifact({
  paths = keelArtifactPaths,
  spec = keelArtifactSpec,
  loadApproval = () => readFile(paths.approval, "utf8"),
  request = defaultRequest,
  now = () => new Date(),
} = {}) {
  const approval = parseApproval(await loadApproval(), now(), spec);
  const root = await lstat(paths.root);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("The fixed Keel artifact root is not a real directory");
  await chmod(paths.root, 0o700);
  const finalArchive = await optionalMetadata(paths.archive);
  if (finalArchive) throw new Error("The fixed Keel artifact already exists and will not be overwritten");
  const finalEvidence = await optionalMetadata(paths.evidence);
  if (finalEvidence) throw new Error("Keel artifact evidence already exists without an acquirable archive");
  const stalePartialRemoved = await removeFixedRegularFile(paths.partial, "The fixed Keel artifact partial file");
  await removeFixedRegularFile(paths.evidencePartial, "The fixed Keel artifact evidence partial file");

  let archiveLinked = false;
  let evidenceLinked = false;
  let archiveHandle;
  try {
    archiveHandle = await open(paths.partial, "wx", 0o600);
    const response = await getFixedResponse(request, spec);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const rawChunk of response) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      sizeBytes += chunk.length;
      if (sizeBytes > spec.sizeBytes) throw new Error("The Keel artifact response exceeded the fixed release size");
      hash.update(chunk);
      await archiveHandle.write(chunk);
    }
    if (sizeBytes !== spec.sizeBytes) throw new Error("The Keel artifact byte count does not match the fixed release");
    const sha256 = hash.digest("hex");
    if (sha256 !== spec.digest.slice("sha256:".length)) throw new Error("The Keel artifact SHA-256 does not match the fixed release");
    await archiveHandle.sync();
    await archiveHandle.close();
    archiveHandle = null;
    await chmod(paths.partial, 0o600);

    const downloadedAt = now().toISOString();
    const evidence = {
      schemaVersion: 1,
      acquisitionId: approval.acquisitionId,
      repository: spec.repository,
      releaseTag: spec.releaseTag,
      releaseCommitSha: spec.releaseCommitSha,
      name: spec.name,
      sizeBytes,
      sha256,
      downloadedAt,
      source: "fixed-github-release",
      redirectHosts: ["github.com", "release-assets.githubusercontent.com"],
      extractionPerformed: false,
      archiveExecuted: false,
      applicationInstalled: false,
    };
    await writeFile(paths.evidencePartial, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const evidenceHandle = await open(paths.evidencePartial, "r");
    try { await evidenceHandle.sync(); } finally { await evidenceHandle.close(); }
    await link(paths.partial, paths.archive);
    archiveLinked = true;
    await link(paths.evidencePartial, paths.evidence);
    evidenceLinked = true;
    await unlink(paths.partial);
    await unlink(paths.evidencePartial);
    return { acquisitionId: approval.acquisitionId, sizeBytes, sha256, downloadedAt, stalePartialRemoved };
  } catch (error) {
    if (archiveHandle) await archiveHandle.close().catch(() => {});
    if (evidenceLinked) await unlink(paths.evidence).catch(() => {});
    if (archiveLinked) await unlink(paths.archive).catch(() => {});
    await unlink(paths.partial).catch(() => {});
    await unlink(paths.evidencePartial).catch(() => {});
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Keel artifact acquisition accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await acquireApprovedKeelArtifact();
      console.log(`Verified fixed Keel artifact ${result.acquisitionId} (${result.sizeBytes} bytes)`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const keelArtifactScriptInternals = { allowedRedirectHosts, getFixedResponse, parseApproval, removeFixedRegularFile, validateRequestUrl };
