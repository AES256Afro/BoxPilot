import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationHelperInternals, createApplicationHelper } from "./application-helper.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("curated Uptime Kuma helper", () => {
  it("reports Docker readiness through one fixed server-version query", async () => {
    const runDocker = vi.fn(async () => ({ stdout: "29.1.3", stderr: "" }));
    const helper = createApplicationHelper({ runDocker, dockerBinary: "/fixed/docker" });

    await expect(helper.inspectDocker()).resolves.toEqual({ available: true, version: "29.1.3" });
    expect(runDocker).toHaveBeenCalledWith("/fixed/docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
  });

  it("generates a loopback-only digest-pinned Compose definition", () => {
    const compose = applicationHelperInternals.composeDefinition(3101);
    expect(compose).toContain("louislam/uptime-kuma@sha256:");
    expect(compose).toContain('"127.0.0.1:3101:3001"');
    expect(compose).toContain("./data:/app/data");
    expect(compose).not.toContain("privileged:");
    expect(compose).not.toContain("docker.sock");
  });

  it("deploys only the fixed adapter and verifies health inside the container", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-app-helper-"));
    directories.push(directory);
    const calls = [];
    const runDocker = vi.fn(async (_binary, args) => {
      calls.push(args);
      if (args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") return { stdout: "healthy", stderr: "" };
      if (args[0] === "inspect") return { stdout: JSON.stringify({ Running: true, Status: "running", Error: "", Health: { Status: "healthy" } }), stderr: "" };
      if (args[0] === "port") return { stdout: "127.0.0.1:3101", stderr: "" };
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot: directory, dockerBinary: "/fixed/docker", runDocker, wait: vi.fn() });
    const result = await helper.deploy({ hostPort: 3101 });

    expect(result).toMatchObject({ installed: true, healthy: true, hostPort: 3101, dataPreserved: true });
    expect(await readFile(helper.composePath, "utf8")).toContain("127.0.0.1:3101:3001");
    expect(calls).toContainEqual(["inspect", "--format", "{{.State.Health.Status}}", "boxpilot-uptime-kuma"]);
    expect(calls.some((args) => args[0] === "compose" && args.includes("up"))).toBe(true);
  });

  it("removes a new Compose definition on failed first deployment without deleting data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-app-helper-"));
    directories.push(directory);
    const runDocker = vi.fn(async (_binary, args) => {
      if (args[0] === "compose" && args.includes("up")) throw new Error("pull failed");
      return { stdout: "ok", stderr: "" };
    });
    const helper = createApplicationHelper({ appRoot: directory, runDocker, wait: vi.fn() });

    await expect(helper.deploy({ hostPort: 3001 })).rejects.toThrow("Automated rollback completed");
    await expect(readFile(helper.composePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
