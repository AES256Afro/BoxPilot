import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import net from "node:net";
import { dnsAcceptanceInternals } from "./dns-acceptance.mjs";
import { verifyPassword } from "./security.mjs";

const agentNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,47}$/;
const allowedCapabilities = Object.freeze(["dns-probe-v1"]);
const agentRequestWindowMs = 5 * 60 * 1000;
const controllerEvidenceMaxAgeMs = 30 * 60 * 1000;

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function signedAgentMessage({ agentId, sequence, timestamp, method, path, body = null }) {
  return ["boxpilot-agent-request-v1", agentId, String(sequence), timestamp, method.toUpperCase(), path, canonicalJson(body)].join("\n");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || value.length < 16 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(`${label} is invalid`);
  return decoded;
}

function validatePublicKey(encoded) {
  const bytes = decodeBase64(encoded, "Agent public key");
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    throw new Error("Agent public key is not valid SPKI DER");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Agent public key must use Ed25519");
  return { key, fingerprint: createHash("sha256").update(bytes).digest("hex") };
}

function normalizeHeaders(headers = {}) {
  const sequence = Number(headers.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Agent sequence must be a positive safe integer");
  if (typeof headers.agentId !== "string" || !/^[0-9a-f-]{36}$/.test(headers.agentId)) throw new Error("Agent id is invalid");
  if (typeof headers.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(headers.timestamp)) throw new Error("Agent timestamp is invalid");
  return { agentId: headers.agentId, sequence, timestamp: headers.timestamp, signature: headers.signature };
}

function validateChecks(checks) {
  if (!Array.isArray(checks) || checks.length !== dnsAcceptanceInternals.acceptanceChecks.length) throw new Error("Agent evidence must contain the four fixed DNS checks");
  return checks.map((check, index) => {
    const expected = dnsAcceptanceInternals.acceptanceChecks[index];
    const allowed = ["answers", "error", "expectedRcode", "id", "latencyMs", "name", "passed", "protocol", "rcode", "recursionAvailable", "truncated", "type"];
    if (!check || typeof check !== "object" || Array.isArray(check) || Object.keys(check).some((key) => !allowed.includes(key))) throw new Error("Agent DNS evidence contains unsupported fields");
    if (check.id !== expected.id || check.protocol !== expected.protocol || check.name !== expected.name || check.type !== "A" || check.expectedRcode !== expected.expectedRcode) throw new Error("Agent DNS evidence does not match the fixed task");
    if (typeof check.passed !== "boolean" || typeof check.latencyMs !== "number" || !Number.isFinite(check.latencyMs) || check.latencyMs < 0 || check.latencyMs > 30000) throw new Error("Agent DNS evidence has invalid timing or status");
    if (check.rcode !== null && (!Number.isInteger(check.rcode) || check.rcode < 0 || check.rcode > 15)) throw new Error("Agent DNS evidence has an invalid response code");
    if (check.answers !== null && (!Number.isInteger(check.answers) || check.answers < 0 || check.answers > 65535)) throw new Error("Agent DNS evidence has an invalid answer count");
    if (typeof check.recursionAvailable !== "boolean" || typeof check.truncated !== "boolean") throw new Error("Agent DNS evidence has invalid DNS flags");
    if (check.error !== undefined && (typeof check.error !== "string" || check.error.length < 1 || check.error.length > 160 || /[\r\n\0]/.test(check.error))) throw new Error("Agent DNS evidence has an invalid error summary");
    if (check.passed && (check.error !== undefined || check.rcode !== expected.expectedRcode || check.truncated || (expected.requireAnswers && !(check.answers > 0)))) throw new Error("Agent DNS evidence claims a passing check without matching response proof");
    return check;
  });
}

export function createFleetService({ store, now = () => new Date() }) {
  async function requireOwnerPassword(ownerId, password) {
    const owner = store.findOwnerById(ownerId);
    if (!owner || !(await verifyPassword(password, owner.passwordHash))) throw new Error("Owner reauthentication failed");
    return owner;
  }

  async function createEnrollment(ownerId, body) {
    if (!exactKeys(body, ["password"])) throw new Error("Enrollment creation accepts only the owner password");
    await requireOwnerPassword(ownerId, body.password);
    return store.createAgentEnrollmentToken(ownerId);
  }

  function enroll(body) {
    if (!exactKeys(body, ["capabilities", "name", "publicKey", "token"])) throw new Error("Agent enrollment request has unsupported fields");
    if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 128) throw new Error("Enrollment token is invalid");
    if (typeof body.name !== "string" || !agentNamePattern.test(body.name)) throw new Error("Agent name must be 3 to 48 letters, numbers, dots, dashes, or underscores");
    if (!Array.isArray(body.capabilities) || body.capabilities.length !== 1 || body.capabilities[0] !== allowedCapabilities[0]) throw new Error("Agent may request only the dns-probe-v1 capability");
    const validatedKey = validatePublicKey(body.publicKey);
    return store.consumeAgentEnrollmentToken({
      token: body.token,
      name: body.name,
      publicKey: body.publicKey,
      fingerprint: validatedKey.fingerprint,
      capabilities: [...body.capabilities],
    });
  }

  function authenticate({ headers, method, path, body = null, advanceSequence = true }) {
    const normalized = normalizeHeaders(headers);
    const observedAt = new Date(normalized.timestamp);
    if (!Number.isFinite(observedAt.getTime()) || Math.abs(now().getTime() - observedAt.getTime()) > agentRequestWindowMs) throw new Error("Agent request timestamp is outside the five-minute window");
    const agent = store.getFleetAgent(normalized.agentId, { includePublicKey: true });
    if (!agent || agent.status !== "active") throw new Error("Active agent not found");
    const signature = decodeBase64(normalized.signature, "Agent signature");
    const key = validatePublicKey(agent.publicKey).key;
    const message = Buffer.from(signedAgentMessage({ ...normalized, method, path, body }), "utf8");
    if (!verifySignature(null, message, key, signature)) throw new Error("Agent signature verification failed");
    if (advanceSequence) store.advanceFleetAgentSequence(agent.id, normalized.sequence);
    return { agent, sequence: normalized.sequence, signature: normalized.signature };
  }

  function inspect() {
    return {
      agents: store.listFleetAgents(),
      tasks: store.listFleetTasks(),
      evidence: store.listFleetEvidence(),
      enrollment: { tokenTtlMinutes: 10, keyType: "Ed25519", tokenStoredAsDigest: true },
      executionBoundary: {
        controllerShellAccess: false,
        arbitraryCommands: false,
        arbitraryTargets: false,
        supportedTasks: ["dns.pi-hole.acceptance.v1"],
        nodeLocalExecution: true,
        routerMutationSupported: false,
        dnsCutoverSupported: false,
      },
    };
  }

  async function revoke(ownerId, agentId, body) {
    if (!exactKeys(body, ["password"])) throw new Error("Agent revocation accepts only the owner password");
    await requireOwnerPassword(ownerId, body.password);
    return store.revokeFleetAgent(agentId, ownerId);
  }

  function createDnsProbeTask(ownerId, body) {
    if (!exactKeys(body, ["agentId"]) || typeof body.agentId !== "string") throw new Error("DNS probe task creation accepts only one agent id");
    const agent = store.getFleetAgent(body.agentId);
    if (!agent || agent.status !== "active" || !agent.capabilities.includes("dns-probe-v1")) throw new Error("An active DNS probe agent is required");
    if (store.listFleetTasks(200).some((task) => task.agentId === agent.id && task.type === "dns.pi-hole.acceptance.v1" && task.state === "pending")) throw new Error("This agent already has a pending DNS probe");
    const acceptance = store.listDnsAcceptances(200).find((item) => item.passed && item.origin === "boxpilot-controller" && item.secondDeviceTested === false);
    if (!acceptance) throw new Error("A passing direct Bigbox Pi-hole acceptance is required first");
    if (now().getTime() - new Date(acceptance.createdAt).getTime() > controllerEvidenceMaxAgeMs) throw new Error("The direct Bigbox Pi-hole acceptance is older than 30 minutes; run it again");
    if (net.isIP(acceptance.resolverAddress) !== 4) throw new Error("The linked Pi-hole resolver is not an exact IPv4 address");
    return store.createFleetTask({
      agentId: agent.id,
      type: "dns.pi-hole.acceptance.v1",
      controllerAcceptanceId: acceptance.id,
      createdBy: ownerId,
      ttlMs: 10 * 60 * 1000,
      payload: {
        schemaVersion: 1,
        resolverAddress: acceptance.resolverAddress,
        checks: dnsAcceptanceInternals.acceptanceChecks.map((check) => ({ id: check.id, protocol: check.protocol, name: check.name, type: "A", expectedRcode: check.expectedRcode, port: 53 })),
        boundary: { arbitraryCommand: false, arbitraryTarget: false, routerMutation: false, dnsCutover: false },
      },
    });
  }

  function nextTask(agentRequest) {
    const authenticated = authenticate({ ...agentRequest, method: "GET", path: "/api/v1/agent/tasks/next", body: null });
    return store.getPendingFleetTask(authenticated.agent.id);
  }

  function submitEvidence(agentRequest, body) {
    const authenticated = authenticate({ ...agentRequest, method: "POST", path: "/api/v1/agent/evidence", body, advanceSequence: false });
    if (!exactKeys(body, ["checks", "observedAt", "passed", "taskId"])) throw new Error("Agent evidence request has unsupported fields");
    if (typeof body.taskId !== "string" || typeof body.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.observedAt) || typeof body.passed !== "boolean") throw new Error("Agent evidence request is invalid");
    const task = store.getFleetTask(body.taskId);
    if (!task || task.agentId !== authenticated.agent.id || task.type !== "dns.pi-hole.acceptance.v1") throw new Error("Agent task is unavailable");
    const observedAt = new Date(body.observedAt);
    if (!Number.isFinite(observedAt.getTime()) || observedAt < new Date(task.createdAt) || observedAt > new Date(task.expiresAt)) throw new Error("Agent evidence observation is outside the task window");
    const checks = validateChecks(body.checks);
    const passed = checks.every((check) => check.passed === true);
    if (body.passed !== passed) throw new Error("Agent evidence summary does not match the fixed checks");
    return store.recordFleetEvidence({
      id: randomUUID(),
      taskId: task.id,
      agentId: authenticated.agent.id,
      sequence: authenticated.sequence,
      result: {
        schemaVersion: 1,
        type: task.type,
        resolverAddress: task.payload.resolverAddress,
        controllerAcceptanceId: task.controllerAcceptanceId,
        observedAt: body.observedAt,
        checks,
        secondDeviceTested: true,
        routerMutationPerformed: false,
        dnsCutoverPerformed: false,
        clientSettingsChanged: false,
      },
      passed,
      signature: authenticated.signature,
    });
  }

  return { createEnrollment, enroll, authenticate, inspect, revoke, createDnsProbeTask, nextTask, submitEvidence };
}

export const fleetInternals = { agentNamePattern, allowedCapabilities, exactKeys, validateChecks, validatePublicKey };
