/**
 * Runs on Claude (M45.3), in the web process: which model a run starts on and may move to, the
 * house's names its stand-ins hide, and each model call of a run on Claude made through the
 * gateway, redacted and turned back. Part of the agents service (service.mjs), which hands it what
 * it uses.
 */
import { createStandIns, hideRequest, showResult } from "../../packages/harness/src/safety/stand-ins.mjs";
import { routerDefaults, startRoute } from "../../packages/harness/src/router.mjs";
import { zulipSettingKey } from "./chat.mjs";

/**
 * @param {{
 *   state: any, store: any, cloud: any, houseNamesFor: () => any,
 *   redact: (text: string) => string, clip: (text: unknown, max: number) => string,
 *   refuse: (status: number, message: string, code?: string) => never,
 *   emit: (runId: string, event: string, data: any) => void,
 *   runtimeClaim: (spec: any, cpuInfo?: any) => any, runtimeSettings: () => any,
 *   heldRun: (runId: string, lease: string) => any,
 * }} deps
 */
export function createCloudRuns({ state, store, cloud, houseNamesFor, redact, clip, refuse, emit, runtimeClaim, runtimeSettings, heldRun }) {
  /** Runs given Claude, while they run: the model, how hard it thinks, the data policy, the stand-ins and the spend. */
  const cloudRuns = new Map();
  /** The public host names tunnel.exposure has read (M48.3): kept so the stand-ins hide them too. */
  const knownDomainsKey = "agentsKnownDomains";
  const lowEffortKinds = new Set(["schedule", "event", "webhook", "eval", "learn"]);
  /** What a plan's run on Claude may spend in tokens, all its calls together (M45.6): Claude paces itself to it. */
  const planTaskBudget = 40_000;
  const cents = (value) => Math.round(Number(value) * 1_000_000) / 1_000_000;

  /**
   * The house's names for the stand-ins (M48.3): this server's and its accounts' (houseNamesFor), and
   * its public names too - the tunnel's hostnames, recorded whenever tunnel.exposure reads them
   * (the tunnel's state file is root's), and the Zulip site - each with its registrable domain, so
   * "photos.smithfamily.net" and "smithfamily.net" leave as stand-ins like the host name does.
   */
  function houseNamesAll() {
    const base = houseNamesFor();
    const known = state.getSetting?.(knownDomainsKey, null);
    const zulip = state.getSetting?.(zulipSettingKey, null);
    const siteHost = (() => { try { return zulip?.site ? new URL(String(zulip.site)).hostname : null; } catch { return null; } })();
    const domains = new Set(base.domains ?? []);
    for (const host of [...(Array.isArray(known?.hosts) ? known.hosts : []), zulip?.host ?? null, siteHost]) {
      const name = String(host ?? "").toLowerCase().replace(/\.$/, "");
      if (!name || !name.includes(".")) continue;
      domains.add(name);
      const labels = name.split(".");
      if (labels.length > 2) domains.add(labels.slice(-2).join("."));
    }
    return { ...base, domains: [...domains] };
  }

  /**
   * The model a run starts on, and the one it may change to (M45.3, M45.4). Claude when its agent
   * says so (or the run is a second opinion), Claude is connected with the month not spent, and the
   * asker may send their words to it; the local model otherwise, with a step saying why. An auto
   * agent starts on the local model with Claude held ready: the runner moves when the plan says to,
   * and what the run reads is held to Claude's rules from the start. A run on Claude names the local
   * model too, to go on with if Claude stops answering.
   */
  function claimedModel(spec, run, cpuInfo) {
    const route = spec?.model?.route ?? "local";
    const secondOpinionOf = run.trigger?.secondOpinionOf ?? null;
    const local = runtimeClaim(spec, cpuInfo);
    // An evaluation held to one route (M45.7): the local side never reaches Claude, the Claude side always tries.
    const evalRoute = run.kind === "eval" ? run.trigger?.route ?? null : null;
    if (evalRoute === "local" || (route === "local" && !secondOpinionOf && evalRoute !== "claude")) return { runtime: local, router: null };
    const said = (text) => {
      const step = store.addStep(run.id, { kind: "system", name: "model", output: text });
      if (step) emit(run.id, "step", step);
    };
    // A plan's check and report (M45.6) run on Claude for an auto agent: a long plan is where the local model is weakest.
    const planRunOnClaude = route === "auto" && Boolean(run.trigger?.plan?.id);
    const start = startRoute({ route: route === "claude" ? "remote" : route, remote: claudeAllowed(spec, run), secondOpinion: Boolean(secondOpinionOf) || planRunOnClaude || evalRoute === "claude" });
    if (start.start === "local" && !start.mayMove) {
      // An auto agent says nothing while Claude is not connected: until then it is a local agent.
      if (route === "claude" || secondOpinionOf || evalRoute === "claude" || cloud?.settings().connected) said(`${start.reason}: this run uses the local model.`);
      return { runtime: local, router: null };
    }
    for (const [runId] of cloudRuns) if (store.getRun(runId)?.state !== "running") cloudRuns.delete(runId);
    const chosen = cloud.settings();
    const effort = lowEffortKinds.has(run.kind) ? "low" : "medium";
    const dataPolicy = spec.model.dataPolicy === "as-is" ? "as-is" : "redacted";
    const mode = start.start === "remote" ? "claude" : "auto";
    cloudRuns.set(run.id, { mode, model: chosen.model, effort, dataPolicy, standIns: createStandIns(houseNamesAll()), costUsd: 0, calls: 0, reason: null, ...(run.trigger?.plan?.id ? { taskBudget: planTaskBudget } : {}) });
    const names = dataPolicy === "redacted" ? "Names that identify this house leave it as stand-ins; the answer is turned back here." : "What it reads leaves this server as it is, without secrets.";
    const documents = spec.model.claudeReadsDocuments === true ? " Your documents may be read and sent." : " Your documents stay on this server.";
    said(mode === "claude"
      ? `${secondOpinionOf ? "A second opinion: " : ""}On ${chosen.model} through the model gateway, thinking at ${effort} effort. ${names}${documents}`
      : `On the local model, with ${chosen.model} ready if the plan needs it. ${names}${documents}`);
    const claude = {
      driver: "claude", model: chosen.model, effort, dataPolicy, cpu: null, threads: null, extra: {}, embeddings: false, temperature: null,
      maxTokens: runtimeSettings().maxTokens,
      // What the runner works out a call's time from: Claude reads far faster than this server's model.
      speed: { promptPerSecond: 5_000, generatePerSecond: 50 },
    };
    return mode === "claude" ? { runtime: claude, router: { mode, local, claude } } : { runtime: local, router: { mode, local, claude, ...routerDefaults } };
  }

  /** Whether Claude may take this run now: set up, connected with the month not spent, and allowed for whoever asked. */
  function claudeAllowed(spec, run) {
    if (!cloud) return { ok: false, reason: "Claude is not set up on this server" };
    if (run.readRole === "viewer" && !spec?.model?.claudeForViewers) return { ok: false, reason: "A viewer asked, and this agent does not send a viewer's words to Claude" };
    return cloud.usable();
  }

  const roles = new Set(["system", "user", "assistant", "tool"]);
  /** A runner's model request, held to what one may be: the conversation, its tools, and how it may answer. */
  function readModelRequest(body) {
    const request = body?.request;
    if (!request || typeof request !== "object" || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 400) refuse(400, "A model request carries its messages", "bad_request");
    if (request.messages.some((message) => !roles.has(message?.role))) refuse(400, "A message has no known role", "bad_request");
    const tools = Array.isArray(request.tools) ? request.tools.slice(0, 64) : [];
    const format = request.extra?.response_format?.type === "json_schema" ? request.extra.response_format : null;
    return {
      messages: request.messages,
      tools,
      toolChoice: request.toolChoice === "none" ? "none" : "auto",
      maxTokens: Math.max(64, Math.min(64_000, Math.round(Number(request.maxTokens) || 1024))),
      ...(format ? { extra: { response_format: format } } : {}),
    };
  }

  /**
   * One model call of a run on Claude (POST /agent-runner/runs/:id/model): the asker's words
   * redacted, names replaced with stand-ins when the agent's data policy says so, the cap checked,
   * the call made through the gateway, and the answer turned back before the runner reads it.
   */
  async function runnerModel(runId, lease, body = {}) {
    heldRun(runId, lease);
    const cloudRun = cloudRuns.get(runId);
    if (!cloudRun || !cloud) refuse(409, "This run was not given Claude", "not_cloud");
    const request = readModelRequest(body);
    // The person's own words may hold a secret they typed; everything else was redacted where BoxPilot wrote or read it.
    const messages = request.messages.map((message) => (message.role === "user" && typeof message.content === "string" ? { ...message, content: redact(message.content) } : message));
    const outgoing = { ...request, model: cloudRun.model, effort: cloudRun.effort, messages, ...(cloudRun.taskBudget ? { taskBudget: cloudRun.taskBudget } : {}) };
    const sent = cloudRun.dataPolicy === "redacted" ? hideRequest(outgoing, cloudRun.standIns) : outgoing;
    let result;
    try {
      result = await cloud.chat(sent, { timeoutMs: Math.max(5_000, Math.min(10 * 60_000, Number(body?.timeoutMs) || 3 * 60_000)) });
    } catch (error) {
      refuse(502, clip(String(error?.message ?? error), 300), `model_${String(error?.code ?? "error").replace(/[^a-z-]/g, "")}`);
    }
    cloudRun.costUsd = cents(cloudRun.costUsd + (Number(result?.costUsd) || 0));
    cloudRun.calls += 1;
    // Why an auto run moved to Claude (M45.4), as the runner said it with its first call there.
    if (!cloudRun.reason && typeof body?.reason === "string" && body.reason.trim()) cloudRun.reason = clip(redact(body.reason), 200);
    return cloudRun.dataPolicy === "redacted" ? showResult(result, cloudRun.standIns) : result;
  }

  return { cloudRuns, houseNamesAll, claimedModel, claudeAllowed, runnerModel };
}
