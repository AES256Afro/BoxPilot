import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
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

  return { appDirectory, composePath, piholeDirectory, piholeComposePath, piholeSecretPath, inspectDocker, inventoryDocker, inspectLogs, inspect, inspectPihole, deploy, deployPihole, backup };
}

export const applicationHelperInternals = { composeDefinition, piholeComposeDefinition, containerName, piholeContainerName, piholeCapabilities, parseJsonLines, sanitizeLogMessage, logSources };
