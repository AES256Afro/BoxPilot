import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService, listApplicationManifests } from "./applications.mjs";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup({ statuses = {}, portInUse = false, dnsTcpInUse = false, dnsUdpInUse = false, assessmentError = null, uptimeState = null, uptimeLifecycle = null, uptimePrivateAccess = null, piholeState = null, piholeLifecycle = null, keelProvenanceMatches = true, keelDiscovery = null, keelDiscoveryError = null, keelArtifact = null, keelArchive = null, keelStaging = null, keelInstallation = null, keelLoginProof = null, hostPlatform = "linux", hostArchitecture = "x64" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-apps-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "operator", passwordHash: "hash" });
  const checks = ["runtime.node", "storage.state", "helper.boundary", "containers.docker", "dns.port53"].map((id) => ({ id, status: statuses[id] ?? "ready", summary: `${id} status`, repair: null }));
  const assessment = {
    id: "network-plan-one",
    input: { serverAddress: "192.168.8.10", fallbackDnsAddress: "94.140.14.59", dnsRole: "pihole-on-host" },
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
          tagName: keelArtifactSpec.releaseTag,
          commit: { sha: keelArtifactSpec.releaseCommitSha },
          assets: [{ name: keelArtifactSpec.name, sizeBytes: keelArtifactSpec.sizeBytes, digest: keelProvenanceMatches ? keelArtifactSpec.digest : `sha256:${"f".repeat(64)}` }],
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
    if (operation === "application.uptime-kuma.inspect") return uptimeState ?? { installed: false, state: "not-installed", detail: "Ready to plan" };
    if (operation === "application.uptime-kuma.lifecycle.inspect") return uptimeLifecycle ?? { installed: false, managed: false, state: "not-installed", running: false, healthy: false, port: null, revision: null, allowedActions: [], detail: "Managed Uptime Kuma container was not found" };
    if (operation === "application.uptime-kuma.private-access.inspect") return uptimePrivateAccess ?? { connected: false, published: false, tailnetOnly: false, conflict: false, dnsName: null, port: null, url: null, revision: null, allowedActions: [], detail: "Private access unavailable" };
    if (operation === "application.pi-hole.inspect") return piholeState ?? { installed: false, state: "not-installed", detail: "Ready to plan" };
    if (operation === "application.pi-hole.lifecycle.inspect") return piholeLifecycle ?? { installed: false, managed: false, state: "not-installed", running: false, healthy: false, lanAddress: null, port: null, revision: null, allowedActions: [], detail: "Managed Pi-hole container was not found" };
    if (operation === "application.keel.inspect") {
      if (keelDiscoveryError) throw new Error(keelDiscoveryError);
      return defaultKeelDiscovery;
    }
    if (operation === "application.keel.artifact.inspect") return keelArtifact ?? { state: "absent", readyToAcquire: true, artifactPresent: false, locallyVerified: false, partialPresent: false, acquiredAt: null, detail: "The fixed Keel release archive is not present", boundary: { mutationPerformed: false, extractionPerformed: false, applicationInstalled: false } };
    if (operation === "application.keel.archive.inspect") return keelArchive ?? { state: "artifact-required", safeToExtract: false, artifactLocallyVerified: false, memberCount: 0, risks: ["artifact-required"], detail: "Acquire the fixed archive first", boundary: { mutationPerformed: false, extractionPerformed: false } };
    if (operation === "application.keel.stage.inspect") return keelStaging ?? { state: "absent", staged: false, readyToStage: true, version: null, sourceMemberCount: 0, partialCount: 0, stagedAt: null, detail: "The fixed Keel release has not been staged", boundary: { mutationPerformed: false } };
    if (operation === "application.keel.install.inspect") return keelInstallation ?? { state: "absent", installed: false, readyToInstall: false, releaseVersion: null, serviceActive: false, serviceEnabled: false, healthy: false, listener: "none", claim: { state: "not-applicable", terminalRequired: true }, detail: "The fixed Keel release must be staged before installation", boundary: { mutationPerformed: false } };
    if (operation === "application.keel.login-proof.inspect") return keelLoginProof ?? { state: "not-run", verified: false, verifiedAt: null, releaseVersion: null, credentialsStored: false, sessionStored: false, detail: "No terminal-only Keel instance-owner login proof has been recorded", boundary: { credentialRead: false, sessionRead: false } };
    return { installed: false, state: "not-installed", detail: "Ready to plan" };
  });
  const inspectPort = vi.fn(async (port) => port === 53 ? dnsTcpInUse : portInUse);
  const inspectUdpPort = vi.fn(async () => dnsUdpInUse);
  const service = createApplicationService({
    store,
    prerequisites: { inspect: vi.fn(async () => ({ checks })) },
    helper: { request: helperRequest },
    network: { validateAssessment },
    githubProvenance,
    inspectPort,
    inspectUdpPort,
    hostPlatform,
    hostArchitecture,
  });
  return { store, owner, service, validateAssessment, githubProvenance, helperRequest, inspectPort, inspectUdpPort };
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
    expect(catalog[2]).toMatchObject({ adapterVersion: "0.4.0-native-install", execution: "staging-enabled", risk: "stateful", targets: ["native-service"], image: { version: "1.2.6", digestPinned: true }, artifact: { ...keelArtifactSpec, locallyVerifiedByBoxPilot: false } });
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
      staging: { state: "absent", staged: false, readyToStage: true },
      installation: { state: "absent", installed: false, readyToInstall: false },
      loginProof: { state: "not-run", verified: false, credentialsStored: false, sessionStored: false },
      boundary: { mutationPerformed: false, environmentRead: false, databaseOpened: false, secretRead: false },
    });
    expect(catalog.applications.find((item) => item.id === "keel")?.live.detail).toContain("No supported Keel");
    expect(helperRequest).toHaveBeenCalledWith("application.keel.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.artifact.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.archive.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.stage.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.install.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.keel.login-proof.inspect", {});
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

  it("merges strict managed lifecycle evidence into an installed Uptime Kuma catalog entry", async () => {
    const lifecycle = {
      installed: true, managed: true, state: "running", running: true, healthy: true, port: 3101,
      revision: "a".repeat(64), allowedActions: ["stop", "restart"], detail: "Managed Uptime Kuma is healthy on loopback port 3101",
    };
    const { store, service, helperRequest } = await setup({
      uptimeState: { installed: true, state: "running", healthy: true, port: 3101, detail: "Uptime Kuma is healthy" },
      uptimeLifecycle: lifecycle,
      uptimePrivateAccess: { connected: true, published: true, tailnetOnly: true, conflict: false, dnsName: "bigbox.example.ts.net", port: 3101, url: "https://bigbox.example.ts.net:3101/", revision: "c".repeat(64), allowedActions: ["unpublish"], detail: "Uptime Kuma is privately available" },
    });
    const catalog = await service.list();
    expect(catalog.applications.find((item) => item.id === "uptime-kuma")?.live).toMatchObject({
      installed: true,
      state: "running",
      backup: { state: "required", verifiedAt: null },
      lifecycle,
      privateAccess: { connected: true, published: true, tailnetOnly: true, url: "https://bigbox.example.ts.net:3101/", allowedActions: ["unpublish"] },
    });
    expect(helperRequest).toHaveBeenCalledWith("application.uptime-kuma.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.uptime-kuma.lifecycle.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.uptime-kuma.private-access.inspect", {});
    store.close();
  });

  it("merges strict network-critical lifecycle evidence into an installed Pi-hole catalog entry", async () => {
    const lifecycle = {
      installed: true, managed: true, state: "running", running: true, healthy: true, lanAddress: "192.168.8.10", port: 8080,
      dnsTcpBound: true, dnsUdpBound: true, revision: "b".repeat(64), allowedActions: ["stop", "restart"], detail: "Managed Pi-hole is healthy",
    };
    const { store, service, helperRequest } = await setup({
      piholeState: { installed: true, state: "running", healthy: true, lanAddress: "192.168.8.10", port: 8080, detail: "Pi-hole is healthy" },
      piholeLifecycle: lifecycle,
    });
    const catalog = await service.list();
    expect(catalog.applications.find((item) => item.id === "pi-hole")?.live).toMatchObject({
      installed: true,
      state: "running",
      backup: { state: "required", verifiedAt: null },
      lifecycle,
    });
    expect(helperRequest).toHaveBeenCalledWith("application.pi-hole.inspect", {});
    expect(helperRequest).toHaveBeenCalledWith("application.pi-hole.lifecycle.inspect", {});
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

  it("uses exact-address TCP and UDP port 53 checks instead of blocking on an unrelated loopback resolver", async () => {
    const { store, owner, service, inspectPort, inspectUdpPort } = await setup({ statuses: { "dns.port53": "conflict" } });
    const plan = await service.plan("pi-hole", { target: "docker", hostPort: 8080, networkAssessmentId: "network-plan-one" }, owner.id);
    expect(plan.output).toMatchObject({ executable: true, blockers: [] });
    expect(inspectPort).toHaveBeenCalledWith(53, "192.168.8.10");
    expect(inspectUdpPort).toHaveBeenCalledWith(53, "192.168.8.10");
    await expect(service.stage(plan.id, plan.revision, owner.id)).resolves.toMatchObject({ type: "application.pi-hole.deploy" });
    store.close();
  });

  it("blocks Pi-hole when either exact-address DNS transport is occupied", async () => {
    const tcp = await setup({ dnsTcpInUse: true });
    const tcpPlan = await tcp.service.plan("pi-hole", { target: "docker", hostPort: 8080, networkAssessmentId: "network-plan-one" }, tcp.owner.id);
    expect(tcpPlan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "port.53.tcp" })]));
    expect(tcpPlan.output.executable).toBe(false);
    tcp.store.close();

    const udp = await setup({ dnsUdpInUse: true });
    const udpPlan = await udp.service.plan("pi-hole", { target: "docker", hostPort: 8080, networkAssessmentId: "network-plan-one" }, udp.owner.id);
    expect(udpPlan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "port.53.udp" })]));
    expect(udpPlan.output.executable).toBe(false);
    udp.store.close();
  });

  it("fails closed without an owner-attributable live Pi-hole assessment", async () => {
    const { store, owner, service } = await setup({ assessmentError: "Network assessment expired" });
    const plan = await service.plan("pi-hole", { target: "docker", hostPort: 8080, networkAssessmentId: "stale-plan" }, owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "network.assessment", summary: "Network assessment expired" })]));
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("creates, stages, and revalidates an executable inert Keel 1.2.6 release plan", async () => {
    const { store, owner, service, githubProvenance, helperRequest } = await setup({
      keelArtifact: { state: "verified", readyToAcquire: false, artifactPresent: true, locallyVerified: true, partialPresent: false, acquiredAt: "2026-08-16T04:00:00.000Z", sha256: keelArtifactSpec.digest, detail: "Exact local bytes verified" },
      keelArchive: { state: "safe", safeToExtract: true, artifactLocallyVerified: true, memberCount: 2974, risks: [], detail: "The exact archive passed the runtime gate" },
    });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output).toMatchObject({
      executable: true,
      artifact: {
        releaseTag: "v1.2.6", releaseCommitSha: "884e7ab1cc48139ed51de350ea5812a2e3a9cc7d", sizeBytes: 71052143,
        digest: "sha256:696f5e444696d3da876f870fe72b6743e7e15c4fbf25809d02469a14da1f2e00",
        githubReportedDigestMatched: true, locallyVerifiedByBoxPilot: true,
      },
      archiveInspection: { state: "safe", safeToExtract: true, memberCount: 2974 },
      stagingInspection: { state: "absent", readyToStage: true },
      blockers: [],
      discovery: { installed: false, state: "not-installed", listener: "none", risks: [] },
    });
    expect(plan.output.changes.join(" ")).toContain("Leave service installation");
    expect(plan.output.warnings.join(" ")).toContain(".keel-server-secrets.key");
    expect(githubProvenance.inspect).toHaveBeenCalled();
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.keel.stage", risk: "stateful-staging", parameters: { planId: plan.id, revision: plan.revision, stageId: plan.input.stageId, hostPort: 3000 } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged", input: { stageId: plan.input.stageId } });
    expect(helperRequest).toHaveBeenCalledWith("application.keel.stage.inspect", {});
    store.close();
  });

  it("turns an exact staged release into a separately approved private-service install plan", async () => {
    const installState = {
      state: "absent", installed: false, readyToInstall: true, releaseVersion: "1.2.6",
      serviceActive: false, serviceEnabled: false, healthy: false, listener: "none",
      claim: { state: "not-applicable", terminalRequired: true },
      detail: "The exact staged release is ready for a private native-service installation",
      boundary: { mutationPerformed: false, databaseOpened: false, secretRead: false },
    };
    const { store, owner, service, helperRequest, inspectPort } = await setup({
      keelArtifact: { state: "verified", readyToAcquire: false, artifactPresent: true, locallyVerified: true, partialPresent: false, acquiredAt: "2026-08-16T04:00:00.000Z", sha256: keelArtifactSpec.digest, detail: "Exact local bytes verified" },
      keelArchive: { state: "safe", safeToExtract: true, artifactLocallyVerified: true, memberCount: 2974, risks: [], detail: "The exact archive passed the runtime gate" },
      keelStaging: { state: "staged", staged: true, readyToStage: false, version: "1.2.6", sourceMemberCount: 2974, partialCount: 0, stagedAt: "2026-08-16T05:00:00.000Z", detail: "The exact release is staged" },
      keelInstallation: installState,
    });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output).toMatchObject({
      executable: true,
      keelAction: "install",
      blockers: [],
      stagingInspection: { state: "staged", staged: true },
      installationInspection: { state: "absent", readyToInstall: true },
    });
    expect(plan.input).toMatchObject({ keelAction: "install", installId: expect.stringMatching(/^[a-f0-9-]{36}$/), hostPort: 3000 });
    expect(plan.output.changes.join(" ")).toContain("dedicated non-login");
    expect(plan.output.changes.join(" ")).toContain("127.0.0.1:3000");
    expect(plan.output.warnings.join(" ")).toContain("does not claim an account");
    expect(inspectPort).toHaveBeenCalledWith(3000, "127.0.0.1");
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({
      type: "application.keel.install",
      risk: "stateful-install",
      parameters: { planId: plan.id, revision: plan.revision, installId: plan.input.installId, hostPort: 3000 },
      recovery: { automaticRollback: true, reason: expect.stringContaining("preserves /var/lib/keel") },
    });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged", input: { installId: plan.input.installId, keelAction: "install" } });
    expect(helperRequest).toHaveBeenCalledWith("application.keel.install.inspect", {});
    store.close();
  });

  it("blocks the fixed Keel install when loopback port 3000 is occupied", async () => {
    const { store, owner, service } = await setup({
      portInUse: true,
      keelArtifact: { state: "verified", locallyVerified: true, sha256: keelArtifactSpec.digest },
      keelArchive: { state: "safe", safeToExtract: true, memberCount: 2974, risks: [] },
      keelStaging: { state: "staged", staged: true, readyToStage: false, version: "1.2.6" },
      keelInstallation: { state: "absent", installed: false, readyToInstall: true, releaseVersion: "1.2.6", detail: "Ready" },
    });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "port.3000",
      summary: "TCP port 3000 is already in use on 127.0.0.1",
      repair: { kind: "manual", description: expect.stringContaining("fixed") },
    })]));
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
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "keel.discovery" })]));
    expect(plan.output.discovery).toBeNull();
    store.close();
  });

  it("blocks the Keel plan when platform or release metadata changes", async () => {
    const { store, owner, service } = await setup({ keelProvenanceMatches: false, hostArchitecture: "arm64" });
    const plan = await service.plan("keel", { target: "native-service", hostPort: 3000 }, owner.id);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "keel.platform" }),
      expect.objectContaining({ id: "github.provenance" }),
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
