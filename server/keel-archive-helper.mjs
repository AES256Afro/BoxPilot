import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { keelArtifactPaths, keelArtifactSpec } from "./keel-artifact-spec.mjs";

const blockSize = 512;
const defaultLimits = Object.freeze({ maxMembers: 10000, maxUncompressedBytes: 2 * 1024 * 1024 * 1024 });

class ArchiveInspectionError extends Error {
  constructor(risk) {
    super(risk);
    this.risk = risk;
  }
}

function emptyCounts() {
  return { regular: 0, directory: 0, symbolicLink: 0, hardLink: 0, blockDevice: 0, characterDevice: 0, fifo: 0, contiguous: 0, extension: 0, unknown: 0 };
}

function boundary() {
  return {
    mutationPerformed: false,
    extractionPerformed: false,
    archiveExecuted: false,
    applicationInstalled: false,
    serviceChanged: false,
    arbitraryPathAccepted: false,
    archiveMemberNamesReturned: false,
    linkTargetsReturned: false,
    memberContentsReturned: false,
  };
}

function parseString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function parseOctal(block, offset, length, label) {
  const field = block.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) throw new ArchiveInspectionError(`unsupported-base256-${label}`);
  const text = field.toString("ascii").replace(/\0/g, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new ArchiveInspectionError(`invalid-${label}`);
  const value = text === "" ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new ArchiveInspectionError(`invalid-${label}`);
  return value;
}

function validChecksum(block) {
  let sum = 0;
  for (let index = 0; index < block.length; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index];
  return sum === parseOctal(block, 148, 8, "header-checksum");
}

function pathRisks(value, suffix = "member") {
  const risks = [];
  const ending = suffix === "link-target" ? suffix : `${suffix}-path`;
  if (!value || value.includes("\uFFFD") || /[\x00-\x1f\x7f]/.test(value)) risks.push(`invalid-${ending}`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) risks.push(`absolute-${ending}`);
  if (value.includes("\\")) risks.push(`backslash-${ending}`);
  const normalized = value.replace(/\/+$/, "");
  const segments = normalized.replace(/^\/+/, "").split("/");
  if (segments.includes("..")) risks.push(`parent-traversal-${ending}`);
  if (segments.includes("") || segments.includes(".")) risks.push(`noncanonical-${ending}`);
  return risks;
}

function createTarInspector({ expectedRoot, expectedMembers, limits = defaultLimits }) {
  let carry = Buffer.alloc(0);
  let skipBytes = 0;
  let capture = null;
  let pendingLongName = null;
  let pendingLongLink = null;
  let zeroBlocks = 0;
  let footerReached = false;
  let tarBytes = 0;
  let memberCount = 0;
  let totalFileBytes = 0;
  const names = new Set();
  const roots = new Set();
  const risks = new Set();
  const counts = emptyCounts();

  function addRisk(risk) {
    risks.add(risk);
  }

  function finishCapture() {
    if (!capture) return;
    const payload = Buffer.concat(capture.chunks, capture.size);
    const firstNul = payload.indexOf(0);
    const end = firstNul === -1 ? payload.length : firstNul;
    if (firstNul !== -1 && payload.subarray(firstNul).some((value) => value !== 0)) throw new ArchiveInspectionError("invalid-gnu-extension-payload");
    const value = payload.subarray(0, end).toString("utf8").replace(/\n$/, "");
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new ArchiveInspectionError("invalid-gnu-extension-payload");
    if (capture.type === "L") {
      if (pendingLongName !== null) throw new ArchiveInspectionError("duplicate-long-name-extension");
      pendingLongName = value;
    } else {
      if (pendingLongLink !== null) throw new ArchiveInspectionError("duplicate-long-link-extension");
      pendingLongLink = value;
    }
    capture = null;
  }

  function inspectHeader(header) {
    if (!validChecksum(header)) throw new ArchiveInspectionError("header-checksum-mismatch");
    const name = parseString(header, 0, 100);
    const prefix = parseString(header, 345, 155);
    const headerName = prefix ? `${prefix}/${name}` : name;
    const mode = parseOctal(header, 100, 8, "member-mode");
    const size = parseOctal(header, 124, 12, "member-size");
    const type = String.fromCharCode(header[156] || 48);
    const headerLinkTarget = parseString(header, 157, 100);

    if (["L", "K"].includes(type)) {
      counts.extension += 1;
      if (size <= 0 || size > 65536) throw new ArchiveInspectionError("gnu-extension-size-limit-exceeded");
      capture = { type, size, captured: 0, chunks: [] };
      skipBytes = Math.ceil(size / blockSize) * blockSize;
      return;
    }
    if (["x", "g"].includes(type)) {
      counts.extension += 1;
      addRisk("pax-extension-member");
      skipBytes = Math.ceil(size / blockSize) * blockSize;
      return;
    }

    const memberName = pendingLongName ?? headerName;
    const linkTarget = pendingLongLink ?? headerLinkTarget;
    if (pendingLongLink !== null && !["1", "2"].includes(type)) addRisk("unexpected-long-link-extension");
    pendingLongName = null;
    pendingLongLink = null;

    memberCount += 1;
    if (memberCount > limits.maxMembers) throw new ArchiveInspectionError("member-count-limit-exceeded");
    totalFileBytes += size;
    if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > limits.maxUncompressedBytes) throw new ArchiveInspectionError("uncompressed-size-limit-exceeded");
    for (const risk of pathRisks(memberName)) addRisk(risk);
    const normalized = memberName.replace(/\/+$/, "");
    const canonicalName = normalized.replace(/^\/+/, "").split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
    if (names.has(canonicalName)) addRisk("duplicate-member-path");
    names.add(canonicalName);
    const firstSegment = normalized.split("/")[0];
    if (firstSegment) roots.add(firstSegment);
    if ((mode & 0o6000) !== 0) addRisk("privileged-mode-member");
    if (type !== "0" && size !== 0) addRisk("nonregular-member-payload");

    if (type === "0") counts.regular += 1;
    else if (type === "5") counts.directory += 1;
    else if (type === "2") {
      counts.symbolicLink += 1;
      addRisk("symbolic-link-member");
      for (const risk of pathRisks(linkTarget, "link-target")) addRisk(risk);
    } else if (type === "1") {
      counts.hardLink += 1;
      addRisk("hard-link-member");
      for (const risk of pathRisks(linkTarget, "link-target")) addRisk(risk);
    } else if (type === "3") {
      counts.characterDevice += 1;
      addRisk("character-device-member");
    } else if (type === "4") {
      counts.blockDevice += 1;
      addRisk("block-device-member");
    } else if (type === "6") {
      counts.fifo += 1;
      addRisk("fifo-member");
    } else if (type === "7") {
      counts.contiguous += 1;
      addRisk("contiguous-file-member");
    } else {
      counts.unknown += 1;
      addRisk("unknown-member-type");
    }
    skipBytes = Math.ceil(size / blockSize) * blockSize;
  }

  function feed(chunk) {
    tarBytes += chunk.length;
    if (!Number.isSafeInteger(tarBytes) || tarBytes > limits.maxUncompressedBytes + limits.maxMembers * blockSize * 2 + blockSize * 2) throw new ArchiveInspectionError("tar-stream-size-limit-exceeded");
    carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    while (carry.length > 0) {
      if (skipBytes > 0) {
        const consumed = Math.min(skipBytes, carry.length);
        if (capture && capture.captured < capture.size) {
          const captured = Math.min(consumed, capture.size - capture.captured);
          capture.chunks.push(Buffer.from(carry.subarray(0, captured)));
          capture.captured += captured;
        }
        carry = carry.subarray(consumed);
        skipBytes -= consumed;
        if (skipBytes === 0) finishCapture();
        continue;
      }
      if (carry.length < blockSize) return;
      const block = carry.subarray(0, blockSize);
      carry = carry.subarray(blockSize);
      const zero = block.every((value) => value === 0);
      if (footerReached) {
        if (!zero) addRisk("nonzero-trailing-data");
        continue;
      }
      if (zero) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) footerReached = true;
        continue;
      }
      if (zeroBlocks > 0) addRisk("incomplete-end-marker");
      zeroBlocks = 0;
      inspectHeader(block);
    }
  }

  function finish() {
    if (skipBytes !== 0 || carry.length !== 0) addRisk("truncated-tar-stream");
    if (capture || pendingLongName !== null || pendingLongLink !== null) addRisk("orphaned-archive-extension");
    if (!footerReached) addRisk("missing-end-marker");
    if (memberCount !== expectedMembers) addRisk("unexpected-member-count");
    if (roots.size !== 1 || !roots.has(expectedRoot)) addRisk("unexpected-archive-root");
    return { memberCount, totalFileBytes, counts, risks: [...risks].sort() };
  }

  return { feed, finish };
}

async function hashHandle(fileHandle, sizeBytes) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < sizeBytes) {
    const { bytesRead } = await fileHandle.read(buffer, 0, Math.min(buffer.length, sizeBytes - offset), offset);
    if (bytesRead === 0) throw new ArchiveInspectionError("compressed-archive-truncated");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function* readHandle(fileHandle, sizeBytes) {
  const bufferSize = 1024 * 1024;
  let offset = 0;
  while (offset < sizeBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(bufferSize, sizeBytes - offset));
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) throw new ArchiveInspectionError("compressed-archive-truncated");
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function inspectVerifiedArchive({ archivePath, spec, limits }) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fileHandle = await open(archivePath, flags);
  try {
    const before = await fileHandle.stat();
    if (!before.isFile()) throw new ArchiveInspectionError("artifact-not-regular-file");
    if (before.size !== spec.sizeBytes) throw new ArchiveInspectionError("compressed-size-mismatch");
    const sha256 = await hashHandle(fileHandle, before.size);
    if (sha256 !== spec.digest.slice("sha256:".length)) throw new ArchiveInspectionError("compressed-digest-mismatch");

    const parser = createTarInspector({ expectedRoot: spec.archiveRoot, expectedMembers: spec.archiveMembersObservedDuringAdapterReview, limits });
    const gunzip = createGunzip();
    const source = Readable.from(readHandle(fileHandle, before.size));
    source.pipe(gunzip);
    try {
      for await (const chunk of gunzip) parser.feed(chunk);
    } catch (error) {
      source.destroy();
      if (error instanceof ArchiveInspectionError) throw error;
      throw new ArchiveInspectionError("gzip-decompression-failed");
    }
    const after = await fileHandle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ArchiveInspectionError("artifact-changed-during-inspection");
    return parser.finish();
  } finally {
    await fileHandle.close();
  }
}

export function createKeelArchiveHelper({ paths = keelArtifactPaths, spec = keelArtifactSpec, limits = defaultLimits, inspectArchive = inspectVerifiedArchive } = {}) {
  async function inspect() {
    try {
      const result = await inspectArchive({ archivePath: paths.archive, spec, limits });
      const safeToExtract = result.risks.length === 0;
      return {
        state: safeToExtract ? "safe" : "blocked",
        safeToExtract,
        artifactLocallyVerified: true,
        expectedRoot: spec.archiveRoot,
        expectedMemberCount: spec.archiveMembersObservedDuringAdapterReview,
        ...result,
        detail: safeToExtract
          ? "The exact fixed archive passed bounded membership inspection; extraction is still disabled"
          : "The exact fixed archive contains blocked member types, paths, links, or structure and will not be extracted",
        boundary: boundary(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          state: "artifact-required", safeToExtract: false, artifactLocallyVerified: false,
          expectedRoot: spec.archiveRoot, expectedMemberCount: spec.archiveMembersObservedDuringAdapterReview,
          memberCount: 0, totalFileBytes: 0, counts: emptyCounts(), risks: ["artifact-required"],
          detail: "Acquire and locally verify the fixed root-only Keel archive before membership inspection",
          boundary: boundary(),
        };
      }
      const risk = error instanceof ArchiveInspectionError ? error.risk : "archive-inspection-unavailable";
      return {
        state: "blocked", safeToExtract: false, artifactLocallyVerified: false,
        expectedRoot: spec.archiveRoot, expectedMemberCount: spec.archiveMembersObservedDuringAdapterReview,
        memberCount: 0, totalFileBytes: 0, counts: emptyCounts(), risks: [risk],
        detail: "The fixed Keel archive could not be verified and inspected safely",
        boundary: boundary(),
      };
    }
  }

  return { inspect };
}

export const keelArchiveHelperInternals = { ArchiveInspectionError, boundary, createTarInspector, defaultLimits, emptyCounts, inspectVerifiedArchive, parseOctal, pathRisks, validChecksum };
