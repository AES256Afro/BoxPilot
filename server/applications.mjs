import { createHash, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
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
    adapterVersion: "0.4.0-native-install",
    id: "keel",
    name: "Keel Notes",
    category: "Knowledge",
    description: "Stateful self-hosted notebook with an exact corrected release, guarded staging, a dedicated non-login account, hardened loopback service, and terminal-only ownership claim.",
    execution: "staging-enabled",
    risk: "stateful",
    targets: ["native-service"],
    image: { reference: "not-applicable-native-release", version: "1.2.6", digestPinned: true },
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

async function defaultUdpPortInspector(port, host) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.unref();
    socket.once("error", (error) => {
      socket.close();
      resolve(error.code === "EADDRINUSE" ? true : null);
    });
    socket.bind({ address: host, port, exclusive: true }, () => socket.close(() => resolve(false)));
  });
}

async function defaultKeelHealthInspector() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port: 3000, path: "/api/health", timeout: 2500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) request.destroy(new Error("Keel health response exceeded the fixed limit"));
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve(response.statusCode === 200 && value?.app === "keel" && value?.ok === true);
        } catch { resolve(false); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

export function listApplicationManifests() {
  return manifests.map(publicManifest);
}

export function createApplicationService({ store, prerequisites, helper, network, githubProvenance, inspectPort = defaultPortInspector, inspectUdpPort = defaultUdpPortInspector, inspectKeelHealth = defaultKeelHealthInspector, hostPlatform = process.platform, hostArchitecture = process.arch } = {}) {
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
          if (["uptime-kuma", "pi-hole"].includes(manifest.id) && live.installed) {
            try {
              live.lifecycle = await helper.request(`application.${manifest.id}.lifecycle.inspect`, {});
            } catch {
              live.lifecycle = { managed: false, allowedActions: [], revision: null, detail: "Managed lifecycle identity is unavailable" };
            }
            if (manifest.id === "uptime-kuma") {
              try {
                live.privateAccess = await helper.request("application.uptime-kuma.private-access.inspect", {});
              } catch {
                live.privateAccess = { connected: false, published: false, tailnetOnly: false, conflict: false, url: null, allowedActions: [], detail: "Private access inspection is unavailable" };
              }
            }
          }
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
        let staging;
        let installation;
        let loginProof;
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
          staging = await helper.request("application.keel.stage.inspect", {});
        } catch {
          staging = { state: "unavailable", staged: false, readyToStage: false, detail: "Keel staging evidence is unavailable" };
        }
        try {
          installation = await helper.request("application.keel.install.inspect", {});
          if (installation.installed) {
            const healthy = await inspectKeelHealth();
            installation = { ...installation, healthy, state: healthy ? "installed" : "degraded", listener: "127.0.0.1:3000", detail: healthy ? "Keel 1.2.6 is healthy on loopback under the dedicated keel account; terminal claim and private access handoff remain separate" : "The exact managed Keel installation exists but its live health identity is unavailable" };
          }
        } catch {
          installation = { state: "unavailable", installed: false, readyToInstall: false, serviceActive: false, serviceEnabled: false, healthy: false, listener: "unknown", claim: { state: "unavailable", terminalRequired: true }, detail: "Keel installation evidence is unavailable" };
        }
        try {
          loginProof = await helper.request("application.keel.login-proof.inspect", {});
        } catch {
          loginProof = { state: "unavailable", verified: false, verifiedAt: null, credentialsStored: false, sessionStored: false, detail: "Keel owner-login proof evidence is unavailable" };
        }
        try {
          const provenance = await githubProvenance?.inspect();
          const repository = provenance?.repositories?.find((item) => item.id === "keel");
          const release = repository?.latestRelease;
          const asset = release?.assets?.find((item) => item.name === keelArtifact.name);
          const matches = repository?.status === "available" && release?.tagName === keelArtifact.releaseTag && release?.commit?.sha === keelArtifact.releaseCommitSha && asset?.digest === keelArtifact.digest && asset?.sizeBytes === keelArtifact.sizeBytes;
          live = {
            ...discovery,
            ...(installation.installed ? { installed: true, state: installation.state, healthy: installation.healthy, version: installation.releaseVersion, listener: installation.listener, healthIdentityVerified: installation.healthy } : {}),
            artifact,
            archive,
            staging,
            installation,
            loginProof,
            provenance: { status: matches ? "matched" : "changed", checkedAt: provenance?.fetchedAt ?? null },
            detail: matches ? `${installation.installed ? installation.detail : discovery.detail}; exact public v1.2.6 release metadata matched` : `${installation.installed ? installation.detail : discovery.detail}; pinned Keel release provenance is unavailable or changed`,
          };
        } catch {
          live = { ...discovery, ...(installation.installed ? { installed: true, state: installation.state, healthy: installation.healthy, version: installation.releaseVersion, listener: installation.listener, healthIdentityVerified: installation.healthy } : {}), artifact, archive, staging, installation, loginProof, provenance: { status: "unavailable", checkedAt: null }, detail: `${installation.installed ? installation.detail : discovery.detail}; GitHub release provenance is unavailable` };
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
    if (manifest.id === "keel" && hostPort !== 3000) throw new Error("The reviewed Keel native-service adapter uses only fixed loopback port 3000");

    const inventory = await prerequisites.inspect();
    const required = new Set(manifest.targetPrerequisites?.[target] ?? manifest.prerequisites);
    if (manifest.id === "pi-hole" && target === "docker") required.delete("dns.port53");
    const relevantChecks = inventory.checks.filter((item) => required.has(item.id));
    const blockers = relevantChecks.filter((item) => item.status !== "ready").map((item) => ({ id: item.id, summary: item.summary, repair: item.repair }));
    let networkAssessment = null;
    let lanAddress = null;
    let fallbackDnsAddress = null;
    if (manifest.id === "pi-hole" && target === "docker") {
      try {
        if (typeof input?.networkAssessmentId !== "string") throw new Error("Create a Pi-hole on this server assessment in Network Center first");
        networkAssessment = await network.validateAssessment(input.networkAssessmentId, ownerId, "pihole-on-host");
        lanAddress = networkAssessment.input.serverAddress;
        fallbackDnsAddress = networkAssessment.input.fallbackDnsAddress;
      } catch (error) {
        blockers.push({ id: "network.assessment", summary: error.message, repair: { kind: "guided", description: "Open Network Center, select Pi-hole on this server, complete the recovery checklist, and generate a fresh assessment" } });
      }
      if (lanAddress) {
        const [dnsTcpInUse, dnsUdpInUse] = await Promise.all([inspectPort(53, lanAddress), inspectUdpPort(53, lanAddress)]);
        if (dnsTcpInUse === true) blockers.push({ id: "port.53.tcp", summary: `TCP port 53 is already in use on ${lanAddress}`, repair: { kind: "manual", description: "Identify the exact-address DNS listener or choose a separate reviewed VM address" } });
        if (dnsUdpInUse === true) blockers.push({ id: "port.53.udp", summary: `UDP port 53 is already in use on ${lanAddress}`, repair: { kind: "manual", description: "Identify the exact-address DNS listener or choose a separate reviewed VM address" } });
        if (dnsTcpInUse === null) blockers.push({ id: "port.53.tcp", summary: `BoxPilot could not verify TCP port 53 on ${lanAddress}`, repair: { kind: "manual", description: "Verify the exact LAN binding before approval" } });
        if (dnsUdpInUse === null) blockers.push({ id: "port.53.udp", summary: `BoxPilot could not verify UDP port 53 on ${lanAddress}`, repair: { kind: "manual", description: "Verify the exact LAN binding before approval" } });
      }
    }
    let keelDiscovery = null;
    let keelInstallation = null;
    let keelAction = "stage";
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
      try {
        keelInstallation = await helper.request("application.keel.install.inspect", {});
        keelAction = keelInstallation.readyToInstall === true ? "install" : "stage";
        if (keelInstallation.installed) {
          blockers.push({ id: "keel.managed-install", summary: keelInstallation.detail, repair: { kind: "guided", description: "Use the managed Keel lifecycle and claim guidance instead of creating another installation" } });
        } else if (!["absent"].includes(keelInstallation.state)) {
          blockers.push({ id: "keel.install-boundary", summary: keelInstallation.detail, repair: { kind: "manual", description: "Repair or recover the fixed managed Keel installation signals before another install" } });
        }
      } catch {
        keelInstallation = { state: "unavailable", installed: false, readyToInstall: false, detail: "Keel installation evidence is unavailable" };
        blockers.push({ id: "keel.install-boundary", summary: "The restricted helper could not inspect the fixed Keel installation boundary", repair: { kind: "manual", description: "Restore the helper and regenerate the plan" } });
      }
    }
    if (hostPort !== null && (manifest.id !== "keel" || keelAction === "install")) {
      const inspectedHost = manifest.id === "keel" ? "127.0.0.1" : lanAddress ?? "127.0.0.1";
      const portInUse = await inspectPort(hostPort, inspectedHost);
      if (portInUse === true) blockers.push({ id: `port.${hostPort}`, summary: `TCP port ${hostPort} is already in use on ${inspectedHost}`, repair: { kind: "manual", description: manifest.id === "keel" ? "Stop or move the conflicting loopback service; the reviewed Keel port is fixed" : `Choose another ${lanAddress ? "LAN" : "loopback"} web port` } });
      if (portInUse === null) blockers.push({ id: `port.${hostPort}`, summary: `BoxPilot could not verify TCP port ${hostPort}`, repair: { kind: "manual", description: "Verify the listener state before approval" } });
    }

    let artifact = manifest.artifact ? { ...manifest.artifact } : null;
    let keelArchive = null;
    let keelStaging = null;
    if (manifest.id === "keel") {
      try {
        const localArtifact = await helper.request("application.keel.artifact.inspect", {});
        artifact = { ...artifact, locallyVerifiedByBoxPilot: localArtifact.locallyVerified === true, localState: localArtifact.state, acquiredAt: localArtifact.acquiredAt ?? null };
        if (localArtifact.state !== "verified" || localArtifact.locallyVerified !== true || localArtifact.sha256 !== keelArtifact.digest) {
          blockers.push({ id: "keel.artifact", summary: "The exact Keel 1.2.6 artifact is not locally verified", repair: { kind: "guided", description: "Use the fixed artifact acquisition workflow, then generate a new staging plan" } });
        }
      } catch {
        artifact = { ...artifact, locallyVerifiedByBoxPilot: false, localState: "unavailable", acquiredAt: null };
        blockers.push({ id: "keel.artifact", summary: "The restricted helper could not verify the exact local Keel artifact", repair: { kind: "manual", description: "Restore the helper and regenerate the plan" } });
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
      try {
        keelStaging = await helper.request("application.keel.stage.inspect", {});
        if (keelStaging.state === "staged") {
          if (keelAction !== "install") blockers.push({ id: "keel.stage.exists", summary: "The exact Keel 1.2.6 release is already staged but is not safely installable", repair: { kind: "manual", description: "Inspect the fixed installation boundary before continuing" } });
        } else if (!keelStaging.readyToStage || !["absent", "partial"].includes(keelStaging.state)) {
          blockers.push({ id: "keel.stage.invalid", summary: keelStaging.detail ?? "The fixed Keel staging location cannot be verified safely", repair: { kind: "manual", description: "Inspect the root-only Keel release tree and helper evidence before creating another plan" } });
        }
      } catch {
        keelStaging = { state: "unavailable", staged: false, readyToStage: false, detail: "Keel staging inspection is unavailable" };
        blockers.push({ id: "keel.stage", summary: "The restricted helper could not verify the fixed Keel staging location", repair: { kind: "manual", description: "Restore the helper and regenerate the plan" } });
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
    }

    const warnings = [];
    if (manifest.id === "pi-hole") {
      warnings.push("This job starts a testable DNS service only. It cannot change router DHCP, advertise DNS, enable Pi-hole DHCP, alter Tailscale DNS, or move any client to Pi-hole.");
      if (target === "docker") warnings.push("Docker on this server ties this DNS service to this server's uptime. Keep the recorded emergency resolver working and complete a protected backup before any later cutover.");
      if (target === "virtual-machine") warnings.push("The dedicated VM adapter remains planning-only; use Docker staging or complete the VM application adapter in a later release.");
    }
    if (manifest.id === "uptime-kuma") warnings.push("After deployment, open Backups and complete the integrity and isolated restore workflow before treating this application as protected.");
    if (manifest.id === "keel") {
      warnings.push("The published release is source-available under BUSL-1.1. Personal self-hosting and internal organizational use are allowed; managed third-party hosting requires separate license review.");
      warnings.push("The upstream Linux installer uses a per-user install tree and systemd user unit. BoxPilot discovery recognizes that supported layout and fixed Docker evidence without reading .env or accepting a path from the browser.");
      warnings.push("Registration starts open. The managed install stays loopback-only, requires the five-minute one-use terminal claim, and must be closed or restricted before any broader exposure.");
      warnings.push("Keel backup and migration must coordinate SQLite writes and keep keel.db with any .keel-server-secrets.key companion. Copying a live database is not an accepted backup.");
      warnings.push(keelAction === "install"
        ? "This installation creates the dedicated account, private state, activation link, hardened systemd unit, and loopback listener. It does not claim an account, change registration, configure Tailscale Serve, open the firewall, or change the router."
        : "Safe staging only extracts and verifies a root-only inert release tree. It does not create application state, install a service, start Keel, open a listener, create an account, or change registration.");
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
    ] : keelAction === "install" ? [
      "Reverify the exact staged Keel 1.2.6 tree, release evidence, free loopback port, and absence of conflicting installation signals",
      "Create one dedicated non-login keel system account and private /var/lib/keel recovery unit",
      "Grant the dedicated group read and execute access to immutable root-owned release bytes without moving writable state into the release",
      "Atomically activate releases/1.2.6 through the fixed current link and install one exact hardened systemd unit",
      "Start Keel only on 127.0.0.1:3000 and require its exact JSON health identity and private SQLite file",
      "Leave account claim, registration policy, Tailscale Serve, firewall, DNS, DHCP, and router state unchanged",
    ] : [
      `Reverify ${keelArtifact.name} from fixed ${keelArtifact.releaseTag} evidence, including its ${keelArtifact.sizeBytes}-byte identity and complete local ${keelArtifact.digest} digest`,
      `Require the runtime archive gate to report exactly ${keelArtifact.archiveMembersObservedDuringAdapterReview} safe members and no links, devices, traversal, extensions, duplicates, or changed roots`,
      "Extract into one helper-generated partial directory under the fixed BoxPilot Keel release root",
      "Reject state, secrets, links, hard links, missing runtime files, changed package identity, or changed extracted membership",
      "Harden the complete release tree to root-only access and atomically publish fixed staging evidence",
      "Leave service installation, application state, accounts, registration, listeners, execution, backups, restore, import, and exposure unchanged",
    ];

    const stageId = manifest.id === "keel" && keelAction === "stage" ? randomUUID() : null;
    const installId = manifest.id === "keel" && keelAction === "install" ? randomUUID() : null;

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
      stagingInspection: manifest.id === "keel" ? keelStaging : undefined,
      installationInspection: manifest.id === "keel" ? keelInstallation : undefined,
      keelAction: manifest.id === "keel" ? keelAction : undefined,
      discovery: manifest.id === "keel" ? keelDiscovery : undefined,
      changes,
      blockers,
      warnings,
      recovery: { summary: manifest.rollback, preservesData: true },
      executable: ((manifest.execution === "enabled" && target === "docker") || (manifest.id === "keel" && target === "native-service")) && blockers.length === 0,
    };
    return store.createPlan({
      type: "application.deploy",
      subjectId: manifest.id,
      input: { target, hostPort, networkAssessmentId: networkAssessment?.id ?? null, lanAddress, fallbackDnsAddress, ...(stageId ? { stageId, keelAction: "stage" } : {}), ...(installId ? { installId, keelAction: "install" } : {}) },
      output,
      createdBy: ownerId,
    });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "application.deploy") throw new Error("Plan not found");
    if (plan.revision !== revision) throw new Error("Plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("Plan has unresolved blockers or is planning-only");
    if (!["uptime-kuma", "pi-hole", "keel"].includes(plan.subjectId)) throw new Error("Application execution is not enabled for this adapter");

    if (plan.subjectId === "pi-hole") {
      await network.validateAssessment(plan.input.networkAssessmentId, ownerId, "pihole-on-host");
      const [dnsTcpInUse, dnsUdpInUse] = await Promise.all([inspectPort(53, plan.input.lanAddress), inspectUdpPort(53, plan.input.lanAddress)]);
      if (dnsTcpInUse !== false || dnsUdpInUse !== false) throw new Error("Host state changed: exact-address TCP and UDP port 53 are no longer verified free");
    }
    if (plan.subjectId !== "keel") {
      const portInUse = await inspectPort(plan.input.hostPort, plan.input.lanAddress ?? "127.0.0.1");
      if (portInUse !== false) throw new Error("Host state changed: the planned port is no longer verified free");
    }
    store.stagePlan(plan.id, ownerId);
    const isPihole = plan.subjectId === "pi-hole";
    const isKeel = plan.subjectId === "keel";
    const isKeelInstall = isKeel && plan.input.keelAction === "install";
    return store.createJob({
      type: isKeelInstall ? "application.keel.install" : isKeel ? "application.keel.stage" : isPihole ? "application.pi-hole.deploy" : "application.uptime-kuma.deploy",
      title: isKeelInstall ? "Install private Keel 1.2.6 service" : isKeel ? "Stage Keel 1.2.6 release tree" : isPihole ? "Stage Pi-hole on this server" : "Deploy Uptime Kuma",
      risk: isKeelInstall ? "stateful-install" : isKeel ? "stateful-staging" : isPihole ? "network-critical" : "low",
      parameters: { planId: plan.id, revision: plan.revision, hostPort: plan.input.hostPort, ...(isPihole ? { lanAddress: plan.input.lanAddress, networkAssessmentId: plan.input.networkAssessmentId } : {}), ...(isKeelInstall ? { installId: plan.input.installId } : isKeel ? { stageId: plan.input.stageId } : {}) },
      recovery: {
        automaticRollback: true,
        reason: isKeelInstall ? "A failed activation stops and disables the new service, removes only its generated unit, environment file, and activation link, and preserves /var/lib/keel for recovery." : isKeel ? "A failed helper operation removes only its generated partial or newly published inert 1.2.6 release tree; no application state or service exists." : isPihole ? "The managed stack can be removed or its prior Compose definition restored without changing router or client DNS." : "The curated stack can be stopped and its previous Compose definition restored without deleting application data.",
        manual: isKeelInstall ? "If automatic rollback is incomplete, keep /var/lib/keel, stop keel.service, and inspect only the fixed unit, activation link, and install evidence. Do not delete the database or managed-secret key." : isKeel ? "If automatic cleanup cannot complete, inspect only /var/lib/boxpilot-managed/apps/keel/releases and the fixed 1.2.6 stage evidence. Do not delete any future /var/lib/keel application state." : isPihole ? "If automated rollback fails, remove only boxpilot-pi-hole and preserve /var/lib/boxpilot-managed/apps/pi-hole before repair. Router and client DNS were not changed." : "If automated rollback fails, stop boxpilot-uptime-kuma and preserve /var/lib/boxpilot-managed/apps/uptime-kuma/data before repair.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: isKeelInstall ? "Exact staged release, dedicated-account namespace, private state path, fixed port 3000, helper, systemd, and absence of conflicting install signals validated" : isKeel ? "Manifest integrity, platform, public provenance, exact local artifact, runtime archive membership, storage, helper, and empty fixed release destination validated" : isPihole ? "Manifest integrity, Docker, exact LAN address, TCP and UDP DNS binding, web port, Tailscale, and recovery assessment validated" : "Manifest integrity, Docker availability, storage, helper, and loopback port validated" },
        { name: "checkpoint", state: "completed", detail: isKeelInstall ? "Writable state is the preserved recovery unit; service, environment, and activation changes have exact rollback targets" : isKeel ? "Only a helper-generated partial and fixed inert release tree may be created; application state, services, listeners, accounts, and registration stay unchanged" : "Existing Compose definition will be copied before replacement and application data will not be deleted" },
      ],
    });
  }

  async function validateJob(job) {
    if (!["application.uptime-kuma.deploy", "application.pi-hole.deploy", "application.keel.stage", "application.keel.install"].includes(job.type)) throw new Error("Unsupported application job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.revision !== job.parameters.revision) throw new Error("The staged application plan is unavailable or changed");
    const expectedSubject = ["application.keel.stage", "application.keel.install"].includes(job.type) ? "keel" : job.type === "application.pi-hole.deploy" ? "pi-hole" : "uptime-kuma";
    if (plan.subjectId !== expectedSubject || plan.input.hostPort !== job.parameters.hostPort) throw new Error("The staged application plan does not match the requested adapter or port");
    if (job.type === "application.keel.stage" && (plan.input.stageId !== job.parameters.stageId || !/^[a-f0-9-]{36}$/.test(job.parameters.stageId))) throw new Error("The staged Keel plan does not match its fixed stage identifier");
    if (job.type === "application.keel.install" && (plan.input.installId !== job.parameters.installId || plan.input.keelAction !== "install" || !/^[a-f0-9-]{36}$/.test(job.parameters.installId))) throw new Error("The staged Keel install plan does not match its fixed install identifier");
    const inventory = await prerequisites.inspect();
    const required = new Set(["application.keel.stage", "application.keel.install"].includes(job.type) ? ["runtime.node", "storage.state", "helper.boundary"] : ["storage.state", "helper.boundary", "containers.docker"]);
    const blocker = inventory.checks.find((item) => required.has(item.id) && item.status !== "ready");
    if (blocker) throw new Error(`Host state changed: ${blocker.summary}`);
    if (job.type === "application.pi-hole.deploy") {
      const assessment = await network.validateAssessment(plan.input.networkAssessmentId, job.createdBy, "pihole-on-host");
      if (assessment.input.serverAddress !== plan.input.lanAddress || job.parameters.lanAddress !== plan.input.lanAddress) throw new Error("Host state changed: the reviewed Pi-hole LAN address no longer matches");
      const [dnsTcpInUse, dnsUdpInUse] = await Promise.all([inspectPort(53, plan.input.lanAddress), inspectUdpPort(53, plan.input.lanAddress)]);
      if (dnsTcpInUse !== false || dnsUdpInUse !== false) throw new Error("Host state changed: exact-address TCP and UDP port 53 are no longer verified free");
    }
    if (job.type === "application.keel.stage") {
      const [artifactState, archiveState, stageState] = await Promise.all([
        helper.request("application.keel.artifact.inspect", {}),
        helper.request("application.keel.archive.inspect", {}),
        helper.request("application.keel.stage.inspect", {}),
      ]);
      if (artifactState.state !== "verified" || artifactState.locallyVerified !== true || artifactState.sha256 !== keelArtifact.digest) throw new Error("Host state changed: the exact Keel artifact is not locally verified");
      if (archiveState.state !== "safe" || archiveState.safeToExtract !== true || archiveState.memberCount !== keelArtifact.archiveMembersObservedDuringAdapterReview || archiveState.risks?.length !== 0) throw new Error("Host state changed: the Keel archive no longer passes its runtime gate");
      if (!stageState.readyToStage || !["absent", "partial"].includes(stageState.state)) throw new Error("Host state changed: the fixed Keel release destination is not safely stageable");
      const provenance = await githubProvenance?.inspect();
      const repository = provenance?.repositories?.find((item) => item.id === "keel");
      const release = repository?.latestRelease;
      const asset = release?.assets?.find((item) => item.name === keelArtifact.name);
      if (repository?.status !== "available" || release?.tagName !== keelArtifact.releaseTag || release?.commit?.sha !== keelArtifact.releaseCommitSha || asset?.digest !== keelArtifact.digest || asset?.sizeBytes !== keelArtifact.sizeBytes) throw new Error("Host state changed: the fixed Keel public release provenance no longer matches");
    } else if (job.type === "application.keel.install") {
      const [discoveryState, stageState, installState] = await Promise.all([
        helper.request("application.keel.inspect", {}),
        helper.request("application.keel.stage.inspect", {}),
        helper.request("application.keel.install.inspect", {}),
      ]);
      if (discoveryState.installed || discoveryState.state === "ambiguous" || discoveryState.risks?.length) throw new Error("Host state changed: conflicting Keel installation evidence appeared");
      if (stageState.state !== "staged" || stageState.staged !== true || stageState.version !== keelArtifact.releaseTag.slice(1)) throw new Error("Host state changed: the exact Keel release is no longer safely staged");
      if (installState.state !== "absent" || installState.readyToInstall !== true) throw new Error("Host state changed: the fixed Keel installation boundary is no longer empty");
      const portInUse = await inspectPort(plan.input.hostPort, "127.0.0.1");
      if (portInUse !== false) throw new Error("Host state changed: fixed loopback TCP port 3000 is no longer verified free");
    } else if (await inspectPort(job.parameters.hostPort, plan.input.lanAddress ?? "127.0.0.1") !== false) throw new Error("Host state changed: the planned port is no longer verified free");
    return plan;
  }

  return { list, plan, stage, validateJob, getManifest };
}

export const applicationInternals = { canonical, defaultKeelHealthInspector, defaultPortInspector, defaultUdpPortInspector, keelArtifact, uptimeKumaImage, piholeImage };
