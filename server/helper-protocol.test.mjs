import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeHelperOperation, validateHelperRequest } from "./helper-protocol.mjs";

function request(overrides = {}) {
  return { version: 1, id: randomUUID(), operation: "canary.verify", parameters: {}, ...overrides };
}

describe("restricted helper protocol", () => {
  it("executes the no-mutation canary", async () => {
    const result = await executeHelperOperation(request());
    expect(result).toMatchObject({ ok: true, result: { verified: true, mutationPerformed: false } });
  });

  it("rejects arbitrary operation names and parameters", () => {
    expect(validateHelperRequest(request({ operation: "shell.exec" }))).toBe("Operation is not allowlisted");
    expect(validateHelperRequest(request({ parameters: { command: "id" } }))).toBe("Canary operation accepts no parameters");
  });

  it("accepts only the typed Uptime Kuma port parameter", () => {
    expect(validateHelperRequest(request({ operation: "container.docker.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "container.docker.inspect", parameters: { socket: "/var/run/docker.sock" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.deploy", parameters: { hostPort: 3001 } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.deploy", parameters: { hostPort: 53 } }))).toContain("hostPort");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.deploy", parameters: { hostPort: 3001, image: "evil" } }))).toContain("only a hostPort");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.backup", parameters: { backupId: randomUUID() } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.backup", parameters: { backupId: "../../etc" } }))).toContain("backupId UUID");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.backup", parameters: { backupId: randomUUID(), destination: "/tmp" } }))).toContain("only a backupId");
    expect(validateHelperRequest(request({ operation: "container.docker.inventory", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "container.docker.inventory", parameters: { labels: true } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "system.logs.inspect", parameters: { source: "boxpilot", limit: 50 } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "system.logs.inspect", parameters: { source: "../../etc", limit: 50 } }))).toContain("fixed source");
    expect(validateHelperRequest(request({ operation: "system.logs.inspect", parameters: { source: "docker", limit: 500 } }))).toContain("1 to 200");
  });

  it("returns only the Docker server availability and version", async () => {
    const result = await executeHelperOperation(request({ operation: "container.docker.inspect", parameters: {} }), {
      applications: { inspectDocker: async () => ({ available: true, version: "29.1.3" }) },
    });
    expect(result).toMatchObject({ ok: true, result: { available: true, version: "29.1.3" } });
  });

  it("delegates a typed backup id without accepting a path", async () => {
    const backupId = randomUUID();
    const applications = { backup: async (parameters) => ({ ...parameters, restoreDrill: { passed: true } }) };
    const result = await executeHelperOperation(request({ operation: "application.uptime-kuma.backup", parameters: { backupId } }), { applications });
    expect(result).toMatchObject({ ok: true, result: { backupId, restoreDrill: { passed: true } } });
  });

  it("rejects incompatible versions and malformed ids", () => {
    expect(validateHelperRequest(request({ version: 99 }))).toBe("Unsupported helper protocol version");
    expect(validateHelperRequest(request({ id: "not-a-uuid" }))).toBe("Request id must be a UUID");
  });
});
