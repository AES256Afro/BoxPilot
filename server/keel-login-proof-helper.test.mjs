// @vitest-environment node
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeelLoginProofHelper, exactKeelOwnerLoginProof } from "./keel-login-proof-helper.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop(), { recursive: true, force: true });
});

function proof(overrides = {}) {
  return {
    schemaVersion: 1,
    applicationId: "keel",
    releaseVersion: "1.2.6",
    verifiedAt: "2026-08-16T20:00:00.000Z",
    endpoint: "http://127.0.0.1:3000",
    loginProtocol: "keel-server-action",
    ownerRoute: "/api/admin/server",
    ownerRouteVerified: true,
    logoutVerified: true,
    credentialsStored: false,
    databaseDevice: 1,
    databaseInode: 2,
    sessionStored: false,
    secondFactorRequired: false,
    terminalOnly: true,
    boxpilotCredentialAccess: false,
    ...overrides,
  };
}

describe("Keel owner-login proof inspection", () => {
  it("publishes only exact sanitized root-only proof", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-login-proof-helper-"));
    cleanup.push(temporary);
    const proofPath = path.join(temporary, "latest.json");
    const databasePath = path.join(temporary, "keel.db");
    await writeFile(databasePath, "database fixture", { mode: 0o600 });
    const database = await lstat(databasePath);
    await writeFile(proofPath, `${JSON.stringify(proof({ databaseDevice: database.dev, databaseInode: database.ino }))}\n`, { mode: 0o600 });
    await chmod(proofPath, 0o600);
    const helper = createKeelLoginProofHelper({ proofPath, databasePath, expectedRootUid: process.getuid(), expectedRootGid: process.getgid() });
    await expect(helper.inspect()).resolves.toMatchObject({
      state: "verified", verified: true, releaseVersion: "1.2.6", ownerRouteVerified: true,
      logoutVerified: true, currentStateMatched: true, credentialsStored: false, sessionStored: false,
      boundary: { mutationPerformed: false, credentialRead: false, sessionRead: false },
    });
    await rename(databasePath, path.join(temporary, "prior-keel.db"));
    await writeFile(databasePath, "replaced database fixture", { mode: 0o600 });
    await expect(helper.inspect()).resolves.toMatchObject({ state: "stale", verified: false, currentStateMatched: false });
  });

  it("distinguishes absent, unsafe, and semantically changed evidence", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-login-proof-helper-"));
    cleanup.push(temporary);
    const proofPath = path.join(temporary, "latest.json");
    const helper = createKeelLoginProofHelper({ proofPath, expectedRootUid: process.getuid(), expectedRootGid: process.getgid() });
    await expect(helper.inspect()).resolves.toMatchObject({ state: "not-run", verified: false });
    await writeFile(proofPath, `${JSON.stringify(proof())}\n`, { mode: 0o644 });
    await chmod(proofPath, 0o644);
    await expect(helper.inspect()).resolves.toMatchObject({ state: "invalid", verified: false });
    await writeFile(proofPath, `${JSON.stringify(proof({ credentialsStored: true }))}\n`, { mode: 0o600 });
    await chmod(proofPath, 0o600);
    await expect(helper.inspect()).resolves.toMatchObject({ state: "invalid", verified: false });
    expect(exactKeelOwnerLoginProof(proof({ email: "owner@example.test" }))).toBe(false);
    expect(exactKeelOwnerLoginProof(proof({ session: "secret" }))).toBe(false);
  });
});
