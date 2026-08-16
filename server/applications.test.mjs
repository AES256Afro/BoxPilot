import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService, listApplicationManifests } from "./applications.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup({ statuses = {}, portInUse = false, assessmentError = null, keelProvenanceMatches = true, keelDiscovery = null, keelDiscoveryError = null, keelArchive = null, hostPlatform = "linux", hostArchitecture = "x64" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-apps-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "operator", passwordHash: "hash" });
  const checks = ["runtime.node", "storage.state", "helper.boundary", "containers.docker", "dns.port53"].map((id) => ({ id, status: statuses[id] ?? "ready", summary: `${id} status`, repair: null }));
  const assessment = {
    id: "network-plan-one",
    input: { serverAddress: "192.168.8.10", fallbackDnsAddress: "94.140.14.59", dnsRole: "pihole-on-bigbox" },
    output: { readyForChangeWindow: true, blockers: [] },
  };
  const validateAssessment = vi.fn(async () => {
    if (assessmentError) throw new Error(assessmentError);
    return assessment;
  });
  const githubProvenance = {
    inspect: vi.fn(async () => ({
      fetchedAt: "2026-08-16T03:00:00.000Z",
      repositories: [{
        id: "keel", status: "available",
        latestRelease: {
          tagName: "v1.2.5",
          commit: { sha: "bcf872e2cee5820bdeb74685f5573cc6beb0a28f" },
          assets: [{ name: "keel-1.2.5-linux-x64.tar.gz", sizeBytes: 47655144, digest: keelProvenanceMatches ? "sha256:4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee" : `sha256:${"f".repeat(64)}` }],
        },
      }],
    })),
  };
  const defaultKeelDiscovery = keelDiscovery ?? {
    installed: false, state: "not-installed", healthy: false, kind: null, version: null, port: 3000, listener: "none", healthIdentityVerified: false,
    native: { candidateCount: 0, candidates: [] }, docker: { available: true, candidateCount: 0, candidates: [] }, risks: [],
    detail: "No supported Keel native-service or Docker installation was found",
    boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false, arbitraryPathAccepted: false },
  };
  const helperRequest = vi.fn(async (operation) => {
    if (operation === "application.keel.inspect") {
      if (keelDiscoveryError) throw new Error(keelDiscoveryError);
      return defaultKeelDiscovery;
    }
    if (operation === "application.keel.artifact.inspect") return { state: "absent", readyToAcquire: true, artifactPresent: false, locallyVerified: false, partialPresent: false, acquiredAt: null, detail: "The fixed Keel release archive is not present", boundary: { mutationPerformed: false, extractionPerformed: false, applicationInstalled: false } };
    if (operation === "application.keel.archive.inspect") return keelArchive ?? { state: "artifact-required", safeToExtract: false, artifactLocallyVerified: false, memberCount: 0, risks: ["artifact-required"], detail: "Acquire the fixed archive first", boundary: { mutationPerformed: false, extractionPerformed: false } };
    return { installed: false, state: "not-installed", detail: "Ready to plan" };
  });
  const service = createApplicationService({
    store,
    prerequisites: { inspect: vi.fn(async () => ({ checks })) },
    helper: { request: helperRequest },
    network: { validateAssessment },
    githubProvenance,
    inspectPort: vi.fn(async () => portInUse),
    hostPlatform,
    hostArchitecture,
  });
  return { store, owner, service, validateAssessment, githubProvenance, helperRequest };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("application manifests and plans", () => {
  it("publishes integrity-addressed curated manifests", () => {
    const catalog = listApplicationManifests();
    expect(catalog.map((item) => item.id)).toEqual(["uptime-kuma", "pi-hole", "keel"]);
    expect(catalog[0]).toMatchObject({ image: { version: "2.5.0", digestPinned: true }, integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(catalog[1]).toMatchObject({ execution: "enabled", risk: "network-critical", adapterVersion: "0.2.0", image: { version: "2026.07.2", digestPinned: true, reference: expect.stringMatching(/^pihole\/pihole@sha256:/) } });
    expect(catalog[2]).toMatchObject({ adapterVersion: "0.2.0-plan", execution: "planning-only", risk: "stateful", targets: ["native-service"], artifact: { releaseTag: "v1.2.5", releaseCommitSha: "bcf872e2cee5820bdeb74685f5573cc6beb0a28f", name: "keel-1.2.5-linux-x64.tar.gz", digest: "sha256:4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee", locallyVerifiedByBoxPilot: false } });
  });

  it("reports fixed read-only Keel host discovery together with release provenance", async () => {
    const { store, service, githubProvenance, helperRequest } = await setup();
    const catalog = await service.list();
    expect(catalog.applications.find((item) => item.id === "keel")?.live).toMatchObject({
      installed: false,
      state: "not-installed",
      listener: "none",
      provenance: { status: "matched", checkedAt: "2026-08-16T03:00:00.000Z" },
      artifact: { state: "absent", readyToAcquire: true, locallyVerified: false },
      archive: { state: "artifact-required", safeToExtract: false, risks: ["artifact-required"] },
      boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false },
    });
    expect(catalog.applications.find((item) => item.id === "keel")?.live.detail).toContain("No supported Keel");
    expect(helperRequest).toHaveBeenCalledWith("application.keel.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.artifact.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.archive.inspect", {});
    expect(githubProvenance.inspect).toHaveBeenCalled();
    store.close();
  });

  it("creates and stages an executable Uptime Kuma plan only when checks pass", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("uptime-kuma", { target: "docker", hostPort: 3101 }, owner.id);
    expect(plan.output).toMatchObject({ executable: true, hostPort: 3101, blockers: [] });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.uptime-kuma.deploy", state: "awaiting_approval", parameters: { hostPort: 3101 } });
    store.close();
  });

  it("blocks staging when Docker or the selected port is unavailable", async () => {
    const { store, owner, service } = await setup({ statuses: { "containers.docker": "missing" }, portInUse: true });
    const plan = await service.plan("uptime-kuma", { hostPort: 3001 }, owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers.map((item) => item.id)).toEqual(["containers.docker", "port.3001"]);
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("links a live Pi-hole assessment and stages a no-cutover network-critical job", async () => {
    const { store, owner, service, validateAssessment } = await setup();
    const plan = await service.plan("pi-hole", { target: "docker", hostPort: 8080, networkAssessmentId: "network-plan-one" }, owner.id);
    expect(plan.output).toMatchObject({ executable: true, lanAddress: "192.168.8.10", fallbackDnsAddress: "94.140.14.59", networkAssessmentId: "network-plan-one", blockers: [] });
    expect(plan.output.warnings.join(" ")).toContain("cannot change router DHCP");
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.pi-hole.deploy", risk: "network-critical", parameters: { lanAddress: "192.168.8.10", hostPort: 8080, networkAssessmentId: "network-plan-one" } });
    expect(validateAssessment).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("fails closed without an owner-attributable live Pi-hole assessment", async () => {
    const { store, owner, service } = await setup({ assessmentError: "Network assessment expired" });
    const plan = await service.plan("pi-hole", { target: "docker", hostPort: 8080, networkAssessmentId: "stale-plan" }, owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "network.assessment", summary: "Network assessment expired" })]));
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("creates an immutable but non-executable Keel plan only when exact public provenance matches", async () => {
    const { store, owner, service, githubProvenance } = await setup();
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output).toMatchObject({
      executable: false,
      artifact: {
        releaseTag: "v1.2.5", releaseCommitSha: "bcf872e2cee5820bdeb74685f5573cc6beb0a28f", sizeBytes: 47655144,
        digest: "sha256:4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee",
        githubReportedDigestMatched: true, locallyVerifiedByBoxPilot: false,
      },
      archiveInspection: { state: "artifact-required", safeToExtract: false },
      blockers: expect.arrayContaining([expect.objectContaining({ id: "keel.archive" }), expect.objectContaining({ id: "keel.execution" })]),
      discovery: { installed: false, state: "not-installed", listener: "none", risks: [] },
    });
    expect(plan.output.changes.join(" ")).toContain("five-minute one-use terminal claim");
    expect(plan.output.warnings.join(" ")).toContain(".keel-server-secrets.key");
    expect(githubProvenance.inspect).toHaveBeenCalled();
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("reports the exact blocked archive membership without exposing member names or allowing extraction", async () => {
    const { store, owner, service } = await setup({
      keelArchive: {
        state: "blocked", safeToExtract: false, artifactLocallyVerified: true, memberCount: 2900,
        counts: { regular: 2398, directory: 501, symbolicLink: 1, hardLink: 0, blockDevice: 0, characterDevice: 0, fifo: 0, contiguous: 0, extension: 0, unknown: 0 },
        risks: ["absolute-link-target", "symbolic-link-member"],
        detail: "The exact fixed archive contains blocked membership",
        boundary: { mutationPerformed: false, extractionPerformed: false, archiveMemberNamesReturned: false, linkTargetsReturned: false },
      },
    });
    const catalog = await service.list();
    expect(catalog.applications.find((item) => item.id === "keel")?.live.archive).toMatchObject({ state: "blocked", safeToExtract: false, memberCount: 2900, risks: ["absolute-link-target", "symbolic-link-member"] });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output.archiveInspection).toMatchObject({ state: "blocked", safeToExtract: false, memberCount: 2900 });
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "keel.archive", summary: expect.stringContaining("absolute-link-target") })]));
    expect(JSON.stringify(plan.output.archiveInspection)).not.toContain("runner/work");
    expect(plan.output.executable).toBe(false);
    store.close();
  });

  it("fails closed when Keel discovery finds an existing unsafe or ambiguous installation", async () => {
    const { store, owner, service } = await setup({
      portInUse: true,
      keelDiscovery: {
        installed: true, state: "ambiguous", healthy: false, kind: "multiple", version: "1.2.5", port: 3000, listener: "wildcard", healthIdentityVerified: true,
        native: { candidateCount: 1, candidates: [] }, docker: { available: true, candidateCount: 1, candidates: [] },
        risks: ["multiple-installations", "non-loopback-listener"], detail: "Keel discovery found conflicting, incomplete, or unrecognized evidence",
        boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false },
      },
    });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "keel.existing-install" }),
      expect.objectContaining({ id: "keel.discovery-risk", summary: expect.stringContaining("non-loopback-listener") }),
      expect.objectContaining({ id: "keel.execution" }),
    ]));
    expect(plan.output.blockers.find((item) => item.id === "port.3000")).toBeUndefined();
    expect(plan.output.discovery.boundary.secretRead).toBe(false);
    store.close();
  });

  it("fails closed when the Keel discovery helper is unavailable", async () => {
    const { store, owner, service } = await setup({ keelDiscoveryError: "helper offline" });
    const catalog = await service.list();
    expect(catalog.applications.find((item) => item.id === "keel")?.live).toMatchObject({ state: "discovery-unavailable", listener: "unknown", risks: ["helper-unavailable"] });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "keel.discovery" }), expect.objectContaining({ id: "keel.execution" })]));
    expect(plan.output.discovery).toBeNull();
    store.close();
  });

  it("blocks the Keel plan when platform or release metadata changes", async () => {
    const { store, owner, service } = await setup({ keelProvenanceMatches: false, hostArchitecture: "arm64" });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "keel.platform" }),
      expect.objectContaining({ id: "github.provenance" }),
      expect.objectContaining({ id: "keel.execution" }),
    ]));
    expect(plan.output.artifact.githubReportedDigestMatched).toBeUndefined();
    store.close();
  });

  it("rejects undeclared application-plan fields", async () => {
    const { store, owner, service } = await setup();
    await expect(service.plan("keel", { target: "native-service", hostPort: 3000, downloadUrl: "https://example.invalid/keel.tgz" }, owner.id)).rejects.toThrow("unsupported fields: downloadUrl");
    store.close();
  });
});
