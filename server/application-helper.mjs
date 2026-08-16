import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { applicationInternals } from "./applications.mjs";

const execFile = promisify(execFileCallback);
const containerName = "boxpilot-uptime-kuma";
const piholeContainerName = "boxpilot-pi-hole";
const piholeCapabilities = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETUID"];
const logSources = {
  boxpilot: ["boxpilot.service", "boxpilot-helper.service"],
  docker: ["docker.service"],
  tailscale: ["tailscaled.service"],
  virtualization: ["libvirtd.service", "virtqemud.service"],
};

function composeDefinition(hostPort) {
  return `services:
  uptime-kuma:
    container_name: ${containerName}
    image: ${applicationInternals.uptimeKumaImage}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${hostPort}:3001"
    volumes:
      - ./data:/app/data
`;
}

function piholeComposeDefinition(lanAddress, webPort) {
  return `services:
  pi-hole:
    container_name: ${piholeContainerName}
    image: ${applicationInternals.piholeImage}
    restart: unless-stopped
    cap_drop:
      - ALL
    cap_add:
${piholeCapabilities.map((capability) => `      - ${capability}`).join("\n")}
    security_opt:
      - no-new-privileges:true
    environment:
      TZ: America/Chicago
      FTLCONF_dns_listeningMode: ALL
      FTLCONF_webserver_api_password: \${PIHOLE_PASSWORD}
    ports:
      - "${lanAddress}:53:53/tcp"
      - "${lanAddress}:53:53/udp"
      - "${lanAddress}:${webPort}:80/tcp"
    volumes:
      - ./etc-pihole:/etc/pihole
`;
}

async function defaultDockerRunner(binary, args, { timeout = 120000 } = {}) {
  const result = await execFile(binary, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function defaultArchiveRunner(binary, args, { timeout = 180000 } = {}) {
  const result = await execFile(binary, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function checksum(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonLines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function sanitizeLogMessage(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[query-redacted]")
    .slice(0, 500);
}

export function createApplicationHelper({
  appRoot = process.env.BOXPILOT_APP_ROOT ?? "/var/lib/boxpilot-managed/apps",
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  tarBinary = process.env.BOXPILOT_TAR_BINARY ?? "/usr/bin/tar",
  journalctlBinary = process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl",
  runDocker = defaultDockerRunner,
  runArchive = defaultArchiveRunner,
  runJournal = defaultArchiveRunner,
  wait = delay,
  clock = () => Date.now(),
} = {}) {
  const resolvedRoot = path.resolve(appRoot);
  const managedRoot = path.dirname(resolvedRoot);
  const appDirectory = path.join(resolvedRoot, "uptime-kuma");
  const dataDirectory = path.join(appDirectory, "data");
  const composePath = path.join(appDirectory, "compose.yaml");
  const previousPath = path.join(appDirectory, "compose.yaml.previous");
  const piholeDirectory = path.join(resolvedRoot, "pi-hole");
  const piholeDataDirectory = path.join(piholeDirectory, "etc-pihole");
  const piholeComposePath = path.join(piholeDirectory, "compose.yaml");
  const piholePreviousPath = path.join(piholeDirectory, "compose.yaml.previous");
  const piholeSecretPath = path.join(piholeDirectory, "admin-password");
  const piholeBackupDirectory = path.join(managedRoot, "backups", "pi-hole");
  const piholeBackupMarkerPath = path.join(piholeBackupDirectory, "active-backup.json");
  const piholeRestoreRoot = path.join(managedRoot, "restore-drills");

  async function docker(args, options) {
    return runDocker(dockerBinary, args, options);
  }

  async function inspect() {
    try {
      const result = await docker(["inspect", "--format", "{{json .State}}", containerName], { timeout: 5000 });
      const state = JSON.parse(result.stdout);
      let port = null;
      try {
        const portResult = await docker(["port", containerName, "3001/tcp"], { timeout: 5000 });
        const match = portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
        if (match) port = Number.parseInt(match[1], 10);
      } catch {
        port = null;
      }
      return {
        installed: true,
        state: state.Running ? "running" : state.Status ?? "stopped",
        healthy: state.Running && !state.Error && (!state.Health || state.Health.Status === "healthy"),
        port,
        detail: state.Running ? `Managed container is running${port ? ` on loopback port ${port}` : ""}` : "Managed container is not running",
      };
    } catch {
      return { installed: false, state: "not-installed", healthy: false, port: null, detail: "Managed Uptime Kuma container was not found" };
    }
  }

  async function inspectUptimeKumaLifecycle() {
    try {
      const result = await docker(["inspect", "--format", "{{json .}}", containerName], { timeout: 5000 });
      const container = JSON.parse(result.stdout);
      const state = container.State ?? {};
      const bindings = container.HostConfig?.PortBindings?.["3001/tcp"] ?? [];
      const binding = Array.isArray(bindings) && bindings.length === 1 ? bindings[0] : null;
      const port = binding?.HostIp === "127.0.0.1" && /^\d{1,5}$/.test(String(binding?.HostPort ?? ""))
        ? Number.parseInt(binding.HostPort, 10)
        : null;
      const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
      const exactDataMount = mounts.length === 1
        && mounts[0]?.Type === "bind"
        && path.resolve(mounts[0]?.Source ?? "/") === dataDirectory
        && mounts[0]?.Destination === "/app/data"
        && mounts[0]?.RW === true;
      const labels = container.Config?.Labels ?? {};
      const devices = Array.isArray(container.HostConfig?.Devices) ? container.HostConfig.Devices : [];
      const capAdd = Array.isArray(container.HostConfig?.CapAdd) ? container.HostConfig.CapAdd : [];
      const managed = container.Name === `/${containerName}`
        && container.Config?.Image === applicationInternals.uptimeKumaImage
        && labels["com.docker.compose.project"] === containerName
        && labels["com.docker.compose.service"] === "uptime-kuma"
        && container.HostConfig?.RestartPolicy?.Name === "unless-stopped"
        && container.HostConfig?.Privileged === false
        && devices.length === 0
        && capAdd.length === 0
        && exactDataMount
        && Number.isInteger(port)
        && port >= 1024
        && port <= 65535;
      const running = state.Running === true;
      const healthy = managed && running && !state.Error && state.Health?.Status === "healthy";
      const revisionEvidence = {
        id: String(container.Id ?? ""),
        imageId: String(container.Image ?? ""),
        configuredImage: String(container.Config?.Image ?? ""),
        name: String(container.Name ?? ""),
        state: String(state.Status ?? "unknown"),
        running,
        health: String(state.Health?.Status ?? "none"),
        port,
        restartPolicy: String(container.HostConfig?.RestartPolicy?.Name ?? ""),
        project: String(labels["com.docker.compose.project"] ?? ""),
        service: String(labels["com.docker.compose.service"] ?? ""),
        exactDataMount,
        privileged: container.HostConfig?.Privileged === true,
        deviceCount: devices.length,
        capAdd: [...capAdd].sort(),
      };
      const revision = createHash("sha256").update(applicationInternals.canonical(revisionEvidence)).digest("hex");
      return {
        installed: true,
        managed,
        state: running ? "running" : "stopped",
        running,
        healthy,
        port,
        revision,
        allowedActions: managed ? running ? ["stop", "restart"] : ["start"] : [],
        detail: managed
          ? running
            ? `Managed Uptime Kuma is ${healthy ? "healthy" : "running but unhealthy"} on loopback port ${port}`
            : "Managed Uptime Kuma is stopped and can be started through an approved action"
          : "A container uses the reserved Uptime Kuma name but failed the fixed managed identity checks",
        boundary: {
          exactContainerName: true,
          digestPinnedImage: container.Config?.Image === applicationInternals.uptimeKumaImage,
          loopbackOnly: Number.isInteger(port),
          exactDataMount,
          privileged: container.HostConfig?.Privileged === true,
          deviceCount: devices.length,
          addedCapabilities: capAdd.length,
          dockerSocketMounted: mounts.some((mount) => mount?.Source === "/var/run/docker.sock" || mount?.Destination === "/var/run/docker.sock"),
          arbitraryContainerAccepted: false,
          arbitraryCommandAccepted: false,
          mutationPerformed: false,
        },
      };
    } catch {
      return {
        installed: false,
        managed: false,
        state: "not-installed",
        running: false,
        healthy: false,
        port: null,
        revision: null,
        allowedActions: [],
        detail: "Managed Uptime Kuma container was not found",
        boundary: {
          exactContainerName: true,
          digestPinnedImage: false,
          loopbackOnly: false,
          exactDataMount: false,
          privileged: false,
          deviceCount: 0,
          addedCapabilities: 0,
          dockerSocketMounted: false,
          arbitraryContainerAccepted: false,
          arbitraryCommandAccepted: false,
          mutationPerformed: false,
        },
      };
    }
  }

  async function actionUptimeKuma({ action, expectedRevision }) {
    if (!["start", "stop", "restart"].includes(action) || !/^[a-f0-9]{64}$/.test(String(expectedRevision ?? ""))) {
      throw new Error("Uptime Kuma lifecycle accepts only a fixed action and exact state revision");
    }
    const before = await inspectUptimeKumaLifecycle();
    if (!before.installed || !before.managed || before.revision !== expectedRevision) throw new Error("Managed Uptime Kuma state changed or failed identity validation");
    if (!before.allowedActions.includes(action)) throw new Error(`Uptime Kuma ${action} is not valid while the container is ${before.state}`);

    if (action === "start") await docker(["start", containerName], { timeout: 30000 });
    if (action === "stop") await docker(["stop", "--time", "30", containerName], { timeout: 45000 });
    if (action === "restart") await docker(["restart", "--time", "30", containerName], { timeout: 60000 });
    if (action !== "stop") await verifyHealth(containerName);

    const after = await inspectUptimeKumaLifecycle();
    if (!after.installed || !after.managed) throw new Error("Managed Uptime Kuma failed post-action identity validation");
    if (action === "stop" ? after.running : !after.running || !after.healthy) throw new Error(`Uptime Kuma ${action} failed post-action state verification`);
    const dataState = await stat(dataDirectory);
    if (!dataState.isDirectory()) throw new Error("Managed Uptime Kuma data directory failed preservation verification");
    return {
      applicationId: "uptime-kuma",
      action,
      performed: true,
      expectedRevision,
      revisionAfter: after.revision,
      state: after.state,
      running: after.running,
      healthy: after.healthy,
      port: after.port,
      dataPreserved: true,
      boundary: {
        exactContainerOnly: true,
        imageChanged: false,
        composeChanged: false,
        dataDeleted: false,
        networkDeleted: false,
        arbitraryContainerAccepted: false,
        arbitraryCommandAccepted: false,
      },
    };
  }

  async function inspectPihole() {
    try {
      const result = await docker(["inspect", "--format", "{{json .State}}", piholeContainerName], { timeout: 5000 });
      const state = JSON.parse(result.stdout);
      let lanAddress = null;
      let webPort = null;
      let dnsTcpBound = false;
      let dnsUdpBound = false;
      try {
        const [tcp, udp, web] = await Promise.all([
          docker(["port", piholeContainerName, "53/tcp"], { timeout: 5000 }),
          docker(["port", piholeContainerName, "53/udp"], { timeout: 5000 }),
          docker(["port", piholeContainerName, "80/tcp"], { timeout: 5000 }),
        ]);
        const tcpMatch = tcp.stdout.match(/([0-9.]+):53$/m);
        const udpMatch = udp.stdout.match(/([0-9.]+):53$/m);
        const webMatch = web.stdout.match(/([0-9.]+):(\d+)$/m);
        dnsTcpBound = Boolean(tcpMatch);
        dnsUdpBound = Boolean(udpMatch);
        if (tcpMatch && udpMatch && webMatch && tcpMatch[1] === udpMatch[1] && tcpMatch[1] === webMatch[1]) {
          lanAddress = tcpMatch[1];
          webPort = Number.parseInt(webMatch[2], 10);
        }
      } catch {
        lanAddress = null;
        webPort = null;
      }
      const healthy = state.Running && !state.Error && state.Health?.Status === "healthy" && dnsTcpBound && dnsUdpBound && Boolean(lanAddress) && Boolean(webPort);
      return {
        installed: true,
        state: state.Running ? "running" : state.Status ?? "stopped",
        healthy,
        lanAddress,
        port: webPort,
        webUrl: lanAddress && webPort ? `http://${lanAddress}:${webPort}/admin/` : null,
        dnsTcpBound,
        dnsUdpBound,
        dhcpEnabled: false,
        routerMutationPerformed: false,
        dnsCutoverPerformed: false,
        backupProtected: false,
        secretRetrievalCommand: "sudo sed -n 's/^PIHOLE_PASSWORD=//p' /var/lib/boxpilot-managed/apps/pi-hole/admin-password",
        detail: healthy ? `Managed Pi-hole is healthy on ${lanAddress}; no router or client DNS setting was changed` : "Managed Pi-hole exists but did not pass all DNS and web binding checks",
      };
    } catch {
      return {
        installed: false, state: "not-installed", healthy: false, lanAddress: null, port: null, webUrl: null,
        dnsTcpBound: false, dnsUdpBound: false, dhcpEnabled: false, routerMutationPerformed: false,
        dnsCutoverPerformed: false, backupProtected: false,
        secretRetrievalCommand: "sudo sed -n 's/^PIHOLE_PASSWORD=//p' /var/lib/boxpilot-managed/apps/pi-hole/admin-password",
        detail: "Managed Pi-hole container was not found; router and client DNS are unchanged",
      };
    }
  }

  async function inspectPiholeLifecycle() {
    try {
      const result = await docker(["inspect", "--format", "{{json .}}", piholeContainerName], { timeout: 5000 });
      const container = JSON.parse(result.stdout);
      const state = container.State ?? {};
      const portBindings = container.HostConfig?.PortBindings ?? {};
      const binding = (containerPort) => {
        const candidates = portBindings[containerPort] ?? [];
        return Array.isArray(candidates) && candidates.length === 1 ? candidates[0] : null;
      };
      const dnsTcp = binding("53/tcp");
      const dnsUdp = binding("53/udp");
      const web = binding("80/tcp");
      const lanAddress = dnsTcp?.HostIp === dnsUdp?.HostIp && dnsTcp?.HostIp === web?.HostIp && net.isIP(String(dnsTcp?.HostIp ?? "")) === 4
        ? dnsTcp.HostIp
        : null;
      const dnsTcpBound = Boolean(lanAddress) && dnsTcp?.HostPort === "53";
      const dnsUdpBound = Boolean(lanAddress) && dnsUdp?.HostPort === "53";
      const webPort = Boolean(lanAddress) && /^\d{1,5}$/.test(String(web?.HostPort ?? "")) ? Number.parseInt(web.HostPort, 10) : null;
      const privateLanAddress = Boolean(lanAddress) && (() => {
        const [first, second] = lanAddress.split(".").map(Number);
        return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
      })();
      const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
      const exactDataMount = mounts.length === 1
        && mounts[0]?.Type === "bind"
        && path.resolve(mounts[0]?.Source ?? "/") === piholeDataDirectory
        && mounts[0]?.Destination === "/etc/pihole"
        && mounts[0]?.RW === true;
      const labels = container.Config?.Labels ?? {};
      const devices = Array.isArray(container.HostConfig?.Devices) ? container.HostConfig.Devices : [];
      const capAdd = Array.isArray(container.HostConfig?.CapAdd)
        ? container.HostConfig.CapAdd.map((capability) => String(capability).replace(/^CAP_/, "")).sort()
        : [];
      const capDrop = Array.isArray(container.HostConfig?.CapDrop) ? [...container.HostConfig.CapDrop].sort() : [];
      const securityOptions = Array.isArray(container.HostConfig?.SecurityOpt) ? [...container.HostConfig.SecurityOpt].sort() : [];
      const expectedCapabilities = [...piholeCapabilities].sort();
      const dockerSocketMounted = mounts.some((mount) => mount?.Source === "/var/run/docker.sock" || mount?.Destination === "/var/run/docker.sock");
      let dataDirectoryReady = false;
      let secretFileReady = false;
      let secretEvidence = { size: null, modifiedAt: null };
      try {
        dataDirectoryReady = (await stat(piholeDataDirectory)).isDirectory();
        const secretState = await stat(piholeSecretPath);
        secretFileReady = secretState.isFile() && (secretState.mode & 0o777) === 0o600 && secretState.size > 0;
        secretEvidence = { size: secretState.size, modifiedAt: secretState.mtimeMs };
      } catch {
        dataDirectoryReady = false;
        secretFileReady = false;
      }
      const managed = container.Name === `/${piholeContainerName}`
        && container.Config?.Image === applicationInternals.piholeImage
        && labels["com.docker.compose.project"] === piholeContainerName
        && labels["com.docker.compose.service"] === "pi-hole"
        && container.HostConfig?.RestartPolicy?.Name === "unless-stopped"
        && container.HostConfig?.Privileged === false
        && devices.length === 0
        && JSON.stringify(capAdd) === JSON.stringify(expectedCapabilities)
        && capDrop.length === 1
        && capDrop[0] === "ALL"
        && securityOptions.includes("no-new-privileges:true")
        && exactDataMount
        && dataDirectoryReady
        && secretFileReady
        && !dockerSocketMounted
        && privateLanAddress
        && dnsTcpBound
        && dnsUdpBound
        && Number.isInteger(webPort)
        && webPort >= 1024
        && webPort <= 65535;
      const running = state.Running === true;
      const healthy = managed && running && !state.Error && state.Health?.Status === "healthy";
      const revisionEvidence = {
        id: String(container.Id ?? ""),
        imageId: String(container.Image ?? ""),
        configuredImage: String(container.Config?.Image ?? ""),
        name: String(container.Name ?? ""),
        state: String(state.Status ?? "unknown"),
        running,
        health: String(state.Health?.Status ?? "none"),
        lanAddress,
        webPort,
        dnsTcpBound,
        dnsUdpBound,
        restartPolicy: String(container.HostConfig?.RestartPolicy?.Name ?? ""),
        project: String(labels["com.docker.compose.project"] ?? ""),
        service: String(labels["com.docker.compose.service"] ?? ""),
        exactDataMount,
        dataDirectoryReady,
        secretFileReady,
        secretEvidence,
        privileged: container.HostConfig?.Privileged === true,
        deviceCount: devices.length,
        capAdd,
        capDrop,
        securityOptions,
        dockerSocketMounted,
      };
      const revision = createHash("sha256").update(applicationInternals.canonical(revisionEvidence)).digest("hex");
      return {
        installed: true,
        managed,
        state: running ? "running" : "stopped",
        running,
        healthy,
        lanAddress,
        port: webPort,
        dnsTcpBound,
        dnsUdpBound,
        revision,
        allowedActions: managed ? running ? ["stop", "restart"] : ["start"] : [],
        detail: managed
          ? running
            ? `Managed Pi-hole is ${healthy ? "healthy" : "running but unhealthy"} on ${lanAddress}; router and client DNS remain unchanged`
            : `Managed Pi-hole is stopped on ${lanAddress}; keep clients on an independent resolver before an approved Start`
          : "A container uses the reserved Pi-hole name but failed the fixed managed identity checks",
        boundary: {
          exactContainerName: true,
          digestPinnedImage: container.Config?.Image === applicationInternals.piholeImage,
          privateLanOnly: privateLanAddress,
          exactDnsBindings: dnsTcpBound && dnsUdpBound,
          exactWebBinding: Number.isInteger(webPort),
          exactDataMount,
          dataDirectoryReady,
          secretFileReady,
          privileged: container.HostConfig?.Privileged === true,
          deviceCount: devices.length,
          addedCapabilities: capAdd,
          droppedCapabilities: capDrop,
          noNewPrivileges: securityOptions.includes("no-new-privileges:true"),
          dockerSocketMounted,
          dhcpEnabled: false,
          routerMutationPerformed: false,
          dnsCutoverPerformed: false,
          arbitraryContainerAccepted: false,
          arbitraryCommandAccepted: false,
          mutationPerformed: false,
        },
      };
    } catch {
      return {
        installed: false,
        managed: false,
        state: "not-installed",
        running: false,
        healthy: false,
        lanAddress: null,
        port: null,
        dnsTcpBound: false,
        dnsUdpBound: false,
        revision: null,
        allowedActions: [],
        detail: "Managed Pi-hole container was not found; router and client DNS are unchanged",
        boundary: {
          exactContainerName: true,
          digestPinnedImage: false,
          privateLanOnly: false,
          exactDnsBindings: false,
          exactWebBinding: false,
          exactDataMount: false,
          dataDirectoryReady: false,
          secretFileReady: false,
          privileged: false,
          deviceCount: 0,
          addedCapabilities: [],
          droppedCapabilities: [],
          noNewPrivileges: false,
          dockerSocketMounted: false,
          dhcpEnabled: false,
          routerMutationPerformed: false,
          dnsCutoverPerformed: false,
          arbitraryContainerAccepted: false,
          arbitraryCommandAccepted: false,
          mutationPerformed: false,
        },
      };
    }
  }

  async function actionPihole({ action, expectedRevision }) {
    if (!["start", "stop", "restart"].includes(action) || !/^[a-f0-9]{64}$/.test(String(expectedRevision ?? ""))) {
      throw new Error("Pi-hole lifecycle accepts only a fixed action and exact state revision");
    }
    const before = await inspectPiholeLifecycle();
    if (!before.installed || !before.managed || before.revision !== expectedRevision) throw new Error("Managed Pi-hole state changed or failed identity validation");
    if (!before.allowedActions.includes(action)) throw new Error(`Pi-hole ${action} is not valid while the container is ${before.state}`);

    if (action === "start") await docker(["start", piholeContainerName], { timeout: 30000 });
    if (action === "stop") await docker(["stop", "--time", "30", piholeContainerName], { timeout: 45000 });
    if (action === "restart") await docker(["restart", "--time", "30", piholeContainerName], { timeout: 60000 });
    if (action !== "stop") await verifyHealth(piholeContainerName);

    const after = await inspectPiholeLifecycle();
    if (!after.installed || !after.managed) throw new Error("Managed Pi-hole failed post-action identity validation");
    if (action === "stop" ? after.running : !after.running || !after.healthy || !after.dnsTcpBound || !after.dnsUdpBound) throw new Error(`Pi-hole ${action} failed post-action state or binding verification`);
    const dataState = await stat(piholeDataDirectory);
    const secretState = await stat(piholeSecretPath);
    if (!dataState.isDirectory() || !secretState.isFile() || (secretState.mode & 0o777) !== 0o600 || secretState.size <= 0) throw new Error("Managed Pi-hole data or administrator secret failed preservation verification");
    return {
      applicationId: "pi-hole",
      action,
      performed: true,
      expectedRevision,
      revisionAfter: after.revision,
      state: after.state,
      running: after.running,
      healthy: after.healthy,
      lanAddress: after.lanAddress,
      port: after.port,
      dnsTcpBound: after.dnsTcpBound,
      dnsUdpBound: after.dnsUdpBound,
      dataPreserved: true,
      secretPreserved: true,
      dhcpEnabled: false,
      routerMutationPerformed: false,
      dnsCutoverPerformed: false,
      boundary: {
        exactContainerOnly: true,
        imageChanged: false,
        composeChanged: false,
        dataDeleted: false,
        secretDeleted: false,
        networkDeleted: false,
        routerChanged: false,
        clientDnsChanged: false,
        tailscaleChanged: false,
        arbitraryContainerAccepted: false,
        arbitraryCommandAccepted: false,
      },
    };
  }

  async function inspectDocker() {
    const result = await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    return { available: true, version: result.stdout || "available" };
  }

  async function inventoryDocker() {
    const [containerResult, imageResult, networkResult, volumeResult, projectResult] = await Promise.all([
      docker(["ps", "--all", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["image", "ls", "--digests", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["network", "ls", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["volume", "ls", "--format", "{{json .}}"], { timeout: 15000 }),
      docker(["compose", "ls", "--all", "--format", "json"], { timeout: 15000 }),
    ]);
    const containers = parseJsonLines(containerResult.stdout).map((item) => ({
      id: String(item.ID ?? "").slice(0, 12), name: item.Names ?? null, image: item.Image ?? null,
      state: item.State ?? "unknown", status: item.Status ?? "unknown", ports: item.Ports ?? "", networks: item.Networks ?? "",
    }));
    const images = parseJsonLines(imageResult.stdout).map((item) => ({ repository: item.Repository ?? null, tag: item.Tag ?? null, digest: item.Digest === "<none>" ? null : item.Digest ?? null, id: String(item.ID ?? "").slice(0, 19), size: item.Size ?? null }));
    const networks = parseJsonLines(networkResult.stdout).map((item) => ({ name: item.Name ?? null, driver: item.Driver ?? null, scope: item.Scope ?? null, internal: item.Internal === "true", ipv6: item.IPv6 === "true" }));
    const volumes = parseJsonLines(volumeResult.stdout).map((item) => ({ name: item.Name ?? null, driver: item.Driver ?? null, scope: item.Scope ?? null }));
    let projects = [];
    try {
      const parsed = JSON.parse(projectResult.stdout || "[]");
      projects = (Array.isArray(parsed) ? parsed : []).map((item) => ({ name: item.Name ?? null, status: item.Status ?? "unknown" }));
    } catch {
      projects = [];
    }
    return { available: true, containers, images, networks, volumes, projects };
  }

  async function inspectLogs({ source, limit }) {
    const units = logSources[source];
    if (!units) throw new Error("Unsupported log source");
    const args = units.flatMap((unit) => ["--unit", unit]);
    args.push("--lines", String(limit), "--no-pager", "--output", "json", "--utc");
    const result = await runJournal(journalctlBinary, args, { timeout: 15000 });
    return {
      source,
      entries: parseJsonLines(result.stdout).map((entry) => ({
        timestamp: entry.__REALTIME_TIMESTAMP ? new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString() : null,
        unit: entry._SYSTEMD_UNIT ?? entry.SYSLOG_IDENTIFIER ?? "unknown",
        priority: Number.parseInt(entry.PRIORITY ?? "6", 10),
        message: sanitizeLogMessage(entry.MESSAGE),
      })).filter((entry) => entry.message).slice(-limit).reverse(),
    };
  }

  async function verifyHealth(targetContainer = containerName) {
    let lastError = "Container health status did not become healthy";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const result = await docker(["inspect", "--format", "{{.State.Health.Status}}", targetContainer], { timeout: 10000 });
        if (result.stdout === "healthy") return true;
        lastError = `Container health status is ${result.stdout || "unavailable"}`;
      } catch (error) {
        lastError = error.message;
      }
      await wait(2000);
    }
    throw new Error(lastError);
  }

  async function backup({ backupId }) {
    if (!/^[a-f0-9-]{36}$/.test(backupId)) throw new Error("Backup id must be a UUID");
    const live = await inspect();
    if (!live.installed || !live.healthy) throw new Error("Uptime Kuma must be installed and healthy before backup");

    const backupDirectory = path.join(managedRoot, "backups", "uptime-kuma");
    const archivePath = path.join(backupDirectory, `${backupId}.tar.gz`);
    const partialPath = `${archivePath}.partial`;
    const drillContainer = "boxpilot-uptime-kuma-restore-drill";
    const drillDirectory = path.join(managedRoot, "restore-drills", backupId);
    const drillData = path.join(drillDirectory, "data");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await chmod(backupDirectory, 0o700);
    await stat(archivePath).then(() => { throw new Error("Backup artifact already exists"); }).catch((error) => {
      if (error.message === "Backup artifact already exists") throw error;
      if (error.code !== "ENOENT") throw error;
    });

    const stoppedAt = clock();
    await docker(["stop", "--time", "30", containerName], { timeout: 45000 });
    let archiveError = null;
    try {
      await runArchive(tarBinary, ["--create", "--gzip", "--file", partialPath, "--directory", appDirectory, "data", "compose.yaml"], { timeout: 180000 });
      await chmod(partialPath, 0o600);
      await rename(partialPath, archivePath);
    } catch (error) {
      archiveError = error;
      await unlink(partialPath).catch(() => {});
    }

    let restartError = null;
    try {
      await docker(["start", containerName], { timeout: 30000 });
      await verifyHealth(containerName);
    } catch (error) {
      restartError = error;
    }
    const downtimeMs = clock() - stoppedAt;
    if (restartError) throw new Error("Backup stopped Uptime Kuma but its automatic restart verification failed; follow the recovery instructions immediately");
    if (archiveError) throw new Error("Backup archive creation failed; Uptime Kuma was restarted and its health check passed");

    const sha256 = await checksum(archivePath);
    const archiveStat = await stat(archivePath);
    await rm(drillDirectory, { recursive: true, force: true });
    await mkdir(drillDirectory, { recursive: true, mode: 0o700 });
    let restoreVerified = false;
    try {
      await runArchive(tarBinary, ["--extract", "--gzip", "--file", archivePath, "--directory", drillDirectory, "--no-same-owner", "--no-same-permissions"], { timeout: 180000 });
      await docker(["rm", "--force", drillContainer], { timeout: 30000 }).catch(() => {});
      await docker([
        "run", "--detach", "--name", drillContainer, "--network", "none",
        "--volume", `${drillData}:/app/data`, applicationInternals.uptimeKumaImage,
      ], { timeout: 180000 });
      await verifyHealth(drillContainer);
      restoreVerified = true;
    } finally {
      await docker(["rm", "--force", drillContainer], { timeout: 30000 }).catch(() => {});
      await rm(drillDirectory, { recursive: true, force: true });
    }
    if (!restoreVerified) throw new Error("Backup artifact was created but its isolated restore drill failed");

    return {
      backupId,
      applicationId: "uptime-kuma",
      destination: "local-managed",
      artifactPath: archivePath,
      checksumSha256: sha256,
      sizeBytes: archiveStat.size,
      downtimeMs,
      sourceRestartVerified: true,
      restoreDrill: { passed: true, network: "none", publishedPorts: 0, image: applicationInternals.uptimeKumaImage },
    };
  }

  async function backupPihole({ backupId }) {
    if (!/^[a-f0-9-]{36}$/.test(backupId)) throw new Error("Backup id must be a UUID");
    const live = await inspectPihole();
    if (!live.installed || !live.healthy) throw new Error("Pi-hole must be installed and healthy before backup");

    const archivePath = path.join(piholeBackupDirectory, `${backupId}.tar.gz`);
    const partialPath = `${archivePath}.partial`;
    const drillContainer = "boxpilot-pi-hole-restore-drill";
    const drillDirectory = path.join(piholeRestoreRoot, `pi-hole-${backupId}`);
    const drillData = path.join(drillDirectory, "etc-pihole");
    const drillSecret = path.join(drillDirectory, "drill.env");
    await mkdir(piholeBackupDirectory, { recursive: true, mode: 0o700 });
    await chmod(piholeBackupDirectory, 0o700);
    await stat(archivePath).then(() => { throw new Error("Backup artifact already exists"); }).catch((error) => {
      if (error.message === "Backup artifact already exists") throw error;
      if (error.code !== "ENOENT") throw error;
    });
    await writeFile(piholeBackupMarkerPath, `${JSON.stringify({ version: 1, backupId })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((error) => {
      if (error.code === "EEXIST") throw new Error("A previous Pi-hole backup requires helper recovery before another backup can start");
      throw error;
    });

    let sourceRestartVerified = false;
    let drillCleanupVerified = true;
    try {
      const stoppedAt = clock();
      await docker(["stop", "--time", "30", piholeContainerName], { timeout: 45000 });
      let archiveError = null;
      try {
        await runArchive(tarBinary, ["--create", "--gzip", "--file", partialPath, "--directory", piholeDirectory, "etc-pihole", "compose.yaml", "admin-password"], { timeout: 180000 });
        await chmod(partialPath, 0o600);
        await rename(partialPath, archivePath);
      } catch (error) {
        archiveError = error;
        await unlink(partialPath).catch(() => {});
      }

      let restartError = null;
      try {
        await docker(["start", piholeContainerName], { timeout: 30000 });
        await verifyHealth(piholeContainerName);
        const restarted = await inspectPihole();
        if (!restarted.healthy) throw new Error("Source binding health did not recover");
        sourceRestartVerified = true;
      } catch (error) {
        restartError = error;
      }
      const downtimeMs = clock() - stoppedAt;
      if (restartError) throw new Error("Backup stopped Pi-hole but its automatic restart verification failed; keep router and client DNS on the independent resolver and follow recovery instructions immediately");
      if (archiveError) throw new Error("Backup archive creation failed; Pi-hole was restarted and its health and bindings passed");

      const sha256 = await checksum(archivePath);
      const archiveStat = await stat(archivePath);
      await rm(drillDirectory, { recursive: true, force: true });
      await mkdir(drillDirectory, { recursive: true, mode: 0o700 });
      let restoreVerified = false;
      drillCleanupVerified = false;
      try {
        await runArchive(tarBinary, ["--extract", "--gzip", "--file", archivePath, "--directory", drillDirectory, "--no-same-owner", "--no-same-permissions"], { timeout: 180000 });
        const restoredData = await stat(drillData);
        if (!restoredData.isDirectory()) throw new Error("Restored Pi-hole configuration directory failed validation");
        const restoredCompose = await readFile(path.join(drillDirectory, "compose.yaml"), "utf8");
        if (!restoredCompose.includes("pi-hole:") || !restoredCompose.includes(applicationInternals.piholeImage)) throw new Error("Restored Pi-hole Compose definition failed validation");
        const secret = (await readFile(path.join(drillDirectory, "admin-password"), "utf8")).trim();
        if (!/^PIHOLE_PASSWORD=[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Restored Pi-hole administrator secret failed validation");
        await writeFile(drillSecret, `FTLCONF_webserver_api_password=${secret.slice("PIHOLE_PASSWORD=".length)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await docker(["rm", "--force", drillContainer], { timeout: 30000 }).catch(() => {});
        await docker([
          "run", "--detach", "--name", drillContainer, "--network", "none", "--cap-drop", "ALL",
          ...piholeCapabilities.flatMap((capability) => ["--cap-add", capability]),
          "--security-opt", "no-new-privileges:true", "--env-file", drillSecret,
          "--env", "TZ=America/Chicago", "--env", "FTLCONF_dns_listeningMode=LOCAL",
          "--volume", `${drillData}:/etc/pihole`, applicationInternals.piholeImage,
        ], { timeout: 180000 });
        await verifyHealth(drillContainer);
        restoreVerified = true;
      } finally {
        await docker(["rm", "--force", drillContainer], { timeout: 30000 }).catch((error) => {
          if (!/No such (object|container)/i.test(error.message)) throw error;
        });
        await rm(drillDirectory, { recursive: true, force: true });
        drillCleanupVerified = true;
      }
      if (!restoreVerified) throw new Error("Pi-hole backup artifact was created but its isolated restore drill failed");

      return {
        backupId,
        applicationId: "pi-hole",
        destination: "local-managed",
        artifactPath: archivePath,
        checksumSha256: sha256,
        sizeBytes: archiveStat.size,
        downtimeMs,
        sourceRestartVerified: true,
        routerMutationPerformed: false,
        dnsCutoverPerformed: false,
        restoreDrill: {
          passed: true, network: "none", publishedPorts: 0, image: applicationInternals.piholeImage,
          configurationIncluded: true, administratorSecretIncluded: true, routerMutationPerformed: false, dnsCutoverPerformed: false,
        },
      };
    } finally {
      if (sourceRestartVerified && drillCleanupVerified) await unlink(piholeBackupMarkerPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async function recoverInterruptedPiholeBackup() {
    let marker;
    try {
      marker = JSON.parse(await readFile(piholeBackupMarkerPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { recovered: false, sourceRestarted: false, drillRemoved: false };
      throw new Error("Pi-hole backup recovery marker is invalid; inspect it before restarting the helper");
    }
    if (marker?.version !== 1 || typeof marker.backupId !== "string" || !/^[a-f0-9-]{36}$/.test(marker.backupId) || Object.keys(marker).sort().join(",") !== "backupId,version") {
      throw new Error("Pi-hole backup recovery marker failed strict validation; inspect it before restarting the helper");
    }

    const drillContainer = "boxpilot-pi-hole-restore-drill";
    const drillDirectory = path.join(piholeRestoreRoot, `pi-hole-${marker.backupId}`);
    const drillData = path.join(drillDirectory, "etc-pihole");
    const source = await inspectPihole();
    if (!source.installed) throw new Error("Interrupted Pi-hole backup source is missing; keep the marker for manual recovery");
    let sourceRestarted = false;
    if (!source.healthy) {
      await docker(["start", piholeContainerName], { timeout: 30000 });
      await verifyHealth(piholeContainerName);
      const restarted = await inspectPihole();
      if (!restarted.healthy) throw new Error("Interrupted Pi-hole backup source did not recover its exact bindings");
      sourceRestarted = true;
    }

    let drillRemoved = false;
    try {
      const inspected = await docker(["inspect", "--format", "{{json .}}", drillContainer], { timeout: 10000 });
      const container = JSON.parse(inspected.stdout);
      const bindings = container.HostConfig?.PortBindings ?? {};
      const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
      const exactDrill = container.Config?.Image === applicationInternals.piholeImage
        && container.HostConfig?.NetworkMode === "none"
        && Object.keys(bindings).length === 0
        && mounts.length === 1
        && mounts[0].Source === drillData
        && mounts[0].Destination === "/etc/pihole";
      if (!exactDrill) throw new Error("Interrupted Pi-hole restore container failed strict identity checks; remove it manually after inspection");
      await docker(["rm", "--force", drillContainer], { timeout: 30000 });
      drillRemoved = true;
    } catch (error) {
      if (!/No such (object|container)/i.test(error.message)) throw error;
    }
    await rm(drillDirectory, { recursive: true, force: true });
    await unlink(piholeBackupMarkerPath);
    return { recovered: true, sourceRestarted, drillRemoved };
  }

  async function deploy({ hostPort }) {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    let previous = null;
    try {
      previous = await readFile(composePath, "utf8");
      await copyFile(composePath, previousPath);
      await chmod(previousPath, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = path.join(appDirectory, `.compose-${process.pid}.tmp`);
    await writeFile(temporaryPath, composeDefinition(hostPort), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, composePath);
    try {
      await docker(["compose", "--project-name", containerName, "--file", composePath, "up", "--detach", "--remove-orphans"], { timeout: 180000 });
      await verifyHealth();
      const live = await inspect();
      if (!live.healthy) throw new Error("Managed container state failed final verification");
      return {
        installed: true,
        healthy: live.healthy,
        state: live.state,
        hostPort,
        image: applicationInternals.uptimeKumaImage,
        dataPreserved: true,
        rollbackPerformed: false,
      };
    } catch (error) {
      let rollbackPerformed = false;
      try {
        await docker(["compose", "--project-name", containerName, "--file", composePath, "down"], { timeout: 60000 });
        if (previous !== null) {
          await copyFile(previousPath, composePath);
          await docker(["compose", "--project-name", containerName, "--file", composePath, "up", "--detach"], { timeout: 180000 });
        } else {
          await unlink(composePath).catch(() => {});
        }
        rollbackPerformed = true;
      } catch {
        rollbackPerformed = false;
      }
      const suffix = rollbackPerformed ? " Automated rollback completed and data was preserved." : " Automated rollback failed; preserve the managed data directory and follow the recorded recovery steps.";
      throw new Error(`Uptime Kuma deployment failed.${suffix}`);
    }
  }

  async function deployPihole({ lanAddress, webPort }) {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    await mkdir(piholeDataDirectory, { recursive: true, mode: 0o700 });
    await chmod(piholeDirectory, 0o700);
    await chmod(piholeDataDirectory, 0o700);
    try {
      await stat(piholeSecretPath);
      await chmod(piholeSecretPath, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const password = randomBytes(32).toString("base64url");
      await writeFile(piholeSecretPath, `PIHOLE_PASSWORD=${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }

    let previous = null;
    try {
      previous = await readFile(piholeComposePath, "utf8");
      await copyFile(piholeComposePath, piholePreviousPath);
      await chmod(piholePreviousPath, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = path.join(piholeDirectory, `.compose-${process.pid}.tmp`);
    await writeFile(temporaryPath, piholeComposeDefinition(lanAddress, webPort), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, piholeComposePath);
    const composeArgs = ["compose", "--project-name", piholeContainerName, "--env-file", piholeSecretPath, "--file", piholeComposePath];
    try {
      await docker([...composeArgs, "up", "--detach", "--remove-orphans"], { timeout: 180000 });
      await verifyHealth(piholeContainerName);
      const live = await inspectPihole();
      if (!live.healthy || live.lanAddress !== lanAddress || live.port !== webPort) throw new Error("Managed Pi-hole state failed final binding verification");
      return {
        ...live,
        image: applicationInternals.piholeImage,
        dataPreserved: true,
        secretPreserved: true,
        rollbackPerformed: false,
        routerMutationPerformed: false,
        dnsCutoverPerformed: false,
        dhcpEnabled: false,
      };
    } catch (error) {
      let rollbackPerformed = false;
      try {
        await docker([...composeArgs, "down"], { timeout: 60000 });
        if (previous !== null) {
          await copyFile(piholePreviousPath, piholeComposePath);
          await docker([...composeArgs, "up", "--detach"], { timeout: 180000 });
        } else {
          await unlink(piholeComposePath).catch(() => {});
        }
        rollbackPerformed = true;
      } catch {
        rollbackPerformed = false;
      }
      const suffix = rollbackPerformed ? " Automated rollback completed; configuration and the administrator secret were preserved." : " Automated rollback failed; preserve the managed Pi-hole directory and keep router and client DNS unchanged.";
      throw new Error(`Pi-hole staging failed.${suffix}`);
    }
  }

  return { appDirectory, composePath, dataDirectory, piholeDirectory, piholeComposePath, piholeDataDirectory, piholeSecretPath, piholeBackupMarkerPath, inspectDocker, inventoryDocker, inspectLogs, inspect, inspectUptimeKumaLifecycle, actionUptimeKuma, inspectPihole, inspectPiholeLifecycle, actionPihole, deploy, deployPihole, backup, backupPihole, recoverInterruptedPiholeBackup };
}

export const applicationHelperInternals = { composeDefinition, piholeComposeDefinition, containerName, piholeContainerName, piholeCapabilities, parseJsonLines, sanitizeLogMessage, logSources };
