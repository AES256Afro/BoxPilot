// @vitest-environment node
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keelArtifactSpec } from "../server/keel-artifact-spec.mjs";
import {
  keelEnvironmentContent,
  keelEnvironmentSha256,
  keelServiceIdentity,
  keelServiceUnitSha256,
} from "../server/keel-install-spec.mjs";
import {
  authenticateKeelOwner,
  extractServerAction,
  KeelSecondFactorRequiredError,
  persistSanitizedProof,
  runKeelOwnerLoginProof,
  updateCookieJar,
} from "./boxpilot-keel-owner-login-proof.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop(), { recursive: true, force: true });
});

function exactProof(overrides = {}) {
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

function loginHtml() {
  return '<html><form action="" method="POST"><input type="hidden" name="$ACTION_REF_1"><input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;60151db4ae6b34a5a383fe819bf2a29f1ff865bc8a&quot;,&quot;bound&quot;:&quot;$@1&quot;}"><input type="hidden" name="$ACTION_1:1" value="[&quot;$undefined&quot;]"><input type="hidden" name="$ACTION_KEY" value="0123456789abcdef0123456789abcdef"><h2>Sign in</h2></form></html>';
}

function workspaceHtml() {
  return '<html><script>self.__next_f.push([1,"13:{\\"id\\":\\"004be8b509ad9673df83531c4f4d982e2c797557e0\\",\\"bound\\":null}\\n3:{\\"logoutAction\\":\\"$h13\\"}"])</script></html>';
}

function successfulFetch({ ownerStatus = 200 } = {}) {
  let ownerChecks = 0;
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/login" && !init.method) return new Response(loginHtml(), { status: 200 });
    if (pathname === "/login" && init.method === "POST") {
      expect(init.body.get("$ACTION_REF_1")).toBe("");
      expect(init.body.get("$ACTION_1:0")).toContain("60151db4ae6b34a5a383fe819bf2a29f1ff865bc8a");
      expect(init.body.get("$ACTION_1:1")).toBe('["$undefined"]');
      expect(init.body.get("$ACTION_KEY")).toBe("0123456789abcdef0123456789abcdef");
      expect(init.body.get("email")).toBe("owner@example.test");
      expect(init.body.get("password")).toBe("correct horse battery staple");
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": "keel_session=session-secret; HttpOnly; Path=/; SameSite=Lax" } });
    }
    if (pathname === "/api/admin/server") {
      ownerChecks += 1;
      expect(init.headers.Cookie).toBe("keel_session=session-secret");
      if (ownerChecks === 1) return new Response(JSON.stringify(ownerStatus === 200 ? { version: "1.2.6", supervised: true } : { error: "This is restricted to the instance owner" }), { status: ownerStatus, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (pathname === "/" && !init.method) {
      const response = new Response(workspaceHtml(), { status: 200 });
      Object.defineProperty(response, "url", { value: "http://127.0.0.1:3000/p/test-page" });
      return response;
    }
    if (pathname === "/p/test-page" && init.method === "POST") {
      expect(init.body.get("$ACTION_ID_004be8b509ad9673df83531c4f4d982e2c797557e0")).toBe("");
      expect(init.headers.Cookie).toBe("keel_session=session-secret");
      return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": "keel_session=; Max-Age=0; Path=/" } });
    }
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${pathname}`);
  });
  return { calls, fetchImpl };
}

async function boundaryFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-owner-login-proof-"));
  cleanup.push(temporary);
  const uid = process.getuid();
  const gid = process.getgid();
  const paths = {
    root: path.join(temporary, "managed", "keel"),
    release: path.join(temporary, "managed", "keel", "releases", "1.2.6"),
    current: path.join(temporary, "managed", "keel", "current"),
    evidence: path.join(temporary, "managed", "keel", ".boxpilot-install.json"),
    state: path.join(temporary, "state"),
    environment: path.join(temporary, "state", ".env"),
    database: path.join(temporary, "state", "keel.db"),
  };
  await mkdir(paths.release, { recursive: true, mode: 0o750 });
  await mkdir(paths.state, { mode: 0o700 });
  await symlink(path.relative(path.dirname(paths.current), paths.release), paths.current);
  await writeFile(paths.environment, keelEnvironmentContent(), { mode: 0o640 });
  await writeFile(paths.database, "sqlite fixture", { mode: 0o600 });
  await writeFile(paths.evidence, `${JSON.stringify({
    schemaVersion: 1,
    installId: "11111111-1111-4111-8111-111111111111",
    installedAt: "2026-08-16T14:00:00.000Z",
    releaseTag: keelArtifactSpec.releaseTag,
    releaseCommitSha: keelArtifactSpec.releaseCommitSha,
    releaseVersion: keelServiceIdentity.releaseVersion,
    releasePath: paths.release,
    statePath: paths.state,
    unitName: keelServiceIdentity.unitName,
    unitSha256: keelServiceUnitSha256,
    environmentSha256: keelEnvironmentSha256,
    bindAddress: keelServiceIdentity.bindAddress,
    port: keelServiceIdentity.port,
    healthIdentityVerified: true,
    claimRequired: true,
  })}\n`, { mode: 0o640 });
  await chmod(paths.environment, 0o640);
  await chmod(paths.database, 0o600);
  await chmod(paths.evidence, 0o640);
  return { gid, paths, temporary, uid };
}

describe("Keel terminal-only owner-login proof", () => {
  it("parses only one exact server action and manages cookies without exposing them", () => {
    expect(extractServerAction(loginHtml(), { formText: "Sign in" })).toEqual({ fields: [
      ["$ACTION_REF_1", ""],
      ["$ACTION_1:0", '{"id":"60151db4ae6b34a5a383fe819bf2a29f1ff865bc8a","bound":"$@1"}'],
      ["$ACTION_1:1", '["$undefined"]'],
      ["$ACTION_KEY", "0123456789abcdef0123456789abcdef"],
    ] });
    expect(extractServerAction(workspaceHtml(), { formText: "Sign out", serializedProperty: "logoutAction" })).toEqual({ fields: [["$ACTION_ID_004be8b509ad9673df83531c4f4d982e2c797557e0", ""]] });
    expect(() => extractServerAction("<html></html>")).toThrow("bounded Keel login");
    expect(() => extractServerAction('<form><input name="$ACTION_BAD" value="x"><h2>Sign in</h2></form>', { formText: "Sign in" })).toThrow("unsupported Server Action");
    const jar = new Map();
    updateCookieJar(jar, new Headers({ "Set-Cookie": "keel_session=secret; HttpOnly; Path=/" }));
    expect(jar.get("keel_session")).toBe("secret");
    updateCookieJar(jar, new Headers({ "Set-Cookie": "keel_session=; Max-Age=0; Path=/" }));
    expect(jar.has("keel_session")).toBe(false);
  });

  it("submits the real action marker, proves instance-owner access, logs out, and verifies revocation", async () => {
    const { fetchImpl } = successfulFetch();
    await expect(authenticateKeelOwner({
      fetchImpl,
      credentials: { email: "OWNER@example.test", password: "correct horse battery staple" },
      now: () => new Date("2026-08-16T20:00:00.000Z"),
      inspectDatabaseIdentity: async () => ({ device: 1, inode: 2 }),
    })).resolves.toEqual(exactProof());
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("logs out a valid non-owner session and refuses to publish owner proof", async () => {
    const { fetchImpl } = successfulFetch({ ownerStatus: 403 });
    await expect(authenticateKeelOwner({
      fetchImpl,
      credentials: { email: "owner@example.test", password: "correct horse battery staple" },
      inspectDatabaseIdentity: async () => ({ device: 1, inode: 2 }),
    })).rejects.toThrow("not Keel's instance owner");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("reports WebAuthn as incomplete instead of claiming success", async () => {
    const fetchImpl = vi.fn(async (_url, init = {}) => {
      if (!init.method) return new Response(loginHtml(), { status: 200 });
      return new Response(null, { status: 303, headers: { Location: "/2fa", "Set-Cookie": "keel_pending_2fa=pending; HttpOnly; Path=/" } });
    });
    await expect(authenticateKeelOwner({
      fetchImpl,
      credentials: { email: "owner@example.test", password: "correct horse battery staple" },
    })).rejects.toBeInstanceOf(KeelSecondFactorRequiredError);
  });

  it("persists only exact sanitized proof in a fixed private directory", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-owner-login-proof-store-"));
    cleanup.push(temporary);
    const proofDirectory = path.join(temporary, "proofs");
    const proofPath = path.join(proofDirectory, "latest.json");
    const ownership = { expectedRootUid: process.getuid(), expectedRootGid: process.getgid() };
    await persistSanitizedProof(exactProof(), { proofDirectory, proofPath, ...ownership });
    expect(JSON.parse(await readFile(proofPath, "utf8"))).toEqual(exactProof());
    await expect(persistSanitizedProof(exactProof({ email: "owner@example.test" }), { proofDirectory, proofPath, ...ownership })).rejects.toThrow("non-sanitized");
    await chmod(proofDirectory, 0o755);
    await expect(persistSanitizedProof(exactProof(), { proofDirectory, proofPath, ...ownership })).rejects.toThrow("directory is unsafe");
  });

  it("rechecks the fixed installation before starting the credential worker", async () => {
    const value = await boundaryFixture();
    const runWorker = vi.fn(async () => exactProof());
    const persist = vi.fn(async () => {});
    await expect(runKeelOwnerLoginProof({
      paths: value.paths,
      rootUid: value.uid,
      uid: 0,
      sudoUid: "1000",
      stdinTty: true,
      stdoutTty: true,
      inspectAccount: async () => ({ uid: value.uid, gid: value.gid }),
      serviceActive: () => true,
      runWorker,
      persist,
    })).resolves.toEqual(exactProof());
    expect(runWorker).toHaveBeenCalledWith({ uid: value.uid, gid: value.gid });
    expect(persist).toHaveBeenCalledWith(exactProof());

    await expect(runKeelOwnerLoginProof({
      paths: value.paths,
      rootUid: value.uid,
      uid: 0,
      sudoUid: undefined,
      stdinTty: true,
      stdoutTty: true,
      inspectAccount: async () => ({ uid: value.uid, gid: value.gid }),
      serviceActive: () => true,
      runWorker,
      persist,
    })).rejects.toThrow("normal server administrator");
  });
});
