#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { dnsAcceptanceInternals } from "../server/dns-acceptance.mjs";
import { signedAgentMessage } from "../server/fleet.mjs";

const defaultConfigPath = path.join(os.homedir(), ".config", "boxpilot-agent", "agent.json");
const execFile = promisify(execFileCallback);

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Options must use --name value pairs");
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function controllerOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Controller must be a valid URL");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Controller must use HTTPS, except loopback development URLs");
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) throw new Error("Controller URL must be an origin without credentials, path, query, or fragment");
  return url.origin;
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Controller returned HTTP ${response.status}`);
  return body;
}

async function saveConfig(configPath, config) {
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.agent-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, configPath);
  await chmod(configPath, 0o600);
}

async function loadConfig(configPath) {
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error("Agent configuration must be a regular non-symlink file without group or other permissions");
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  if (parsed.schemaVersion !== 1 || typeof parsed.controller !== "string" || typeof parsed.agentId !== "string" || typeof parsed.privateKey !== "string" || !Number.isSafeInteger(parsed.sequence)) throw new Error("Agent configuration is invalid");
  return parsed;
}

function signedHeaders(config, sequence, timestamp, method, requestPath, body) {
  const key = createPrivateKey({ key: Buffer.from(config.privateKey, "base64url"), format: "der", type: "pkcs8" });
  const message = Buffer.from(signedAgentMessage({ agentId: config.agentId, sequence, timestamp, method, path: requestPath, body }), "utf8");
  return {
    "X-BoxPilot-Agent-Id": config.agentId,
    "X-BoxPilot-Agent-Sequence": String(sequence),
    "X-BoxPilot-Agent-Timestamp": timestamp,
    "X-BoxPilot-Agent-Signature": sign(null, message, key).toString("base64url"),
  };
}

function sanitizeError(error) {
  return (error instanceof Error ? error.message : "DNS query failed").replace(/[\r\n\0]+/g, " ").slice(0, 160) || "DNS query failed";
}

async function runFirstFixedCommand(commands, args, exec = execFile) {
  let lastError;
  for (const command of commands) {
    try {
      return await exec(command, args, { timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw lastError ?? new Error("Default-gateway command is unavailable");
}

async function detectDefaultIpv4Gateway({ platform = os.platform(), exec = execFile } = {}) {
  let gateways = [];
  if (platform === "linux") {
    const { stdout } = await runFirstFixedCommand(["/usr/sbin/ip", "/usr/bin/ip", "/sbin/ip", "/bin/ip"], ["-j", "-4", "route", "show", "default"], exec);
    const routes = JSON.parse(stdout);
    if (!Array.isArray(routes)) throw new Error("Linux default-route evidence is invalid");
    gateways = routes.filter((route) => route?.dst === "default" && net.isIP(route?.gateway) === 4).map((route) => route.gateway);
  } else if (platform === "darwin") {
    const { stdout } = await runFirstFixedCommand(["/sbin/route"], ["-n", "get", "default"], exec);
    gateways = [...stdout.matchAll(/^\s*gateway:\s*(\S+)\s*$/gm)].map((match) => match[1]).filter((gateway) => net.isIP(gateway) === 4);
  } else {
    throw new Error("Flint 2 gateway proof supports only Linux and macOS agents");
  }
  if (gateways.length !== 1) throw new Error("Agent requires one unambiguous local IPv4 default gateway");
  return gateways[0];
}

async function runFixedDnsChecks(task, { queryDns = dnsAcceptanceInternals.queryDns, resolveDefaultGateway = detectDefaultIpv4Gateway } = {}) {
  const expectedChecks = task.type === "dns.pi-hole.acceptance.v1"
    ? dnsAcceptanceInternals.acceptanceChecks
    : task.type === "dns.flint2-adguard.acceptance.v1"
      ? dnsAcceptanceInternals.flint2AdguardChecks
      : null;
  if (!expectedChecks || task.payload?.schemaVersion !== 1 || task.payload?.checks?.length !== expectedChecks.length) throw new Error("Controller task is not supported by this agent");
  if (task.payload.boundary?.arbitraryCommand !== false || task.payload.boundary?.arbitraryTarget !== false || task.payload.boundary?.routerMutation !== false || task.payload.boundary?.dnsCutover !== false) throw new Error("Controller task is missing the no-command and no-cutover boundary");
  if (task.type === "dns.flint2-adguard.acceptance.v1" && (task.payload.boundary?.targetMustEqualNodeDefaultGateway !== true || task.payload.boundary?.dhcpMutation !== false || task.payload.boundary?.clientSettingsMutation !== false || task.payload.boundary?.modelAttestation !== false || typeof task.payload.checkpointId !== "string")) throw new Error("Controller Flint 2 task is missing its local-gateway, no-write, and no-attestation boundary");
  if (task.type === "dns.flint2-adguard.acceptance.v1" && await resolveDefaultGateway() !== task.payload.resolverAddress) throw new Error("Controller Flint 2 target does not match this agent's local default gateway");
  const results = [];
  for (let index = 0; index < expectedChecks.length; index += 1) {
    const expected = expectedChecks[index];
    const supplied = task.payload.checks[index];
    if (supplied.id !== expected.id || supplied.protocol !== expected.protocol || supplied.name !== expected.name || supplied.type !== "A" || supplied.port !== 53 || supplied.expectedRcode !== expected.expectedRcode) throw new Error("Controller task changed the fixed DNS check contract");
    const startedAt = Date.now();
    try {
      results.push(await queryDns(task.payload.resolverAddress, expected));
    } catch (error) {
      results.push({
        id: expected.id,
        protocol: expected.protocol,
        name: expected.name,
        type: "A",
        expectedRcode: expected.expectedRcode,
        rcode: null,
        answers: null,
        recursionAvailable: false,
        truncated: false,
        latencyMs: Math.min(30000, Math.max(0, Date.now() - startedAt)),
        passed: false,
        error: sanitizeError(error),
      });
    }
  }
  return results;
}

async function enroll(values) {
  const configPath = path.resolve(values.config ?? defaultConfigPath);
  const controller = controllerOrigin(values.controller);
  if (!values.token || !values.name) throw new Error("Enroll requires --controller, --token, and --name");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
  const result = await readJson(await fetch(`${controller}/api/v1/agent/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: values.token, name: values.name, publicKey: publicKey.toString("base64url"), capabilities: ["dns-probe-v1"] }),
  }));
  await saveConfig(configPath, {
    schemaVersion: 1,
    controller,
    agentId: result.agent.id,
    name: result.agent.name,
    fingerprint: result.agent.fingerprint,
    capabilities: result.agent.capabilities,
    privateKey: privateKey.toString("base64url"),
    sequence: 0,
    enrolledAt: result.agent.enrolledAt,
  });
  process.stdout.write(`Enrolled ${result.agent.name} as ${result.agent.id}. Private key saved with mode 0600 at ${configPath}.\n`);
}

async function runOnce(values) {
  const configPath = path.resolve(values.config ?? defaultConfigPath);
  const config = await loadConfig(configPath);
  const taskPath = "/api/v1/agent/tasks/next";
  const taskSequence = config.sequence + 1;
  const taskTimestamp = new Date().toISOString();
  config.sequence = taskSequence;
  await saveConfig(configPath, config);
  const taskResponse = await fetch(`${config.controller}${taskPath}`, { headers: signedHeaders(config, taskSequence, taskTimestamp, "GET", taskPath, null) });
  if (taskResponse.status !== 204 && !taskResponse.ok) await readJson(taskResponse);
  if (taskResponse.status === 204) {
    process.stdout.write("No pending allowlisted task.\n");
    return;
  }
  const { task } = await readJson(taskResponse);
  const checks = await runFixedDnsChecks(task);
  const evidenceBody = { taskId: task.id, observedAt: new Date().toISOString(), checks, passed: checks.every((check) => check.passed) };
  const evidencePath = "/api/v1/agent/evidence";
  const evidenceSequence = config.sequence + 1;
  const evidenceTimestamp = new Date().toISOString();
  config.sequence = evidenceSequence;
  await saveConfig(configPath, config);
  const evidence = await readJson(await fetch(`${config.controller}${evidencePath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedHeaders(config, evidenceSequence, evidenceTimestamp, "POST", evidencePath, evidenceBody) },
    body: JSON.stringify(evidenceBody),
  }));
  process.stdout.write(`Submitted signed evidence ${evidence.evidence.id}: ${evidence.evidence.passed ? "passed" : "failed"}. No router or client setting was changed.\n`);
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "enroll") await enroll(values);
  else if (command === "run-once") await runOnce(values);
  else throw new Error("Usage: boxpilot-agent.mjs enroll --controller https://host --token TOKEN --name DEVICE [--config PATH] | run-once [--config PATH]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`BoxPilot agent: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const agentInternals = { controllerOrigin, detectDefaultIpv4Gateway, loadConfig, parseArguments, runFixedDnsChecks, runFirstFixedCommand, sanitizeError, signedHeaders };
