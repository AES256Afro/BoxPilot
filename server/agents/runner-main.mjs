#!/usr/bin/env node
/**
 * boxpilot-agents.service (M37): the agents runner. Runs as its own user, under hard caps (CPUQuota,
 * CPUWeight=idle, Nice=19, IOSchedulingClass=idle, MemoryMax), with loopback as its only network.
 * It talks to BoxPilot's web service with a key systemd hands it (LoadCredential=runner-token), and
 * to the model server it starts itself; never to the root helper.
 *
 * Environment:
 *   BOXPILOT_AGENTS_API      the web service, default http://127.0.0.1:$BOXPILOT_PORT (8787)
 *   CREDENTIALS_DIRECTORY    set by systemd; runner-token is read from it
 *   BOXPILOT_AGENTS_TOKEN_FILE  the key's file when not run by systemd (development)
 *   BOXPILOT_AGENTS_STATE    the runner's own state (the model cache), default /var/lib/boxpilot-agents
 *   BOXPILOT_AGENTS_RUNTIME  where Unsloth is installed, default /var/lib/boxpilot-agents/unsloth
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createOpenAiClient } from "../assistant/model-client.mjs";
import { productVersion } from "../version.mjs";
import { createRunner, createRunnerApi, runnerApiBase } from "./runner.mjs";
import { createRuntime } from "./runtime.mjs";
import { createUsageReader } from "./usage.mjs";

const log = (message) => console.log(`[boxpilot-agents] ${message}`);

async function readToken() {
  const file = process.env.CREDENTIALS_DIRECTORY ? path.join(process.env.CREDENTIALS_DIRECTORY, "runner-token") : process.env.BOXPILOT_AGENTS_TOKEN_FILE;
  if (!file) throw new Error("No runner key: start this as boxpilot-agents.service, or set BOXPILOT_AGENTS_TOKEN_FILE");
  const token = (await readFile(file, "utf8")).trim();
  if (token.length < 20) throw new Error("The runner key is too short");
  return token;
}

const base = runnerApiBase(process.env);
if (!/^http:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]):\d+$/.test(base)) {
  console.error("[boxpilot-agents] BOXPILOT_AGENTS_API must be BoxPilot on this machine, like http://127.0.0.1:8787");
  process.exit(2);
}

const token = await readToken().catch((error) => { console.error(`[boxpilot-agents] ${error.message}`); process.exit(2); });
const runnerId = randomUUID();
const client = createOpenAiClient({ loopbackOnly: true });
const runtime = createRuntime({ client, log });
const runner = createRunner({ api: createRunnerApi({ base, token, runnerId }), runtime, client, usage: createUsageReader(), log, version: productVersion });

const shutdown = new AbortController();
const stop = (signalName) => {
  log(`${signalName}: stopping`);
  shutdown.abort();
  // The model server is our child; it must not outlive us, whatever happens next.
  setTimeout(() => { runtime.killNow(); process.exit(0); }, 15_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", () => runtime.killNow());

log(`runner ${productVersion} started; waiting for work from ${base}`);
await runner.loop({ signal: shutdown.signal });
log("stopped");
process.exit(0);
