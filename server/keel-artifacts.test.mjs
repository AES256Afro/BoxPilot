import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelArtifactService } from "./keel-artifacts.mjs";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup({ artifactState = "absent", provenanceDigest = keelArtifactSpec.digest, discoveryRisks = [], architecture = "x64" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-service-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "operator", passwordHash: "hash" });
  let currentArtifactState = artifactState;
  const helper = { request: vi.fn(async (operation) => {
    if (operation === "application.keel.artifact.inspect") return { state: currentArtifactState, readyToAcquire: ["absent", "partial"].includes(currentArtifactState), artifactPresent: currentArtifactState === "verified", locallyVerified: currentArtifactState === "verified", partialPresent: currentArtifactState === "partial", detail: `Artifact ${currentArtifactState}`, boundary: { mutationPerformed: false } };
    if (operation === "application.keel.inspect") return { installed: false, state: "not-installed", listener: "none", risks: discoveryRisks, detail: "No supported Keel installation" };
    throw new Error("unexpected helper operation");
  }) };
  const prerequisites = { inspect: vi.fn(async () => ({ checks: ["runtime.node", "storage.state", "helper.boundary"].map((id) => ({ id, status: "ready", summary: "ready", repair: null })) })) };
  const githubProvenance = { inspect: vi.fn(async () => ({ repositories: [{ id: "keel", status: "available", latestRelease: { tagName: keelArtifactSpec.releaseTag, commit: { sha: keelArtifactSpec.releaseCommitSha }, assets: [{ name: keelArtifactSpec.name, sizeBytes: keelArtifactSpec.sizeBytes, digest: provenanceDigest }] } }] })) };
  const service = createKeelArtifactService({ store, helper, prerequisites, githubProvenance, hostPlatform: "linux", hostArchitecture: architecture });
  return { store, owner, service, helper, setArtifactState: (value) => { currentArtifactState = value; } };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Keel artifact durable planning", () => {
  it("creates and stages only an exact immutable acquisition job", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(owner.id, {});
    expect(plan).toMatchObject({ type: "application.keel.artifact.acquire", subjectId: "keel", output: { executable: true, currentState: "absent", provenanceMatched: true, extractionPerformed: false, applicationInstalled: false } });
    expect(plan.input.acquisitionId).toMatch(/^[a-f0-9-]{36}$/);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.keel.artifact.acquire", state: "awaiting_approval", risk: "networked-artifact", parameters: { planId: plan.id, revision: plan.revision, acquisitionId: plan.input.acquisitionId, expectedArtifactState: "absent" }, recovery: { automaticRollback: true } });
    store.close();
  });

  it("fails closed if local artifact, discovery, platform, or provenance state changes", async () => {
    const { store, owner, service, setArtifactState } = await setup();
    const plan = await service.plan(owner.id, {});
    setArtifactState("verified");
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("state changed");
    store.close();

    const changed = await setup({ provenanceDigest: `sha256:${"f".repeat(64)}`, discoveryRisks: ["non-loopback-listener"], architecture: "arm64" });
    const blocked = await changed.service.plan(changed.owner.id, {});
    expect(blocked.output.executable).toBe(false);
    expect(blocked.output.blockers.map((item) => item.id)).toEqual(expect.arrayContaining(["keel.platform", "github.provenance", "keel.discovery"]));
    changed.store.close();
  });

  it("rejects browser-provided URLs, paths, digests, or revisions", async () => {
    const { store, owner, service } = await setup();
    await expect(service.plan(owner.id, { url: "https://example.invalid", path: "/tmp/keel", digest: "changed" })).rejects.toThrow("empty object");
    const plan = await service.plan(owner.id, {});
    await expect(service.stage(plan.id, "changed", owner.id)).rejects.toThrow("revision");
    store.close();
  });
});
