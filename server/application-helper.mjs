import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { applicationInternals } from "./applications.mjs";

const execFile = promisify(execFileCallback);
const containerName = "boxpilot-uptime-kuma";

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

async function defaultDockerRunner(binary, args, { timeout = 120000 } = {}) {
  const result = await execFile(binary, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createApplicationHelper({
  appRoot = process.env.BOXPILOT_APP_ROOT ?? "/var/lib/boxpilot-managed/apps",
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  runDocker = defaultDockerRunner,
  wait = delay,
} = {}) {
  const resolvedRoot = path.resolve(appRoot);
  const appDirectory = path.join(resolvedRoot, "uptime-kuma");
  const dataDirectory = path.join(appDirectory, "data");
  const composePath = path.join(appDirectory, "compose.yaml");
  const previousPath = path.join(appDirectory, "compose.yaml.previous");

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

  async function verifyHealth() {
    let lastError = "Container health status did not become healthy";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const result = await docker(["inspect", "--format", "{{.State.Health.Status}}", containerName], { timeout: 10000 });
        if (result.stdout === "healthy") return true;
        lastError = `Container health status is ${result.stdout || "unavailable"}`;
      } catch (error) {
        lastError = error.message;
      }
      await wait(2000);
    }
    throw new Error(lastError);
  }

  async function deploy({ hostPort }) {
    await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    await mkdir(dataDirectory, { recursive: true, mode: 0o750 });
    let previous = null;
    try {
      previous = await readFile(composePath, "utf8");
      await copyFile(composePath, previousPath);
      await chmod(previousPath, 0o640);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = path.join(appDirectory, `.compose-${process.pid}.tmp`);
    await writeFile(temporaryPath, composeDefinition(hostPort), { encoding: "utf8", mode: 0o640, flag: "wx" });
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

  return { appDirectory, composePath, inspect, deploy };
}

export const applicationHelperInternals = { composeDefinition, containerName };
