import { createHash } from "node:crypto";
import net from "node:net";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";

const uptimeKumaImage = "louislam/uptime-kuma@sha256:a8610b3b4c38077922ba51b036691e06887d7cefd91fe620fd3d6d23d03dc240";
const piholeImage = "pihole/pihole@sha256:f7d1be836e3bc608b56d82fc9904f5a831cdfbc0dc9c6d58f94e4c985c70038b";
const keelArtifact = {
  ...keelArtifactSpec,
  locallyVerifiedByBoxPilot: false,
};

const manifests = [
  {
    schemaVersion: 1,
    adapterVersion: "0.1.0",
    id: "uptime-kuma",
    name: "Uptime Kuma",
    category: "Monitoring",
    description: "Private service monitoring with local persistent data and a reversible Docker deployment.",
    execution: "enabled",
    risk: "low",
    targets: ["docker"],
    image: { reference: uptimeKumaImage, version: "2.5.0", digestPinned: true },
    ports: [{ id: "web", protocol: "tcp", containerPort: 3001, defaultHostPort: 3001, exposure: "loopback" }],
    storage: [{ id: "data", containerPath: "/app/data", hostPath: "/var/lib/boxpilot-managed/apps/uptime-kuma/data", backupRequired: true, localFilesystemRequired: true }],
    prerequisites: ["runtime.node", "storage.state", "helper.boundary", "containers.docker"],
    targetPrerequisites: { docker: ["runtime.node", "storage.state", "helper.boundary", "containers.docker"] },
    health: { kind: "container-http", path: "/", expectedStatus: 302 },
    rollback: "Stop and remove the managed container and network while preserving the data directory.",
    officialSource: "https://github.com/louislam/uptime-kuma",
  },
  {
    schemaVersion: 1,
    adapterVersion: "0.2.0",
    id: "pi-hole",
    name: "Pi-hole",
    category: "DNS",
    description: "Network DNS filtering with explicit DNS-role, port-conflict, router, backup, and outage-recovery gates.",
    execution: "enabled",
    risk: "network-critical",
    targets: ["docker", "virtual-machine"],
    image: { reference: piholeImage, version: "2026.07.2", digestPinned: true },
    ports: [
      { id: "dns-tcp", protocol: "tcp", containerPort: 53, defaultHostPort: 53, exposure: "lan" },
      { id: "dns-udp", protocol: "udp", containerPort: 53, defaultHostPort: 53, exposure: "lan" },
      { id: "web", protocol: "tcp", containerPort: 80, defaultHostPort: 8080, exposure: "lan" },
    ],
    storage: [{ id: "configuration", containerPath: "/etc/pihole", hostPath: "/var/lib/boxpilot-managed/apps/pi-hole/etc-pihole", backupRequired: true, localFilesystemRequired: true }],
    prerequisites: ["runtime.node", "storage.state", "helper.boundary", "containers.docker", "dns.port53"],
    targetPrerequisites: {
      docker: ["runtime.node", "storage.state", "helper.boundary", "containers.docker"],
      "virtual-machine": ["runtime.node", "storage.state", "helper.boundary", "virtualization.libvirt", "dns.port53"],
    },
    conflicts: ["adguard-home-primary", "existing-dns-listener", "router-dns-cutover-without-recovery"],
    health: { kind: "dns-and-http", expectedDnsResult: true },
    rollback: "Stop and remove only the managed Pi-hole stack while preserving its configuration and root-only administrator secret. Router and client DNS remain unchanged.",
    officialSource: "https://github.com/pi-hole/docker-pi-hole",
  },
  {
    schemaVersion: 1,
    adapterVersion: "0.2.0-plan",
    id: "keel",
    name: "Keel Notes",
    category: "Knowledge",
    description: "Stateful self-hosted notebook planning with exact release, runtime archive, managed-secret, backup, claim, and loopback-access gates. The pinned 1.2.5 archive is blocked.",
    execution: "planning-only",
    risk: "stateful",
    targets: ["native-service"],
    image: { reference: "not-applicable-native-release", version: "1.2.5", digestPinned: false },
    artifact: keelArtifact,
    ports: [{ id: "web", protocol: "tcp", containerPort: null, defaultHostPort: 3000, exposure: "loopback" }],
    storage: [{ id: "workspace", containerPath: null, hostPath: "/var/lib/keel", backupRequired: true, localFilesystemRequired: true }],
    prerequisites: ["runtime.node", "storage.state", "helper.boundary"],
    targetPrerequisites: { "native-service": ["runtime.node", "storage.state", "helper.boundary"] },
    health: { kind: "http-json", path: "/api/health", expectedIdentity: { app: "keel", ok: true } },
    rollback: "Stop the future managed Keel service, restore the previous root-owned application tree, and preserve the private workspace database, uploads, backups, and managed-secret key companion.",
    officialSource: "https://github.com/AES256Afro/Keel",
  },
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function publicManifest(manifest) {
  return { ...manifest, integrity: `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}` };
}

async function defaultPortInspector(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => resolve(error.code === "EADDRINUSE" ? true : null));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

export function listApplicationManifests() {
  return manifests.map(publicManifest);
}

export function createApplicationService({ store, prerequisites, helper, network, githubProvenance, inspectPort = defaultPortInspector, hostPlatform = process.platform, hostArchitecture = process.arch } = {}) {
  function getManifest(id) {
    return manifests.find((manifest) => manifest.id === id) ?? null;
  }

  async function list() {
    const verifiedBackups = store.listBackups?.() ?? [];
    const items = await Promise.all(manifests.map(async (manifest) => {
      let live = { installed: false, state: "not-installed", detail: manifest.execution === "planning-only" ? "Planning adapter available" : "Ready to plan" };
      if (["uptime-kuma", "pi-hole"].includes(manifest.id)) {
        try {
          live = await helper.request(`application.${manifest.id}.inspect`, {});
        } catch {
          live = { installed: false, state: "unavailable", detail: "Docker inventory is unavailable" };
        }
        const latestBackup = verifiedBackups.find((backup) => backup.applicationId === manifest.id) ?? null;
        live.backup = latestBackup ? { state: "verified", verifiedAt: latestBackup.verifiedAt } : { state: live.installed ? "required" : "not-applicable", verifiedAt: null };
      }
      if (manifest.id === "keel") {
        let discovery;
        let artifact;
        let archive;
        try {
          discovery = await helper.request("application.keel.inspect", {});
        } catch {
          discovery = { installed: false, state: "discovery-unavailable", healthy: false, kind: null, version: null, listener: "unknown", healthIdentityVerified: false, risks: ["helper-unavailable"], detail: "Keel host discovery is unavailable" };
        }
        try {
          artifact = await helper.request("application.keel.artifact.inspect", {});
        } catch {
          artifact = { state: "unavailable", readyToAcquire: false, artifactPresent: false, locallyVerified: false, partialPresent: false, detail: "Keel artifact evidence is unavailable" };
        }
        try {
          archive = await helper.request("application.keel.archive.inspect", {});
        } catch {
          archive = { state: "blocked", safeToExtract: false, artifactLocallyVerified: false, memberCount: 0, risks: ["helper-unavailable"], detail: "Keel archive membership inspection is unavailable" };
        }
        try {
          const provenance = await githubProvenance?.inspect();
          const repository = provenance?.repositories?.find((item) => item.id === "keel");
          const release = repository?.latestRelease;
          const asset = release?.assets?.find((item) => item.name === keelArtifact.name);
          const matches = repository?.status === "available" && release?.tagName === keelArtifact.releaseTag && release?.commit?.sha === keelArtifact.releaseCommitSha && asset?.digest === keelArtifact.digest && asset?.sizeBytes === keelArtifact.sizeBytes;
          live = {
            ...discovery,
            artifact,
            archive,
            provenance: { status: matches ? "matched" : "changed", checkedAt: provenance?.fetchedAt ?? null },
            detail: matches ? `${discovery.detail}; exact public v1.2.5 release metadata matched` : `${discovery.detail}; pinned Keel release provenance is unavailable or changed`,
          };
        } catch {
          live = { ...discovery, artifact, archive, provenance: { status: "unavailable", checkedAt: null }, detail: `${discovery.detail}; GitHub release provenance is unavailable` };
        }
      }
      return { ...publicManifest(manifest), live };
    }));
    return { applications: items };
  }

  async function plan(applicationId, input, ownerId) {
    const manifest = getManifest(applicationId);
    if (!manifest) throw new Error("Application adapter not found");
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("Application plan input must be an object");
    const allowedInputKeys = new Set(["target", "hostPort", ...(manifest.id === "pi-hole" ? ["networkAssessmentId"] : [])]);
    const unexpectedInputKeys = Object.keys(input ?? {}).filter((key) => !allowedInputKeys.has(key));
    if (unexpectedInputKeys.length > 0) throw new Error(`Application plan input contains unsupported fields: ${unexpectedInputKeys.sort().join(", ")}`);
    const target = input?.target ?? manifest.targets[0];
    if (!manifest.targets.includes(target)) throw new Error("Unsupported deployment target");
    const hostPort = target === "virtual-machine" ? null : Number.parseInt(input?.hostPort ?? manifest.ports.find((port) => port.id === "web")?.defaultHostPort, 10);
    if (target !== "virtual-machine" && (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)) throw new Error("Web port must be between 1024 and 65535");

    const inventory = await prerequisites.inspect();
    const required = new Set(manifest.targetPrerequisites?.[target] ?? manifest.prerequisites);
    const relevantChecks = inventory.checks.filter((item) => required.has(item.id));
    const blockers = relevantChecks.filter((item) => item.status !== "ready").map((item) => ({ id: item.id, summary: item.summary, repair: item.repair }));
    let networkAssessment = null;
    let lanAddress = null;
    let fallbackDnsAddress = null;
    if (manifest.id === "pi-hole" && target === "docker") {
      try {
        if (typeof input?.networkAssessmentId !== "string") throw new Error("Create a Pi-hole on Bigbox assessment in Network Center first");
        networkAssessment = await network.validateAssessment(input.networkAssessmentId, ownerId, "pihole-on-bigbox");
        lanAddress = networkAssessment.input.serverAddress;
        fallbackDnsAddress = networkAssessment.input.fallbackDnsAddress;
      } catch (error) {
        blockers.push({ id: "network.assessment", summary: error.message, repair: { kind: "guided", description: "Open Network Center, select Pi-hole on Bigbox, complete the recovery checklist, and generate a fresh assessment" } });
      }
    }
    let keelDiscovery = null;
    if (manifest.id === "keel") {
      try {
        keelDiscovery = await helper.request("application.keel.inspect", {});
        if (keelDiscovery.state === "discovery-unavailable" || keelDiscovery.listener === "unknown" || keelDiscovery.risks?.includes("listener-inspection-incomplete")) {
          blockers.push({ id: "keel.discovery", summary: "Keel host discovery could not establish the fixed listener and installation boundary", repair: { kind: "manual", description: "Restore the restricted helper and regenerate the plan before any Keel work" } });
        }
        if (keelDiscovery.installed || keelDiscovery.state === "ambiguous") {
          blockers.push({ id: "keel.existing-install", summary: keelDiscovery.detail, repair: { kind: "guided", description: "Review the discovered native-service or Docker installation before selecting import, adoption, or a separate deployment" } });
        }
        if (keelDiscovery.risks?.length) {
          blockers.push({ id: "keel.discovery-risk", summary: `Keel discovery reported: ${keelDiscovery.risks.join(", ")}`, repair: { kind: "manual", description: "Resolve changed units, duplicate installs, persistence gaps, or unsafe listener exposure before continuing" } });
        }
      } catch {
        blockers.push({ id: "keel.discovery", summary: "The restricted helper could not inspect existing Keel native-service and Docker evidence", repair: { kind: "manual", description: "Restore the helper and regenerate the plan" } });
      }
    }
    if (hostPort !== null) {
      const portInUse = await inspectPort(hostPort, lanAddress ?? "127.0.0.1");
      const recognizedExistingKeel = manifest.id === "keel" && hostPort === 3000 && keelDiscovery?.healthIdentityVerified === true;
      if (portInUse === true && !recognizedExistingKeel) blockers.push({ id: `port.${hostPort}`, summary: `TCP port ${hostPort} is already in use`, repair: { kind: "manual", description: `Choose another ${lanAddress ? "LAN" : "loopback"} web port` } });
      if (portInUse === null) blockers.push({ id: `port.${hostPort}`, summary: `BoxPilot could not verify TCP port ${hostPort}`, repair: { kind: "manual", description: "Verify the listener state before approval" } });
    }

    let artifact = manifest.artifact ? { ...manifest.artifact } : null;
    let keelArchive = null;
    if (manifest.id === "keel") {
      try {
        const localArtifact = await helper.request("application.keel.artifact.inspect", {});
        artifact = { ...artifact, locallyVerifiedByBoxPilot: localArtifact.locallyVerified === true, localState: localArtifact.state, acquiredAt: localArtifact.acquiredAt ?? null };
      } catch {
        artifact = { ...artifact, locallyVerifiedByBoxPilot: false, localState: "unavailable", acquiredAt: null };
      }
      try {
        keelArchive = await helper.request("application.keel.archive.inspect", {});
        if (keelArchive.safeToExtract !== true) {
          const artifactRequired = keelArchive.state === "artifact-required";
          blockers.push({
            id: "keel.archive",
            summary: artifactRequired
              ? "The fixed archive must be locally acquired and verified before runtime membership inspection"
              : `Keel archive membership is blocked: ${(keelArchive.risks ?? ["unknown-risk"]).join(", ")}`,
            repair: artifactRequired
              ? { kind: "guided", description: "Use the separate fixed artifact acquisition workflow, then generate a new deployment plan" }
              : { kind: "upstream-release", description: "Do not extract this release. Use a newly built release with no links, devices, traversal, extensions, duplicate paths, or changed membership" },
          });
        }
      } catch {
        keelArchive = { state: "blocked", safeToExtract: false, risks: ["helper-unavailable"], detail: "Keel archive membership inspection is unavailable" };
        blockers.push({ id: "keel.archive", summary: "The restricted helper could not inspect the fixed Keel archive membership", repair: { kind: "manual", description: "Restore the helper and regenerate the plan" } });
      }
      if (hostPlatform !== keelArtifact.platform || hostArchitecture !== keelArtifact.architecture) {
        blockers.push({ id: "keel.platform", summary: `Pinned Keel artifact requires ${keelArtifact.platform}-${keelArtifact.architecture}; this host reports ${hostPlatform}-${hostArchitecture}`, repair: { kind: "manual", description: "Use a separately reviewed artifact for this host architecture" } });
      }
      try {
        const provenance = await githubProvenance?.inspect();
        const repository = provenance?.repositories?.find((item) => item.id === "keel");
        const release = repository?.latestRelease;
        const releaseAsset = release?.assets?.find((item) => item.name === keelArtifact.name);
        const matches = repository?.status === "available" && release?.tagName === keelArtifact.releaseTag && release?.commit?.sha === keelArtifact.releaseCommitSha && releaseAsset?.digest === keelArtifact.digest && releaseAsset?.sizeBytes === keelArtifact.sizeBytes;
        if (!matches) throw new Error("Pinned Keel release tag, commit, asset size, or digest does not match live public provenance");
        artifact = { ...artifact, githubReportedDigestMatched: true, githubCheckedAt: provenance.fetchedAt };
      } catch (error) {
        blockers.push({ id: "github.provenance", summary: error instanceof Error ? error.message : "Keel GitHub provenance is unavailable", repair: { kind: "guided", description: "Open GitHub provenance, verify the fixed Keel release, and regenerate this plan" } });
      }
      blockers.push({ id: "keel.execution", summary: "Keel extraction, service installation, ownership claim, backup, restore, import, and exposure remain disabled; the fixed 1.2.5 archive is known to contain an unsafe absolute build-workspace link", repair: { kind: "future-adapter", description: "Publish and pin a corrected upstream release, then pass the runtime archive gate before implementing installation" } });
    }

    const warnings = [];
    if (manifest.id === "pi-hole") {
      warnings.push("This job starts a testable DNS service only. It cannot change router DHCP, advertise DNS, enable Pi-hole DHCP, alter Tailscale DNS, or move any client to Pi-hole.");
      if (target === "docker") warnings.push("Docker on Bigbox ties this DNS service to Bigbox uptime. Keep the recorded emergency resolver working and complete a protected backup before any later cutover.");
      if (target === "virtual-machine") warnings.push("The dedicated VM adapter remains planning-only; use Docker staging or complete the VM application adapter in a later release.");
    }
    if (manifest.id === "uptime-kuma") warnings.push("After deployment, open Backups and complete the integrity and isolated restore workflow before treating this application as protected.");
    if (manifest.id === "keel") {
      warnings.push("The published release is source-available under BUSL-1.1. Personal self-hosting and internal organizational use are allowed; managed third-party hosting requires separate license review.");
      warnings.push("The upstream Linux installer uses a per-user install tree and systemd user unit. BoxPilot discovery recognizes that supported layout and fixed Docker evidence without reading .env or accepting a path from the browser.");
      warnings.push("Registration starts open. A future install must stay loopback-only, use the five-minute one-use terminal claim, and close or restrict registration before any broader exposure.");
      warnings.push("Keel backup and migration must coordinate SQLite writes and keep keel.db with any .keel-server-secrets.key companion. Copying a live database is not an accepted backup.");
    }

    const changes = manifest.id === "uptime-kuma" ? [
      "Create the confined Uptime Kuma application and data directories",
      `Write the curated Compose definition with loopback port ${hostPort}`,
      `Pull the digest-pinned Uptime Kuma ${manifest.image.version} image`,
      "Start the managed container and verify its internal HTTP response",
      "Preserve application data on rollback or uninstall",
    ] : manifest.id === "pi-hole" ? [
      "Reserve an isolated DNS address and verify TCP and UDP port 53",
      "Create persistent Pi-hole configuration storage",
      "Generate a managed administrator secret without returning it to logs",
      "Verify DNS and web health before any router cutover",
      "Keep the current resolver active until second-device tests pass",
    ] : [
      `Stage only ${keelArtifact.name} from the fixed ${keelArtifact.releaseTag} release after checking its ${keelArtifact.sizeBytes}-byte identity`,
      `Compute the complete local ${keelArtifact.digest} digest before any extraction`,
      "Reject links, devices, path traversal, unexpected archive roots, and changed archive membership before creating an application tree",
      `Prepare a dedicated unprivileged Keel service with private state and loopback port ${hostPort}`,
      "Preserve keel.db, uploads, backups, and .keel-server-secrets.key together across rollback or migration",
      "Require private account registration and a five-minute one-use terminal claim before enabling instance controls",
      "Prove /api/health identity, then complete an application-aware backup and isolated restore before reporting protection",
    ];

    const output = {
      application: manifest.id,
      adapterVersion: manifest.adapterVersion,
      manifestIntegrity: publicManifest(manifest).integrity,
      target,
      hostPort,
      lanAddress,
      fallbackDnsAddress,
      networkAssessmentId: networkAssessment?.id ?? input?.networkAssessmentId ?? null,
      image: manifest.image,
      artifact,
      archiveInspection: manifest.id === "keel" ? keelArchive : undefined,
      discovery: manifest.id === "keel" ? keelDiscovery : undefined,
      changes,
      blockers,
      warnings,
      recovery: { summary: manifest.rollback, preservesData: true },
      executable: manifest.execution === "enabled" && target === "docker" && blockers.length === 0,
    };
    return store.createPlan({
      type: "application.deploy",
      subjectId: manifest.id,
      input: { target, hostPort, networkAssessmentId: networkAssessment?.id ?? null, lanAddress, fallbackDnsAddress },
      output,
      createdBy: ownerId,
    });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "application.deploy") throw new Error("Plan not found");
    if (plan.revision !== revision) throw new Error("Plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("Plan has unresolved blockers or is planning-only");
    if (!["uptime-kuma", "pi-hole"].includes(plan.subjectId)) throw new Error("Application execution is not enabled for this adapter");

    if (plan.subjectId === "pi-hole") await network.validateAssessment(plan.input.networkAssessmentId, ownerId, "pihole-on-bigbox");
    const portInUse = await inspectPort(plan.input.hostPort, plan.input.lanAddress ?? "127.0.0.1");
    if (portInUse !== false) throw new Error("Host state changed: the planned port is no longer verified free");
    store.stagePlan(plan.id, ownerId);
    const isPihole = plan.subjectId === "pi-hole";
    return store.createJob({
      type: isPihole ? "application.pi-hole.deploy" : "application.uptime-kuma.deploy",
      title: isPihole ? "Stage Pi-hole on Bigbox" : "Deploy Uptime Kuma",
      risk: isPihole ? "network-critical" : "low",
      parameters: { planId: plan.id, revision: plan.revision, hostPort: plan.input.hostPort, ...(isPihole ? { lanAddress: plan.input.lanAddress, networkAssessmentId: plan.input.networkAssessmentId } : {}) },
      recovery: {
        automaticRollback: true,
        reason: isPihole ? "The managed stack can be removed or its prior Compose definition restored without changing router or client DNS." : "The curated stack can be stopped and its previous Compose definition restored without deleting application data.",
        manual: isPihole ? "If automated rollback fails, remove only boxpilot-pi-hole and preserve /var/lib/boxpilot-managed/apps/pi-hole before repair. Router and client DNS were not changed." : "If automated rollback fails, stop boxpilot-uptime-kuma and preserve /var/lib/boxpilot-managed/apps/uptime-kuma/data before repair.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: isPihole ? "Manifest integrity, Docker, exact LAN address, TCP and UDP DNS binding, web port, Tailscale, and recovery assessment validated" : "Manifest integrity, Docker availability, storage, helper, and loopback port validated" },
        { name: "checkpoint", state: "completed", detail: "Existing Compose definition will be copied before replacement and application data will not be deleted" },
      ],
    });
  }

  async function validateJob(job) {
    if (!["application.uptime-kuma.deploy", "application.pi-hole.deploy"].includes(job.type)) throw new Error("Unsupported application job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.revision !== job.parameters.revision) throw new Error("The staged application plan is unavailable or changed");
    const expectedSubject = job.type === "application.pi-hole.deploy" ? "pi-hole" : "uptime-kuma";
    if (plan.subjectId !== expectedSubject || plan.input.hostPort !== job.parameters.hostPort) throw new Error("The staged application plan does not match the requested adapter or port");
    const inventory = await prerequisites.inspect();
    const required = new Set(["storage.state", "helper.boundary", "containers.docker"]);
    const blocker = inventory.checks.find((item) => required.has(item.id) && item.status !== "ready");
    if (blocker) throw new Error(`Host state changed: ${blocker.summary}`);
    if (job.type === "application.pi-hole.deploy") {
      const assessment = await network.validateAssessment(plan.input.networkAssessmentId, job.createdBy, "pihole-on-bigbox");
      if (assessment.input.serverAddress !== plan.input.lanAddress || job.parameters.lanAddress !== plan.input.lanAddress) throw new Error("Host state changed: the reviewed Pi-hole LAN address no longer matches");
    }
    if (await inspectPort(job.parameters.hostPort, plan.input.lanAddress ?? "127.0.0.1") !== false) throw new Error("Host state changed: the planned port is no longer verified free");
    return plan;
  }

  return { list, plan, stage, validateJob, getManifest };
}

export const applicationInternals = { canonical, defaultPortInspector, keelArtifact, uptimeKumaImage, piholeImage };
