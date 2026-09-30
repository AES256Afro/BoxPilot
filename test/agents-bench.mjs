/**
 * The owner's first real question, replayed (M37). On the owner's server Qwen 3.5 4B on one thread
 * read a prompt at about 20 tokens a second and wrote at about 4, and the run timed out. Here the
 * run goes through the real service, the real tools (on a server made to look like a busy one:
 * three live alerts, a dozen apps, several drives, a failed service) and the real runner, against
 * either:
 * - the stand-in model (fake-model.mjs), taking as long as that model would to read and write, on
 *   the harness's clock, with one slot's prompt cache as llama-server keeps it for a hybrid model.
 *   Its part is scripted to what Qwen did on the owner's server, with the plan read as it was meant
 *   (alerts, storage, services, apps, memory): plan, three reads, two more, answer; or
 * - a real model server (tests/bench/agents-real.mjs starts Unsloth with BoxPilot's own runtime),
 *   whose calls are timed from llama-server's own timings.
 *
 *   node test/agents-bench.mjs [--prompt 20] [--generate 4] [--json]
 *
 * server/agents/bench.test.mjs runs the stand-in in CI and holds it to the run's limits.
 */
import zlib from "node:zlib";
import { createAgentsHarness } from "./agents-harness.mjs";
import { createOpenAiClient } from "../server/assistant/model-client.mjs";
import { createRunner, directRunnerApi } from "../server/agents/runner.mjs";
import { agentsRuntimeKey, defaultRuntimeSettings, modelSpeedKey } from "../server/agents/service.mjs";

export const ownerQuestion = "Most important server or platform issue to focus on within boxpilot.";
export const typicalQuestion = "Is Pi-hole running natively on the host or in a container?";

/** The plan Qwen meant, and the reads and the answer that follow it. */
export const ownerScript = Object.freeze({
  understanding: {
    goal: "Find the most important server or platform issue to focus on", subject: "this server and BoxPilot", constraints: [], confidence: 0.7, clarify: null,
    plan: [
      { step: "Read the live health alerts", tool: "alerts_active" }, { step: "Check disks and SMART health", tool: "storage_health" },
      { step: "Check for failed services", tool: "services_status" }, { step: "Check the apps and containers", tool: "apps_list" },
      { step: "Recall what was learned before", tool: "memory_search" }, { step: "Answer with the most important issue first", tool: null },
    ],
  },
  rounds: [
    [{ name: "alerts_active", arguments: {} }, { name: "storage_health", arguments: {} }, { name: "services_status", arguments: {} }],
    [{ name: "apps_list", arguments: {} }, { name: "memory_search", arguments: { query: "server issues" } }],
  ],
  answer: [
    "The most important issue is the backup drive: sdb reports reallocated sectors and SMART calls it failing [T1] [T2]. Replace it and check that last night's backups restore.",
    "Next, Jellyfin is unhealthy and has restarted 14 times today [T1] [T4]; its logs say why.",
    "smartd.service has failed [T3], so drive warnings may stop coming; restart it once the drive is replaced.",
    "Everything else looks fine: the root disk is 58% full and the other apps are healthy [T2] [T4].",
  ].join("\n"),
});

const apps = ["pi-hole", "jellyfin", "nextcloud", "immich", "home-assistant", "vaultwarden", "paperless", "uptime-kuma", "grafana", "syncthing", "freshrss", "gitea"];

/** A server that has something to say: alerts, apps, drives and a failed service. */
export function busyServer(h) {
  h.state.setSetting("healthAlertsState", {
    "storage.smart:sdb": { title: "Drive sdb (backup) reports 48 reallocated sectors; SMART overall health: FAILING", since: "2026-09-28T22:10:00.000Z", notified: true },
    "docker.unhealthy:bp-jellyfin": { title: "Jellyfin is unhealthy and restarted 14 times in the last 24 hours", since: "2026-09-29T02:41:00.000Z", notified: true },
    "system.reboot": { title: "A reboot is waiting: the kernel was updated", since: "2026-09-27T06:00:00.000Z", notified: false },
  });
  h.helperAnswers["app.inspect"] = () => ({ applications: apps.map((id, index) => ({
    id, name: id.replace(/(^|-)(\w)/g, (_match, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`), installed: true,
    container: { running: true, status: "running", health: id === "jellyfin" ? "unhealthy" : "healthy", restarts: id === "jellyfin" ? 14 : index % 3 },
    urls: [{ url: `http://192.0.2.10:${8080 + index}`, label: "Web" }],
  })) });
  h.helperAnswers["service.list"] = () => ({
    units: [
      ...["docker", "boxpilot", "boxpilot-helper", "tailscaled", "ssh", "cron", "systemd-journald", "systemd-resolved"].map((name) => ({ unit: `${name}.service`, active: "active", sub: "running", enabled: "enabled" })),
      { unit: "smartd.service", active: "failed", sub: "failed", enabled: "enabled", description: "Self Monitoring and Reporting Technology (SMART) Daemon" },
    ],
    counts: { total: 187, active: 142, failed: 1 },
  });
  // The inventory's own shapes (server/inventory.mjs): the root scan's mounts, lsblk's devices and SMART.
  const mount = (target, source, totalBytes, usedPercent) => ({ target, source, filesystem: "ext4", totalBytes, usedBytes: Math.round(totalBytes * usedPercent / 100), availableBytes: Math.round(totalBytes * (100 - usedPercent) / 100), usedPercent, capacityState: usedPercent >= 85 ? "warning" : "healthy", readOnly: false });
  const disk = (name, sizeBytes, transport, rotational, model) => ({ name, parent: null, type: "disk", filesystem: null, sizeBytes, mountTargets: [], rotational, readOnly: false, transport, model });
  const part = (name, parent, target) => ({ name, parent, type: "part", filesystem: "ext4", sizeBytes: null, mountTargets: [target], rotational: null, readOnly: false, transport: null, model: null });
  Object.assign(h.snapshot.storage, {
    root: { usedPercent: 58, freeBytes: 290e9, totalBytes: 700e9 },
    filesystems: { available: true, mounts: [mount("/", "/dev/nvme0n1p2", 700e9, 58), mount("/mnt/media", "/dev/sda1", 8e12, 81), mount("/mnt/boxpilot/backup", "/dev/sdb1", 4e12, 64)] },
    blockDevices: { available: true, devices: [
      disk("/dev/nvme0n1", 1e12, "nvme", false, "Example NVMe 1TB"), part("/dev/nvme0n1p2", "/dev/nvme0n1", "/"),
      disk("/dev/sda", 8e12, "sata", true, "Example HDD 8TB"), part("/dev/sda1", "/dev/sda", "/mnt/media"),
      disk("/dev/sdb", 4e12, "sata", true, "Example HDD 4TB"), part("/dev/sdb1", "/dev/sdb", "/mnt/boxpilot/backup"),
    ] },
    smart: { available: true, status: "critical", generatedAt: "2026-09-29T03:00:00.000Z", summary: { healthy: 2, warning: 0, critical: 1, unavailable: 0 }, disks: [
      { device: "/dev/nvme0n1", health: "healthy", temperatureCelsius: 41, percentageUsed: 4, mediaErrors: 0 },
      { device: "/dev/sda", health: "healthy", temperatureCelsius: 36 },
      { device: "/dev/sdb", health: "critical", temperatureCelsius: 44, reason: "ok" },
    ] },
  });
}

/**
 * A bench: the service with the owner's three agents (Steve, a Server Keeper, and its two
 * specialists), the busy server, and a runner. `real` is { runtime, threads } for a real model
 * server; without it the stand-in answers at `promptPerSecond`/`generatePerSecond` on the harness's
 * clock, scripted by `script`. `stored` is what BoxPilot measured before (null: never measured).
 */
export async function createBench({ promptPerSecond = 20, generatePerSecond = 4, stored = null, script = ownerScript, makeRunner = createRunner, real = null, runnerOptions = {} } = {}) {
  const h = await createAgentsHarness(real ? { start: new Date() } : {});
  h.enable();
  h.state.setSetting(agentsRuntimeKey, defaultRuntimeSettings());
  if (stored) h.state.setSetting(modelSpeedKey, { ...stored, model: defaultRuntimeSettings().repo, threads: real?.threads ?? 4, runs: 1, measuredAt: h.now().toISOString(), source: "server" });
  busyServer(h);
  const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
  h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" });
  h.service.createAgent(h.caller("owner"), { template: "backup-auditor" });
  // Every call the runner makes, with what the server said about it.
  const calls = [];
  const client = createOpenAiClient({ loopbackOnly: true });
  const recording = { ...client, chat: async (endpoint, request, options) => {
    const result = await client.chat(endpoint, request, options);
    calls.push({ request, result });
    return result;
  } };
  let runtime;
  let now;
  if (real) {
    runtime = real.runtime;
    now = () => Date.now();
  } else {
    h.fake.state.speed = { promptPerSecond, generatePerSecond };
    h.fake.state.clock = (ms) => h.advance(ms);
    let round = 0;
    h.fake.state.script = (body) => {
      if (body.response_format?.json_schema?.name === "understanding") { round = 0; return { understanding: script.understanding }; }
      if (body.tool_choice === "none") return { content: script.answer };
      const planned = script.rounds[round];
      round += 1;
      return planned ? { toolCalls: planned } : { content: script.answer };
    };
    runtime = { ensure: async () => ({ endpoint: h.fake.url, apiKey: null, model: h.fake.model, loadMs: 0 }), touch: () => {}, stop: async () => {}, maybeStopIdle: async () => {}, status: () => ({ state: "running", modelLoaded: true, model: h.fake.model }) };
    now = () => h.now().getTime();
  }
  const runner = makeRunner({ api: directRunnerApi(h.service, h.runnerId), runtime, client: recording, now, options: runnerOptions });

  /**
   * Ask one question and time it: each call's tokens (read, cached, written) and seconds, and the
   * run. `agent` asks another agent than Steve; `beforeExecute(claim)` may change the claim or the clock.
   */
  async function ask(question = ownerQuestion, { agent = keeper, beforeExecute = null } = {}) {
    // On a real model the service's clock is the real one too, so each run's deadline is its own.
    if (real) h.setTime(new Date());
    const queued = h.service.startRun(h.caller("owner"), agent.id, { kind: "ask", question });
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    if (real?.threads) claim.runtime = { ...claim.runtime, threads: real.threads };
    await beforeExecute?.(claim);
    const from = calls.length;
    const fakeFrom = h.fake.calls().length;
    const started = now();
    await runner.execute(claim);
    const wallMs = now() - started;
    const run = h.service.getRun(h.caller("owner"), queued.id);
    const mine = calls.slice(from).map(({ request, result }, index) => {
      const fake = real ? null : h.fake.calls()[fakeFrom + index] ?? { promptMs: 0, generateMs: 0 };
      const timings = result.timings ?? {};
      const promptTokens = result.usage?.promptTokens ?? null;
      const cachedTokens = timings.cachedTokens ?? result.usage?.cachedTokens ?? null;
      return {
        call: request.extra?.response_format?.json_schema?.name === "understanding" ? "plan" : `act ${index}`,
        tools: request.tools?.length ?? 0, toolChoice: request.tools?.length ? request.toolChoice ?? "auto" : null,
        promptTokens, cachedTokens, readTokens: timings.promptTokens ?? (promptTokens !== null && cachedTokens !== null ? promptTokens - cachedTokens : null),
        writtenTokens: result.usage?.completionTokens ?? null,
        readSeconds: timings.promptMs !== null && timings.promptMs !== undefined ? Math.round(timings.promptMs / 100) / 10 : fake ? Math.round(fake.promptMs / 100) / 10 : null,
        writeSeconds: timings.predictedMs !== null && timings.predictedMs !== undefined ? Math.round(timings.predictedMs / 100) / 10 : fake ? Math.round(fake.generateMs / 100) / 10 : null,
        readPerSecond: timings.promptPerSecond ?? null, writePerSecond: timings.predictedPerSecond ?? null,
        seconds: real ? Math.round((result.elapsedMs ?? 0) / 100) / 10 : Math.round((fake.promptMs + fake.generateMs) / 100) / 10,
        thinking: request.extra?.enable_thinking ?? request.extra?.chat_template_kwargs?.enable_thinking ?? null,
      };
    });
    return { question, wallMs, calls: mine, run, requests: calls.slice(from).map((entry) => entry.request), claim };
  }

  return { h, ask, keeper, usage: () => h.service.usage(h.caller("owner")), close: () => h.close() };
}

/** One question on a fresh bench. */
export async function runOwnerQuestion(options = {}) {
  const bench = await createBench(options);
  try {
    const result = await bench.ask(options.question ?? ownerQuestion);
    return { ...result, promptPerSecond: options.promptPerSecond ?? 20, generatePerSecond: options.generatePerSecond ?? 4, usage: bench.usage() };
  } finally {
    await bench.close();
  }
}

/**
 * A picture a vision model can say something definite about (M40.6): a red disc above a blue bar on
 * white, 160 by 120, as a PNG made here (no file in the repository, nothing from anyone's server).
 */
export function benchPicture() {
  const width = 160;
  const height = 120;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];   // each row starts with its filter byte: none
    for (let x = 0; x < width; x += 1) {
      const inDisc = (x - 80) ** 2 + (y - 50) ** 2 <= 32 ** 2;
      const inBar = y >= 96 && y < 108 && x >= 24 && x < 136;
      row.push(...(inDisc ? [220, 30, 30] : inBar ? [30, 60, 210] : [255, 255, 255]));
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])));
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);   // 8 bits, truecolour, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * An image from #agent-files described the way the owner's server describes one (M40.6): the
 * service queues the describe run in quiet hours (here, the hours around now), the runner starts
 * the model server, asks it whether it can see, and sends it the image; the description, redacted,
 * becomes the document's text. On the stand-in model unless `real` ({ runtime, threads }) is given.
 */
export async function describeBenchImage({ real = null, png = benchPicture(), name = "bench-picture.png" } = {}) {
  const h = await createAgentsHarness(real ? { start: new Date() } : {});
  try {
    h.enable();
    // Unsloth with the default model, as on the owner's server; the stand-in is the harness's own.
    if (real) { h.state.setSetting(agentsRuntimeKey, defaultRuntimeSettings()); h.setTime(new Date()); }
    const hour = (offset) => `${String((h.now().getHours() + offset) % 24).padStart(2, "0")}:00`;
    // Only the describe run: no index run for meaning search, and no agents to evaluate.
    h.service.saveModule(h.caller("owner"), { embeddings: false, quietHours: { start: hour(0), end: hour(2) } });
    const title = `Image: ${name.replace(/\.png$/i, "")}`;
    h.store.upsertDocument({ source: "zulip", externalId: `bench:${name}`, title, text: `Image "${name}", dropped in #agent-files by the bench. Not described yet: the model describes images in quiet hours.`, mediaType: "image/png", media: png });
    const runtime = real ? real.runtime : h.runtime;
    const runner = real ? createRunner({ api: directRunnerApi(h.service, h.runnerId), runtime, client: createOpenAiClient({ loopbackOnly: true }), now: () => Date.now() }) : h.runner;
    await h.service.tick();
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    if (claim?.run.kind !== "describe") throw new Error(`Quiet hours queued ${claim ? `a ${claim.run.kind} run` : "nothing"}, not the describe run`);
    if (real?.threads) claim.runtime = { ...claim.runtime, threads: real.threads };
    const started = Date.now();
    await runner.execute(claim);
    const run = h.service.getRun(h.caller("owner"), claim.run.id);
    const document = h.store.listDocuments().find((entry) => entry.title === title);
    return {
      state: run.state, reason: run.reason ?? null, seconds: Math.round((Date.now() - started) / 100) / 10, usage: run.usage,
      // What the model server said about seeing (Unsloth's /api/inference/status), and what was kept.
      server: await runtime.vision?.() ?? null, vision: (await h.service.knowledgeState(h.caller("owner"))).vision,
      described: Boolean(document?.describedAt), text: document?.text ?? null,
    };
  } finally {
    await h.close();
  }
}

/** The report as a table a person reads. */
export function describe(result, label = null) {
  const cell = (value, width) => String(value ?? "-").padStart(width);
  const rows = result.calls.map((call) => `${call.call.padEnd(6)} ${cell(call.tools, 5)} ${cell(call.promptTokens, 7)} ${cell(call.cachedTokens, 7)} ${cell(call.readTokens, 6)} ${cell(call.writtenTokens, 7)} ${cell(call.readSeconds, 7)} ${cell(call.writeSeconds, 7)} ${cell(call.seconds, 7)}`);
  const usage = result.run.usage ?? {};
  return [
    label ?? `"${result.question}"`,
    "call   tools  prompt  cached   read  written  read s  write s  call s",
    ...rows,
    `wall time ${(result.wallMs / 1000).toFixed(1)} s; outcome ${result.run.state}${result.run.flags?.degraded ? ` (${result.run.flags.degraded})` : ""}; ${usage.modelCalls} model calls, ${usage.toolCalls} tool calls`,
    `tokens: ${usage.promptTokens} in prompts, ${usage.cachedTokens} of them cached, ${usage.readTokens} read, ${usage.completionTokens} written${usage.speed ? `; measured ${usage.speed.promptPerSecond} read and ${usage.speed.generatePerSecond} written a second` : ""}`,
  ].join("\n");
}

if (import.meta.main) {
  const argument = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? Number(process.argv[index + 1]) : fallback; };
  const promptPerSecond = argument("prompt", 20);
  const generatePerSecond = argument("generate", 4);
  const result = await runOwnerQuestion({ promptPerSecond, generatePerSecond });
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ wallMs: result.wallMs, state: result.run.state, calls: result.calls, usage: result.run.usage }, null, 1)}\n`);
  else process.stdout.write(`${describe(result, `"${result.question}" at ${promptPerSecond} tokens a second reading, ${generatePerSecond} writing`)}\n\nThe answer:\n${result.run.answer}\n`);
}
