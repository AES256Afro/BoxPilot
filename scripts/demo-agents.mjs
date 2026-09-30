/**
 * The Agents section in the demo (M37): the real agent service, store and runner, each world on a
 * temporary database of its own, with a stand-in model in this process instead of Unsloth. Nothing
 * is read from or run on the machine: the helper answers from the demo's fictional server (homebox),
 * and the model is server/agents/fake-model.mjs, scripted for the runs seeded here.
 *
 * Built the first time a world's Agents section is asked for, not when the demo module is imported,
 * so the fixture tests that import it never start anything:
 *
 * - default: Agents on, four agents from the templates, a digest written this morning in quiet
 *   hours, questions answered (one thumbed up, one down), notes kept and shared, an evaluation
 *   scored, a request the Server Keeper handed to two specialists and answered from what they
 *   found, five cards waiting (two backups the agents proposed, a newer Qwen, a question the IT
 *   helper asked back and a low-confidence answer for the owner to look at), and a live runner,
 *   so the test console really runs.
 * - fresh: Agents never turned on, nothing installed.
 * - trouble: Agents on, Unsloth installed and the model downloaded, but the runner's unit stopped
 *   (inactive and disabled, as on a server where nobody pressed Start the runner), so a question
 *   asked ten minutes ago waits for it. An hour earlier the model would not start, so that question
 *   was answered from the tools alone; the Pi-hole Watcher is paused.
 *
 * The owner's password is not asked for in the demo: any password saves the settings.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import { createKnowledgeIndex } from "../server/assistant/knowledge.mjs";
import { createOpenAiClient } from "../server/assistant/model-client.mjs";
import { startFakeModel } from "../server/agents/fake-model.mjs";
import { runnerCaps, runnerUnit } from "../server/agents/caps.mjs";
import { modelById, testedUnslothVersion } from "../server/agents/models.mjs";
import { createRunner, directRunnerApi } from "../server/agents/runner.mjs";
import { ModelUnavailable, createRuntime } from "../server/agents/runtime.mjs";
import { agentsRuntimeKey, createAgentService, defaultRuntimeSettings } from "../server/agents/service.mjs";
import { createAgentStore } from "../server/agents/store.mjs";
import { drivesOf } from "../server/agents/tool-text.mjs";
import { registry } from "../server/ops/index.mjs";
import { createRedactor } from "../server/redaction.mjs";
import { createAgentsRouter } from "../server/routes/agents.mjs";
import { createStateStore } from "../server/state.mjs";
import { productVersion } from "../server/version.mjs";

const hours = (count) => count * 3600_000;
const withTools = (body) => body.messages.filter((message) => message.role === "tool").length;
/** Whether a request to the model is from this agent: its system message names it. */
const from = (body, name) => String(body?.messages?.[0]?.content ?? "").includes(`Your name is ${name}.`);
/** Whether this request is the first one of a run, asking how the request was understood. */
const understanding = (body) => body?.response_format?.json_schema?.name === "understanding";
/** Whether this is a supervisor's follow-up run, with its specialists' answers. */
const continuing = (body) => JSON.stringify(body?.messages ?? []).includes("have answered");
const call = (name, args = {}) => ({ name: name.replace(/\./g, "_"), arguments: args });

/** What the demo's helper answers: the fictional server's apps, services and Pi-hole, and the runtime. */
function helperFor(world, { apps, services }) {
  const model = modelById("qwen3.5-4b");
  const runtime = {
    default: { runtime: { installed: true, path: "/var/lib/boxpilot-agents/unsloth/bin/unsloth" }, service: { unit: runnerUnit, loaded: true, active: "active", sub: "running", enabled: "enabled" },
      models: [{ repo: model.repo, file: model.file, bytes: 2_910_000_000, complete: true, projector: false }, { repo: model.repo, file: model.projector, bytes: 672_000_000, complete: true, projector: true }], diskFreeBytes: 588 * 1024 ** 3 },
    fresh: { runtime: { installed: false, path: "/var/lib/boxpilot-agents/unsloth/bin/unsloth" }, service: { unit: runnerUnit, loaded: true, active: "inactive", sub: "dead", enabled: "disabled" }, models: [], diskFreeBytes: 588 * 1024 ** 3 },
    trouble: { runtime: { installed: true, path: "/var/lib/boxpilot-agents/unsloth/bin/unsloth" }, service: { unit: runnerUnit, loaded: true, active: "inactive", sub: "dead", enabled: "disabled" },
      models: [{ repo: model.repo, file: model.file, bytes: 2_910_000_000, complete: true, projector: false }], diskFreeBytes: 12 * 1024 ** 3 },
  }[world];
  const answers = {
    "app.inspect": () => ({ applications: Object.keys(apps).map((id) => ({ id, name: id, installed: true, container: { running: true, status: "running", health: world === "trouble" && id === "jellyfin" ? "unhealthy" : "healthy", restarts: world === "trouble" && id === "jellyfin" ? 4 : 0 }, urls: id === "zulip" ? [{ id: "web", host: 8543, exposure: "loopback" }] : [] })) }),
    "service.list": () => services,
    "logs.read": (parameters) => ({ kind: parameters.kind, target: parameters.target, lines: ["demo: nothing is read from this machine"] }),
    "app.pihole.inspect": () => ({
      placement: "boxpilot-app", container: "bp-pi-hole", running: true, available: true, blocking: true,
      last24h: { queries: 48_210, blocked: 9_112, blockedPercent: 18.9 },
      gravity: { domains: 182_340, updatedAt: new Date(Date.now() - hours(26)).toISOString(), ageDays: 1.1 },
      upstreams: [{ upstream: "9.9.9.9#53", queries: 30_100, share: 77, averageReplyMs: 18 }, { upstream: "149.112.112.112#53", queries: 9_000, share: 23, averageReplyMs: 21 }],
      topBlocked: [{ domain: "telemetry.example.com", count: 1_840 }, { domain: "ads.example.net", count: 1_210 }],
    }),
    "agents.runtime.inspect": () => runtime,
    // The team chat (M38): Zulip takes every post, except in trouble, where it refuses the bot's key;
    // #agent-files holds one note the owner dropped this morning, read once.
    "agents.zulip.post": (parameters) => ({ results: parameters.posts.map((post, index) => (world === "trouble" ? { id: post.id, ok: false, error: "Zulip refused the bot's key; connect Zulip again" } : { id: post.id, ok: true, messageId: 900 + index })) }),
    "agents.zulip.poll": (parameters) => (parameters.after ? { messages: [], last: parameters.after, more: false } : {
      last: 41, more: false,
      messages: [{ id: 41, topic: "network", sender: "Alex", content: "The router notes [router.md](/user_uploads/2/aa/bb/router.md)", files: [{ name: "router.md", kind: "text", path: "/user_uploads/2/aa/bb/router.md", bytes: Buffer.from("# The router\nThe router is upstairs in the office, on the shelf above the printer. Its admin page is at 192.168.50.1.").toString("base64") }] }],
    }),
  };
  return { request: async (operation, parameters) => { const answer = answers[operation]; if (!answer) throw new Error(`${operation} is not in the demo`); return answer(parameters ?? {}); } };
}

async function buildWorld(world, fixtures) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `boxpilot-demo-agents-${world}-`));
  // The world's own clock, moved back to seed what happened earlier today, then the real time.
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const at = (date) => { offset = date.getTime() - Date.now(); };
  const state = createStateStore({ stateDirectory: directory, now });
  const store = createAgentStore({ databasePath: state.databasePath, now });
  const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: "demo" });
  const caller = { id: owner.id, role: "owner" };
  const helper = helperFor(world, fixtures);
  const service = createAgentService({
    state, store, registry, helper, inventory: { inspect: async () => fixtures.inventory() },
    knowledge: createKnowledgeIndex({ registry, catalog: null, now }),
    healthAlerts: { tell: async (entry) => ({ key: entry.key, notified: false }) },
    redactor: createRedactor(),
    tokenPath: path.join(directory, "agents", "runner.token"),
    // The demo's look at Hugging Face: a newer small Qwen, so the card that offers it can be seen.
    fetchJson: async (url) => (url.includes("?author=") ? [{ id: "unsloth/Qwen3.6-4B-GGUF" }] : { siblings: [{ rfilename: "Qwen3.6-4B-UD-Q4_K_XL.gguf" }, { rfilename: "mmproj-F16.gguf" }] }),
    now, hostLoad: () => 0,
    limits: world === "trouble" ? { runnerOnlineMs: 1 } : {},
  });

  const fake = await startFakeModel({ model: "unsloth/Qwen3.5-4B-GGUF" });
  const client = createOpenAiClient({ loopbackOnly: true });
  const base = createRuntime({ client });
  // The runner asks for Unsloth; the demo hands it the stand-in instead (or, in trouble, nothing).
  const runtime = {
    ...base,
    ensure: world === "trouble"
      ? async () => { throw new ModelUnavailable("The model server stopped while starting: llama-server could not start: the system library libgomp.so.1 is missing"); }
      : (requested, options) => base.ensure({ ...requested, driver: "external", endpoint: fake.url }, options),
  };
  const usage = {
    read: async () => ({ cgroup: true, cpuPercent: 0.3, memoryBytes: 212_000_000, memoryPeakBytes: 6_050_000_000, cpuQuotaPercent: runnerCaps.cpuQuotaPercent, memoryMaxBytes: runnerCaps.memoryMaxBytes, throttledMs: 18_400 }),
    hostBusy: async () => false,
  };
  const runnerId = randomUUID();
  const runner = createRunner({ api: directRunnerApi(service, runnerId), runtime, client, usage, now: () => now().getTime(), version: productVersion });
  const runNext = async () => {
    const claim = await service.runnerNext(runnerId, { waitMs: 0 });
    if (claim) await runner.execute(claim);
    return claim?.run.id ?? null;
  };
  const script = (fn) => { fake.state.script = fn; };

  if (world !== "fresh") await seed({ service, state, store, caller, at, runNext, script, world, fixtures });
  offset = 0;
  script(null);

  const stop = new AbortController();
  if (world === "default") {
    // Seen now, not when the seeded runs were: the page's first read finds the runner answering.
    service.runnerUsage(runnerId, { usage: { state: "idle", ...(await usage.read()) }, hostBusy: false });
    void runner.loop({ signal: stop.signal });
  }
  const router = createAgentsRouter({
    agents: service, state,
    auth: { requireCsrf: (_request, _response, next) => next(), requireRole: () => (_request, _response, next) => next(), checkPassword: async () => ({ ok: true }), rejectThrottled: (response) => response.status(429).end() },
  });
  return {
    handle: (request, response, next) => { request.boxpilotSession = { owner: { id: owner.id, role: "owner" } }; router(request, response, next); },
    close: async () => { stop.abort(); await fake.close(); await base.stop("demo over"); store.close(); state.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

/**
 * The nightly evaluations of the nights before (M40), as the evaluation records them: each agent's
 * built-in and own questions, graded against the demo server's facts. `wrong` names, for a night,
 * the questions answered wrong. Written straight to the store: the runs themselves are long gone.
 */
function seedNights({ service, store, caller, at, agents, facts, nights }) {
  for (const { night, wrong = {} } of nights) {
    at(night);
    for (const agent of agents) {
      const evaluation = service.getEvaluation(caller, agent.id);
      const questions = [...(evaluation.builtIn ?? []), ...evaluation.questions];
      if (!questions.length) continue;
      const results = questions.map((question) => ({ questionId: question.id, question: question.question, expected: question.expect.fact ? { fact: question.expect.fact, value: facts[question.expect.fact] ?? null } : { includes: question.expect.includes }, runId: null, passed: null, found: null }));
      const run = store.createEvalRun({ agentId: agent.id, version: agent.version, results, createdBy: null, model: defaultRuntimeSettings().repo });
      for (const result of results) {
        const right = !(wrong[agent.id] ?? []).includes(result.questionId);
        store.gradeEval(run.id, result.questionId, { passed: right, found: right ? "Says it" : "Did not say it" });
      }
    }
  }
}

/** What happened before the demo opened: made with the real service, the runner and the stand-in model. */
async function seed({ service, state, store, caller, at, runNext, script, world, fixtures }) {
  const today = new Date();
  const morning = (hour, minute = 0) => { const date = new Date(today); date.setHours(hour, minute, 0, 0); if (date > today) date.setDate(date.getDate() - 1); return date; };
  const nightsAgo = (count) => { const date = morning(2, 40); date.setDate(date.getDate() - count); return date; };
  // Made five days ago, before quiet hours ended, so the Server Keeper's 05:30 digest falls due.
  at(new Date(morning(4, 0).getTime() - 5 * 86_400_000));
  service.saveModule(caller, { enabled: true });
  state.setSetting(agentsRuntimeKey, defaultRuntimeSettings(), { updatedBy: caller.id });
  service.noteRuntimeInstalled({ installed: true, version: `unsloth ${testedUnslothVersion}`, installerSha256: "5f0c".repeat(16) }, { actorId: caller.id });
  const keeper = service.createAgent(caller, { template: "server-keeper" });
  const pihole = service.createAgent(caller, { template: "pihole-watcher" });
  const auditor = service.createAgent(caller, { template: "backup-auditor" });
  const helper = service.createAgent(caller, { template: "it-support" });
  service.updateAgent(caller, keeper.id, { spec: { ...keeper.spec, budget: { ...keeper.spec.budget, runsPerDay: 20 } }, note: "Fewer runs a day" });
  service.addDocument(caller, { title: "How this network is laid out", text: "The router is at 192.168.50.1 and hands out homebox (192.168.50.20) as the DNS server, so Pi-hole answers for the whole house.\nThe media drive is the 4 TB USB disk at /mnt/media; the 2 TB one labelled Backup is for copies and sleeps most of the day.\nLeave Nextcloud's data alone on weekends: the family syncs photos then." });
  // The team chat (M38): Zulip was connected before these runs, so their outcomes were posted there.
  service.zulipConnected({
    connected: true, site: "https://homebox.tail0a1b.ts.net:8543", host: "homebox.tail0a1b.ts.net:8543", port: 8543, realm: "The house", realmId: 2,
    botEmail: "boxpilot-agents-bot@homebox.tail0a1b.ts.net", botCreated: true, credential: "zulip-agents-bot",
    channels: { findings: "agent-findings", logs: "agent-logs", knowledge: "agent-knowledge", files: "agent-files" }, made: ["agent-findings", "agent-logs", "agent-knowledge", "agent-files"], public: [],
  }, { actorId: caller.id, boxpilotUrl: "https://homebox.tail0a1b.ts.net" });

  // Five nights of evaluations (M40): the Server Keeper got which apps are stopped wrong on one.
  const inventory = fixtures.inventory();
  seedNights({
    service, store, caller, at, agents: [keeper, pihole, auditor, helper].map((agent) => service.getAgent(caller, agent.id)),
    facts: {
      hostname: inventory.host.hostname, operatingSystem: inventory.host.operatingSystem, installedApps: Object.keys(fixtures.apps).length, rootDiskPercent: inventory.storage.root.usedPercent,
      piholePlacement: "boxpilot-app", piholeBlocking: "on", drives: drivesOf(inventory), stoppedApps: [],
    },
    nights: [{ night: nightsAgo(4) }, { night: nightsAgo(3) }, { night: nightsAgo(2), wrong: { [keeper.id]: ["builtin-stopped"] } }, { night: nightsAgo(1) }, { night: nightsAgo(0) }],
  });

  if (world === "trouble") {
    at(new Date(Date.now() - hours(1)));
    service.startRun(caller, keeper.id, { kind: "ask", question: "Is anything failing?" });
    await runNext();
    service.pauseAgent(caller, pihole.id, {});
    // Asked since, with the runner stopped: it waits in the queue until someone starts it.
    at(new Date(Date.now() - 10 * 60_000));
    service.startRun(caller, keeper.id, { kind: "ask", question: "Why is Jellyfin restarting?" });
    return;
  }

  // The morning digest, in quiet hours.
  at(morning(5, 31));
  await service.tick();
  script((body) => {
    // Other agents whose schedules fell due in the night answer as the stand-in model does.
    if (!from(body, "Server Keeper")) return null;
    const tools = withTools(body);
    if (tools === 0) return { toolCalls: [call("server.facts"), call("alerts.active"), call("backups.status")] };
    if (tools === 3) return { toolCalls: [call("plan.propose", { title: "Back up Vaultwarden", reason: "Vaultwarden holds the household's passwords and has never been backed up.", steps: [{ operationId: "app.backup", parameters: { id: "vaultwarden" }, why: "No backup of Vaultwarden exists yet." }] })] };
    return { content: "Good morning. homebox ran quietly overnight: no health alerts are live [T2], and every key service is active [T1].\n\nOne thing needs you: Vaultwarden has never been backed up [T3]. A card proposes a backup; nothing runs until you approve it [T4].\n\nEverything else can wait." };
  });
  for (let index = 0; index < 6 && (await runNext()); index += 1) { /* everything that fell due in the night */ }

  // Questions during the morning, each read as the person who asked.
  at(new Date(Date.now() - hours(3)));
  script((body) => (withTools(body) === 0
    ? { toolCalls: [call("server.facts"), call("apps.list")] }
    : { content: "It is homebox, Ubuntu 24.04.3 LTS on an AMD Ryzen 5 5600G with 32 GB of memory [T1]. Eleven apps run in Docker, among them Jellyfin, Immich, Nextcloud, Vaultwarden and Pi-hole, all healthy [T2]." }));
  const told = service.startRun(caller, keeper.id, { kind: "ask", question: "What is this server, and what runs on it?" });
  await runNext();
  service.giveFeedback(caller, told.id, { verdict: "up" });

  at(new Date(Date.now() - hours(2)));
  script((body) => (withTools(body) === 0
    ? { toolCalls: [call("pihole.stats"), call("where.runs", { name: "pihole" })] }
    : withTools(body) === 2
      ? { toolCalls: [call("notes.write", { title: "Pi-hole's lists", body: "Gravity holds 182,340 domains and is refreshed daily; upstreams are Quad9 (9.9.9.9 and 149.112.112.112), about 20 ms each.", freshDays: 7 })] }
      : { content: "Pi-hole is blocking. In the last day it answered 48,210 queries and blocked 18.9% of them; its blocklists are a day old and both upstreams answer in about 20 ms [T1]. It runs as the BoxPilot app pi-hole, in the container bp-pi-hole [T2]." }));
  service.startRun(caller, pihole.id, { kind: "ask", question: "Is Pi-hole blocking, and are its lists fresh?" });
  await runNext();

  at(new Date(Date.now() - hours(1.5)));
  script((body) => {
    const tools = withTools(body);
    if (tools === 0) return { toolCalls: [call("backups.status")] };
    if (tools === 1) return { toolCalls: [call("plan.propose", { title: "Back up Nextcloud", reason: "Nextcloud keeps the family's files and has no backup yet; its last change was yesterday.", steps: [{ operationId: "app.backup", parameters: { id: "nextcloud" }, why: "Nextcloud has never been backed up." }] })] };
    return { content: "Three apps hold data and have never been backed up: Vaultwarden, Nextcloud and Homepage [T1]. Nextcloud matters most after Vaultwarden, which already has a card, so I proposed a backup for it [T2]. Database backups and their restore drills are current [T1]." };
  });
  service.startRun(caller, auditor.id, { kind: "manual", question: null });
  await runNext();

  at(new Date(Date.now() - hours(1)));
  script(null);
  const restore = service.startRun(caller, helper.id, { kind: "ask", question: "How do I restore an app from a backup?" });
  await runNext();
  service.giveFeedback(caller, restore.id, { verdict: "down", note: "It listed the apps; it should say to open the app and press Restore." });

  // A question too vague to answer: the IT helper asks back instead of guessing.
  at(new Date(Date.now() - hours(0.95)));
  script((body) => (understanding(body)
    ? { understanding: { goal: "Check a backup", subject: "backups", constraints: [], tools: [], confidence: 0.4, clarify: "Which backup do you mean: an app's own backup (which app?) or the copies BoxPilot sends to the backup disk?", plan: [] } }
    : null));
  service.startRun(caller, helper.id, { kind: "ask", question: "Can you check the backup?" });
  await runNext();

  // An answer the agent was not sure it understood: it answers, and a card asks the owner to look.
  at(new Date(Date.now() - hours(0.9)));
  script((body) => {
    if (understanding(body)) return { understanding: { goal: "Say whether Pi-hole makes the network slow", subject: "Pi-hole", constraints: [], tools: ["pihole_stats"], confidence: 0.35, clarify: null, plan: [{ step: "Read Pi-hole's reply times", tool: "pihole_stats" }, { step: "Answer", tool: null }] } };
    return withTools(body) === 0
      ? { toolCalls: [call("pihole.stats")] }
      : { content: "Pi-hole is not what is slow: both upstreams answer in about 20 ms, and it blocked 18.9% of yesterday's queries without errors [T1]. If one device or site is slow, say which." };
  });
  service.startRun(caller, pihole.id, { kind: "ask", question: "Is it slow?" });
  await runNext();

  // What the Server Keeper keeps between runs.
  at(new Date(Date.now() - hours(0.8)));
  script((body) => {
    const tools = withTools(body);
    if (tools === 0) return { toolCalls: [call("server.facts"), call("apps.list")] };
    if (tools === 2) return { toolCalls: [call("notes.write", { title: "The server", body: "homebox: Ubuntu 24.04.3 LTS, AMD Ryzen 5 5600G, 32 GB. System disk 800 GB, 27% full. Media on /mnt/media (4 TB USB).", freshDays: 14 })] };
    if (tools === 3) return { toolCalls: [call("notes.write", { title: "Where Pi-hole runs", body: "Pi-hole is the BoxPilot app pi-hole, container bp-pi-hole; the router hands homebox out as the DNS server.", freshDays: 30 })] };
    return { content: "Noted what this server is and where Pi-hole runs [T3] [T4]." };
  });
  service.startRun(caller, keeper.id, { kind: "manual", question: "Learn what is on this server and keep notes." });
  await runNext();

  // The Server Keeper's golden questions, scored against what BoxPilot reads from homebox.
  at(new Date(Date.now() - hours(0.5)));
  script(null);
  // Refused only when the demo opens within an hour of last night's evaluation: the tab shows that one.
  if (await service.runEvaluation(caller, keeper.id).catch(() => null)) {
    for (let index = 0; index < 16 && (await runNext()); index += 1) { /* each question in turn */ }
  }

  // One request, handed by the Server Keeper (the supervisor) to two specialists, then answered
  // from what they found: one trace tree on the one queue, as the person who asked.
  at(new Date(Date.now() - hours(0.25)));
  script((body) => {
    if (understanding(body)) {
      return from(body, "Server Keeper") && !continuing(body)
        ? { understanding: { goal: "Say whether the backups are current and Pi-hole is healthy", subject: "backups and Pi-hole", constraints: [], tools: ["agents_handoff"], confidence: 0.9, clarify: null, plan: [{ step: "Ask the Backup Auditor about the backups", tool: "agents_handoff" }, { step: "Ask the Pi-hole Watcher about Pi-hole", tool: "agents_handoff" }, { step: "Put their answers together", tool: null }] } }
        : null;
    }
    if (from(body, "Server Keeper")) {
      if (continuing(body)) return { content: "Not all backups are current: Vaultwarden, Nextcloud and Homepage have never been backed up, and cards already propose the first two [T1]. Pi-hole is healthy: blocking, its lists a day old, both upstreams answering in about 20 ms [T2]." };
      return withTools(body) === 0
        ? { toolCalls: [call("agents.handoff", { agent: "Backup Auditor", task: "Say which apps with data have no recent backup." }), call("agents.handoff", { agent: "Pi-hole Watcher", task: "Say whether Pi-hole is blocking and its lists are fresh." })] }
        : { content: "I asked the Backup Auditor and the Pi-hole Watcher [T1] [T2]; their answers come back to me, and I put them together." };
    }
    if (from(body, "Backup Auditor")) return withTools(body) === 0 ? { toolCalls: [call("backups.status")] } : { content: "Vaultwarden, Nextcloud and Homepage hold data and have never been backed up; database backups and their restore drills are current [T1]." };
    if (from(body, "Pi-hole Watcher")) return withTools(body) === 0 ? { toolCalls: [call("pihole.stats")] } : { content: "Blocking: 18.9% of 48,210 queries in the last day; lists a day old; upstreams about 20 ms [T1]." };
    return null;
  });
  service.startRun(caller, keeper.id, { kind: "ask", question: "Are the backups current, and is Pi-hole healthy?" });
  for (let index = 0; index < 5 && (await runNext()); index += 1) { /* the supervisor, both specialists, then its follow-up */ }

  // The daily look for a newer small Qwen.
  at(new Date());
  await service.checkForNewerModel();
  // What the runs left went to Zulip (in trouble, Zulip refused the key), and the note in
  // #agent-files came into Knowledge and was answered in its topic.
  if (world === "default") await service.chat.poll({ force: true });
  for (let batch = 0; batch < 6; batch += 1) { const sent = await service.chat.drain().catch(() => null); if (!sent?.sent) break; }
}

/**
 * The Agents routes for the demo: one world per scenario, built on first use. `handle` answers any
 * /agents or /settings/agents request from the world the page is in.
 */
export function createAgentsDemo({ inventory, apps, services, scenarioOf }) {
  const worlds = new Map();
  const worldFor = (name) => {
    if (!worlds.has(name)) {
      const fixtures = { inventory: () => (name === "trouble" ? { ...inventory(), storage: { ...inventory().storage, root: { ...inventory().storage.root, usedPercent: 91 } } } : inventory()), apps: name === "fresh" ? {} : apps, services: services[name] ?? services.default };
      worlds.set(name, buildWorld(name, fixtures));
    }
    return worlds.get(name);
  };
  const router = Router();
  router.use(async (request, response, next) => {
    // Only the Agents routes: every other demo route passes by without building anything.
    if (!/^\/(agents|settings\/agents)(\/|$)/.test(request.path)) { next(); return; }
    try {
      const world = await worldFor(scenarioOf(request.get("referer")));
      world.handle(request, response, next);
    } catch (error) {
      response.status(503).json({ error: `The demo's agents could not start: ${error.message}`, code: "demo_agents" });
    }
  });
  return {
    handle: router,
    close: async () => { await Promise.all([...worlds.values()].map(async (pending) => (await pending.catch(() => null))?.close())); worlds.clear(); },
  };
}
