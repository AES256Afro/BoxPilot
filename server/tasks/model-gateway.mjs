/**
 * Root tasks for the model gateway (M45.3, ADR-013). Tasks rather than helper work: the key and the
 * monthly cap live under /etc/boxpilot, which the helper's sandbox cannot write, and proving the key
 * means reaching Anthropic, which the helper cannot.
 *
 * - model-gateway.connect     the key, root-only, and the cap; the gateway on; the key proved by
 *                             reading one model's details from Claude, which costs nothing. A key
 *                             Claude refuses is not kept: the one before it comes back, or none.
 * - model-gateway.cap         a new monthly cap. The gateway reads it on its next call.
 * - model-gateway.disconnect  the gateway off and the key deleted. The month's spend is kept.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeFileDurably } from "../durable-file.mjs";
import { fixedRun } from "../exec.mjs";
import { gatewayUnit, gatewayUser, keyFile, settingsFile } from "../model-gateway/paths.mjs";
import { createGatewayClient } from "../model-gateway/socket.mjs";

const systemctl = "/usr/bin/systemctl";
const defaultFiles = { mkdir, readFile, writeFile: writeFileDurably, rm };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** An Anthropic API key as the Console issues it. */
export const anthropicKeyPattern = /^sk-ant-[A-Za-z0-9_-]{20,400}$/;
/** The monthly cap, in whole US dollars. */
export const capLimits = Object.freeze({ least: 1, most: 1_000 });

export function capProblem(capUsd) {
  return Number.isInteger(capUsd) && capUsd >= capLimits.least && capUsd <= capLimits.most ? null : `must be whole dollars from ${capLimits.least} to ${capLimits.most}`;
}

const lastLines = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");

async function ensureUser(run) {
  const known = await run("/usr/bin/id", ["-u", gatewayUser], { timeout: 10_000 });
  if (known.ok) return false;
  const made = await run("/usr/sbin/useradd", ["--system", "--home-dir", "/nonexistent", "--no-create-home", "--shell", "/usr/sbin/nologin", "--user-group", gatewayUser], { timeout: 30_000 });
  if (!made.ok) throw new Error(`Could not create the ${gatewayUser} user: ${lastLines(made.stderr)}`);
  return true;
}

const writeCap = (files, capUsd) => files.writeFile(settingsFile, `${JSON.stringify({ capUsd })}\n`, { mode: 0o644 });

/** Wait for the gateway's socket to answer after a start: up to about ten seconds. */
async function answering(client, wait) {
  let last = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await client.status(); } catch (error) { last = error; }
    await wait(500);
  }
  throw Object.assign(new Error(`${gatewayUnit} did not start answering: ${last?.message ?? "no answer"}`), { code: "gateway-down" });
}

export async function modelGatewayConnect({ key, capUsd } = {}, { run = fixedRun, log = () => {}, files = defaultFiles, client = createGatewayClient(), wait = sleep } = {}) {
  if (typeof key !== "string" || !anthropicKeyPattern.test(key)) throw new Error("That is not an Anthropic API key: they start sk-ant- and come from the Anthropic Console");
  const problem = capProblem(capUsd);
  if (problem) throw new Error(`The monthly cap ${problem}`);
  const unit = await run(systemctl, ["cat", gatewayUnit], { timeout: 15_000 });
  if (!unit.ok) throw new Error(`${gatewayUnit} is not installed; upgrade BoxPilot to get it`);
  if (await ensureUser(run)) log(`Created the ${gatewayUser} user`, "stdout");

  const before = await files.readFile(keyFile, "utf8").catch(() => null);
  await files.mkdir("/etc/boxpilot/secrets", { recursive: true, mode: 0o700 });
  await files.writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  await writeCap(files, capUsd);
  log(`Stored the key root-only at ${keyFile}; it is not written to this log. The monthly cap is $${capUsd}.`, "stdout");

  try {
    const enabled = await run(systemctl, ["enable", gatewayUnit], { timeout: 30_000 });
    if (!enabled.ok) throw new Error(`systemctl could not enable ${gatewayUnit}: ${lastLines(enabled.stderr)}`);
    // A restart, not a start: a gateway already running holds the old key until it starts again.
    const restarted = await run(systemctl, ["restart", gatewayUnit], { timeout: 60_000 });
    if (!restarted.ok) throw new Error(`systemctl could not start ${gatewayUnit}: ${lastLines(restarted.stderr)}`);
    await answering(client, wait);
    await client.check();
    log("Claude accepted the key. Nothing was spent to check it.", "stdout");
  } catch (error) {
    if (before) {
      await files.writeFile(keyFile, before, { mode: 0o600 });
      await run(systemctl, ["restart", gatewayUnit], { timeout: 60_000 });
      log("Put the key that was there before back.", "stderr");
    } else {
      await run(systemctl, ["disable", "--now", gatewayUnit], { timeout: 60_000 });
      await files.rm(keyFile, { force: true });
      log("Kept no key.", "stderr");
    }
    if (error?.code === "auth" || error?.code === "forbidden") throw new Error("Claude refused this key, so it was not kept. Check it in the Anthropic Console.");
    if (error?.code === "unreachable" || error?.code === "timeout") throw new Error("Claude could not be reached from this server, so the key was not kept. Check the server's internet connection and try again.");
    throw error;
  }
  return { connected: true, capUsd, unit: gatewayUnit };
}

export async function modelGatewayCap({ capUsd } = {}, { log = () => {}, files = defaultFiles } = {}) {
  const problem = capProblem(capUsd);
  if (problem) throw new Error(`The monthly cap ${problem}`);
  await writeCap(files, capUsd);
  log(`The monthly cap is now $${capUsd}; the gateway holds calls to it from the next one.`, "stdout");
  return { capUsd };
}

export async function modelGatewayDisconnect(_parameters = {}, { run = fixedRun, log = () => {}, files = defaultFiles } = {}) {
  const stopped = await run(systemctl, ["disable", "--now", gatewayUnit], { timeout: 60_000 });
  if (!stopped.ok && !/not loaded|does not exist|No such file/i.test(stopped.stderr)) throw new Error(`systemctl could not stop ${gatewayUnit}: ${lastLines(stopped.stderr)}`);
  await files.rm(keyFile, { force: true });
  log(`Stopped ${gatewayUnit} and deleted the key. This month's spend is kept.`, "stdout");
  return { connected: false };
}
