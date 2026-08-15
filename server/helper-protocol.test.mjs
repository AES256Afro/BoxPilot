import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeHelperOperation, validateHelperRequest } from "./helper-protocol.mjs";

function request(overrides = {}) {
  return { version: 1, id: randomUUID(), operation: "canary.verify", parameters: {}, ...overrides };
}

function vmParameters(overrides = {}) {
  return { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false, ...overrides };
}

function lifecycleParameters(overrides = {}) {
  return { name: "ubuntu-lab", action: "shutdown", expectedState: "running", expectedAutostart: false, ...overrides };
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

  it("accepts only typed VM fields and delegates no command or path", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters({ arguments: ["--name", "evil"] }) }))).toContain("only the fixed typed plan fields");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters({ path: "/tmp/evil.iso" }) }))).toContain("only the fixed typed plan fields");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters({ program: "/bin/sh" }) }))).toContain("only the fixed typed plan fields");
    const virtualization = { create: async (parameters) => ({ created: true, verified: true, domain: parameters.name }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.domain.create", parameters: vmParameters() }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { created: true, verified: true, domain: "ubuntu-lab" } });
  });

  it("accepts only fixed lifecycle state and action fields", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters({ action: "destroy" }) }))).toContain("Unsupported VM lifecycle action");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters({ arguments: ["destroy"] }) }))).toContain("only the fixed typed plan fields");
    const virtualization = { action: async (parameters) => ({ verified: true, domain: parameters.name, action: parameters.action }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters() }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { verified: true, domain: "ubuntu-lab", action: "shutdown" } });
  });
});
