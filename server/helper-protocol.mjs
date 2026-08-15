import { createApplicationHelper } from "./application-helper.mjs";
import { createVmHelper } from "./vm-helper.mjs";
import { validateVmPlanInput } from "./vm-plan.mjs";
import { validateVmLifecycleInput } from "./vm-lifecycle.mjs";

export const helperProtocolVersion = 1;
export const helperOperations = new Set(["canary.verify", "container.docker.inspect", "container.docker.inventory", "system.logs.inspect", "application.uptime-kuma.inspect", "application.uptime-kuma.deploy", "application.uptime-kuma.backup", "virtualization.domain.create", "virtualization.domain.action"]);
const vmCreationKeys = ["autostart", "diskGiB", "firmware", "isoFile", "memoryMiB", "name", "network", "osProfile", "vcpus"];
const vmLifecycleKeys = ["action", "expectedAutostart", "expectedState", "name"];

export function validateHelperRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Request must be an object";
  if (value.version !== helperProtocolVersion) return "Unsupported helper protocol version";
  if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)) return "Request id must be a UUID";
  if (!helperOperations.has(value.operation)) return "Operation is not allowlisted";
  if (!value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters)) return "Parameters must be an object";
  if (value.operation === "canary.verify" && Object.keys(value.parameters).length !== 0) return "Canary operation accepts no parameters";
  if (value.operation === "container.docker.inspect" && Object.keys(value.parameters).length !== 0) return "Docker inspection accepts no parameters";
  if (value.operation === "container.docker.inventory" && Object.keys(value.parameters).length !== 0) return "Docker inventory accepts no parameters";
  if (value.operation === "system.logs.inspect") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 2 || !["boxpilot", "docker", "tailscale", "virtualization"].includes(value.parameters.source) || !Number.isInteger(value.parameters.limit) || value.parameters.limit < 1 || value.parameters.limit > 200) {
      return "Log inspection accepts only a fixed source and a limit from 1 to 200";
    }
  }
  if (value.operation === "application.uptime-kuma.inspect" && Object.keys(value.parameters).length !== 0) return "Inspect operation accepts no parameters";
  if (value.operation === "application.uptime-kuma.deploy") {
    if (Object.keys(value.parameters).length !== 1 || !Number.isInteger(value.parameters.hostPort) || value.parameters.hostPort < 1024 || value.parameters.hostPort > 65535) {
      return "Uptime Kuma deployment accepts only a hostPort between 1024 and 65535";
    }
  }
  if (value.operation === "application.uptime-kuma.backup") {
    if (Object.keys(value.parameters).length !== 1 || typeof value.parameters.backupId !== "string" || !/^[a-f0-9-]{36}$/.test(value.parameters.backupId)) {
      return "Uptime Kuma backup accepts only a backupId UUID";
    }
  }
  if (value.operation === "virtualization.domain.create") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmCreationKeys.length || keys.some((key, index) => key !== vmCreationKeys[index])) {
      return "VM creation accepts only the fixed typed plan fields";
    }
    const errors = validateVmPlanInput(value.parameters);
    if (errors.length) return `Invalid VM creation plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.domain.action") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmLifecycleKeys.length || keys.some((key, index) => key !== vmLifecycleKeys[index])) return "VM lifecycle accepts only the fixed typed plan fields";
    const errors = validateVmLifecycleInput(value.parameters);
    if (errors.length) return `Invalid VM lifecycle plan: ${errors.join(" | ")}`;
  }
  return null;
}

export async function executeHelperOperation(request, { applications = createApplicationHelper(), virtualization = createVmHelper() } = {}) {
  const error = validateHelperRequest(request);
  if (error) return { version: helperProtocolVersion, id: request?.id ?? null, ok: false, error, code: "invalid_request" };
  if (request.operation === "canary.verify") {
    return {
      version: helperProtocolVersion,
      id: request.id,
      ok: true,
      result: { verified: true, helperVersion: "0.6.0", mutationPerformed: false },
    };
  }
  if (request.operation === "container.docker.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspectDocker() };
  }
  if (request.operation === "container.docker.inventory") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inventoryDocker() };
  }
  if (request.operation === "system.logs.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspectLogs(request.parameters) };
  }
  if (request.operation === "application.uptime-kuma.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspect() };
  }
  if (request.operation === "application.uptime-kuma.deploy") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.deploy(request.parameters) };
  }
  if (request.operation === "application.uptime-kuma.backup") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.backup(request.parameters) };
  }
  if (request.operation === "virtualization.domain.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.create(request.parameters) };
  }
  if (request.operation === "virtualization.domain.action") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.action(request.parameters) };
  }
  return { version: helperProtocolVersion, id: request.id, ok: false, error: "Operation is not implemented", code: "not_implemented" };
}
