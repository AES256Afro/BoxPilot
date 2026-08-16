import { lstat, readFile } from "node:fs/promises";
import { keelInstallPaths, keelServiceIdentity } from "./keel-install-spec.mjs";

const proofKeys = [
  "applicationId",
  "boxpilotCredentialAccess",
  "credentialsStored",
  "databaseDevice",
  "databaseInode",
  "endpoint",
  "loginProtocol",
  "logoutVerified",
  "ownerRoute",
  "ownerRouteVerified",
  "releaseVersion",
  "schemaVersion",
  "secondFactorRequired",
  "sessionStored",
  "terminalOnly",
  "verifiedAt",
];

function boundary() {
  return {
    mutationPerformed: false,
    credentialRead: false,
    sessionRead: false,
    applicationStateContentRead: false,
    databaseMetadataRead: true,
    databaseOpened: false,
    secretRead: false,
    arbitraryPathAccepted: false,
    arbitraryCommandAccepted: false,
    browserInputAccepted: false,
  };
}

export function exactKeelOwnerLoginProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === proofKeys.length
    && keys.every((key, index) => key === proofKeys[index])
    && value.schemaVersion === 1
    && value.applicationId === "keel"
    && value.releaseVersion === keelServiceIdentity.releaseVersion
    && value.endpoint === `http://${keelServiceIdentity.bindAddress}:${keelServiceIdentity.port}`
    && value.loginProtocol === "keel-server-action"
    && value.ownerRoute === "/api/admin/server"
    && value.ownerRouteVerified === true
    && value.logoutVerified === true
    && value.credentialsStored === false
    && Number.isSafeInteger(value.databaseDevice) && value.databaseDevice >= 0
    && Number.isSafeInteger(value.databaseInode) && value.databaseInode > 0
    && value.sessionStored === false
    && value.secondFactorRequired === false
    && value.terminalOnly === true
    && value.boxpilotCredentialAccess === false
    && typeof value.verifiedAt === "string"
    && Number.isFinite(Date.parse(value.verifiedAt));
}

export function createKeelLoginProofHelper({
  proofPath = keelInstallPaths.loginProof,
  databasePath = keelInstallPaths.database,
  expectedRootUid = 0,
  expectedRootGid = 0,
  maximumBytes = 4096,
} = {}) {
  async function inspect() {
    try {
      const metadata = await lstat(proofPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || metadata.uid !== expectedRootUid || metadata.gid !== expectedRootGid
        || (metadata.mode & 0o7777) !== 0o600 || metadata.size > maximumBytes) {
        return {
          state: "invalid", verified: false, verifiedAt: null, releaseVersion: null,
          detail: "Keel owner-login proof exists but does not match the fixed root-only evidence boundary",
          boundary: boundary(),
        };
      }
      let proof;
      try { proof = JSON.parse(await readFile(proofPath, "utf8")); } catch { proof = null; }
      if (!exactKeelOwnerLoginProof(proof)) {
        return {
          state: "invalid", verified: false, verifiedAt: null, releaseVersion: null,
          detail: "Keel owner-login proof exists but its sanitized evidence is incomplete or changed",
          boundary: boundary(),
        };
      }
      let database;
      try { database = await lstat(databasePath); } catch { database = null; }
      const currentStateMatched = Boolean(database?.isFile() && !database.isSymbolicLink() && database.nlink === 1
        && database.dev === proof.databaseDevice && database.ino === proof.databaseInode);
      if (!currentStateMatched) {
        return {
          state: "stale", verified: false, verifiedAt: proof.verifiedAt, releaseVersion: proof.releaseVersion,
          ownerRouteVerified: true, logoutVerified: true, currentStateMatched: false,
          credentialsStored: false, sessionStored: false,
          detail: "The prior Keel owner-login proof is sanitized and exact, but the active database identity changed; rerun terminal proof for the current state",
          boundary: boundary(),
        };
      }
      return {
        state: "verified",
        verified: true,
        verifiedAt: proof.verifiedAt,
        releaseVersion: proof.releaseVersion,
        ownerRouteVerified: true,
        logoutVerified: true,
        terminalOnly: true,
        credentialsStored: false,
        sessionStored: false,
        secondFactorRequired: false,
        currentStateMatched: true,
        detail: "A terminal-only Keel instance-owner login and immediate logout were verified without exposing credentials or a session to BoxPilot",
        boundary: boundary(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          state: "not-run", verified: false, verifiedAt: null, releaseVersion: null,
          detail: "No terminal-only Keel instance-owner login proof has been recorded",
          boundary: boundary(),
        };
      }
      return {
        state: "unavailable", verified: false, verifiedAt: null, releaseVersion: null,
        detail: "The fixed root-only Keel owner-login proof could not be inspected safely",
        boundary: boundary(),
      };
    }
  }

  return { inspect };
}

export const keelLoginProofHelperInternals = { boundary, proofKeys };
