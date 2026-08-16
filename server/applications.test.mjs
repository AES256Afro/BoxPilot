import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService, listApplicationManifests } from "./applications.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup({ statuses = {}, portInUse = false, assessmentError = null, keelProvenanceMatches = true, hostPlatform = "linux", hostArchitecture = "x64" } = {}) {
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
  const service = createApplicationService({
    store,
    prerequisites: { inspect: vi.fn(async () => ({ checks })) },
    helper: { request: vi.fn(async () => ({ installed: false, state: "not-installed", detail: "Ready to plan" })) },
    network: { validateAssessment },
    githubProvenance,
    inspectPort: vi.fn(async () => portInUse),
    hostPlatform,
    hostArchitecture,
  });
  return { store, owner, service, validateAssessment, githubProvenance };
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
    expect(catalog[2]).toMatchObject({ execution: "planning-only", risk: "stateful", targets: ["native-service"], artifact: { releaseTag: "v1.2.5", releaseCommitSha: "bcf872e2cee5820bdeb74685f5573cc6beb0a28f", name: "keel-1.2.5-linux-x64.tar.gz", digest: "sha256:4b24067aa219bc00bf4f7c1846f78945e8abda3f5b68353e4967570d5b57e6ee", locallyVerifiedByBoxPilot: false } });
  });

  it("reports Keel planning readiness without inspecting or installing a local service", async () => {
    const { store, service, githubProvenance } = await setup();
    const catalog = await service.list();
    expect(catalog.applications.find((item) => item.id === "keel")?.live).toEqual({
      installed: false,
      state: "planning-ready",
      detail: "Exact public release metadata is ready for an immutable planning-only preflight",
    });
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
      blockers: [expect.objectContaining({ id: "keel.execution" })],
    });
    expect(plan.output.changes.join(" ")).toContain("five-minute one-use terminal claim");
    expect(plan.output.warnings.join(" ")).toContain(".keel-server-secrets.key");
    expect(githubProvenance.inspect).toHaveBeenCalled();
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
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
