import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const upscBinary = "/usr/bin/upsc";
const fixedStatusTokens = new Set(["ALARM", "BOOST", "BYPASS", "CAL", "CHRG", "DISCHRG", "FSD", "LB", "OB", "OFF", "OL", "OVER", "RB", "TEST", "TRIM"]);
const upsNamePattern = /^[A-Za-z0-9_.-]{1,64}$/;

async function fixedRun(binary, args, { timeout = 5000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim(), code: null };
  } catch (error) {
    return { ok: false, stdout: "", code: error.code ?? null };
  }
}

function boundedNumber(value, maximum) {
  const candidate = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function parseVariables(output) {
  const values = new Map();
  for (const line of String(output ?? "").split("\n").slice(0, 512)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (["battery.charge", "battery.runtime", "ups.load", "ups.status"].includes(key)) values.set(key, line.slice(separator + 1).trim());
  }
  const statusTokens = String(values.get("ups.status") ?? "").split(/\s+/).filter((item) => fixedStatusTokens.has(item));
  const state = statusTokens.includes("FSD") ? "forced-shutdown"
    : statusTokens.includes("LB") ? "low-battery"
      : statusTokens.includes("OB") ? "on-battery"
        : statusTokens.includes("BYPASS") ? "bypass"
          : statusTokens.includes("OFF") ? "offline"
            : statusTokens.includes("OL") ? "online"
              : "unavailable";
  return {
    available: state !== "unavailable",
    state,
    statusTokens: [...new Set(statusTokens)].sort(),
    batteryChargePercent: boundedNumber(values.get("battery.charge"), 100),
    estimatedRuntimeSeconds: boundedNumber(values.get("battery.runtime"), 31 * 24 * 60 * 60),
    loadPercent: boundedNumber(values.get("ups.load"), 200),
  };
}

function baseEvidence(overrides = {}) {
  return {
    installed: false,
    configured: false,
    available: false,
    state: "unavailable",
    reason: "nut-client-not-installed",
    deviceCount: 0,
    statusTokens: [],
    batteryChargePercent: null,
    estimatedRuntimeSeconds: null,
    loadPercent: null,
    source: "nut-localhost-fixed",
    boundary: { mutationPerformed: false, powerCommandAvailable: false, shutdownPolicyChanged: false, localhostOnly: true, remoteNetworkProbePerformed: false, browserTargetAccepted: false, rawOutputIncluded: false, deviceNameIncluded: false, serialIncluded: false },
    ...overrides,
  };
}

export function unavailableUpsEvidence(reason = "ups-collector-unavailable") {
  return baseEvidence({ reason });
}

export function createUpsService({ run = fixedRun } = {}) {
  async function inspect() {
    const list = await run(upscBinary, ["-l", "localhost"], { timeout: 5000 });
    if (!list.ok) return baseEvidence({ installed: list.code !== "ENOENT", reason: list.code === "ENOENT" ? "nut-client-not-installed" : "nut-local-service-unavailable" });
    const names = [...new Set(list.stdout.split("\n").map((item) => item.trim()).filter(Boolean))].slice(0, 17);
    if (names.length === 0) return baseEvidence({ installed: true, reason: "no-local-ups-configured" });
    if (names.length !== 1 || !upsNamePattern.test(names[0])) return baseEvidence({ installed: true, configured: true, deviceCount: Math.min(names.length, 16), reason: names.length > 16 ? "too-many-local-ups-devices" : names.length > 1 ? "multiple-local-ups-devices" : "invalid-local-ups-identity" });
    const state = await run(upscBinary, [`${names[0]}@localhost`], { timeout: 5000 });
    if (!state.ok) return baseEvidence({ installed: true, configured: true, deviceCount: 1, reason: "local-ups-state-unavailable" });
    const parsed = parseVariables(state.stdout);
    return baseEvidence({ installed: true, configured: true, deviceCount: 1, ...parsed, reason: parsed.available ? "ok" : "local-ups-status-unavailable" });
  }
  return { inspect };
}

export const upsInternals = { baseEvidence, boundedNumber, fixedStatusTokens, parseVariables, upscBinary, upsNamePattern };
