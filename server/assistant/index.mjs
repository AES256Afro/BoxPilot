/**
 * The local assistant's core (M34.1, M34.2): a question in, an answer grounded in BoxPilot's own
 * documents, registry and catalog and in this server's facts, with the sources it used and, when a
 * fix is wanted, a plan of registered operations checked against the registry. It never runs
 * anything; a plan's steps go through the ordinary job path, approved one by one at their tier.
 *
 * Guardrails, in the order they apply:
 * - Only a local model (ollama.mjs): an address on this server or the owner's network, set by the
 *   owner, or the catalog's Ollama when it is installed. With none, the answer is the sources.
 * - The context is read as the person asking (facts.mjs), secrets masked by secretPaths, then every
 *   piece of text passes the redactor once more on its way into the prompt (prompt.mjs).
 * - Bounded: the question, the prompt, the answer and the time taken each have a limit, and one
 *   answer is written at a time per account.
 * - The audit trail records who asked, when, how many sources and how long it took; never the
 *   question or the answer, which may hold private details.
 */
import { createStreamBudget } from "../event-stream.mjs";
import { createRedactor, loadRedactionPolicy } from "../redaction.mjs";
import { seesEveryAccount } from "../routes/access.mjs";
import { asRequest, gatherFacts } from "./facts.mjs";
import { createKnowledgeIndex, tokenize } from "./knowledge.mjs";
import { createOllamaClient, isEmbeddingModel, normalizeEndpoint, ollamaApiPort } from "./ollama.mjs";
import { extractPlan, planFence, validatePlan } from "./plan.mjs";
import { buildPrompt, degradedMessages, fallbackAnswer, finalRedaction, verifyCitations } from "./prompt.mjs";

export const assistantSettingKey = "assistant";

export const defaultLimits = Object.freeze({
  questionChars: 2_000,
  promptChars: 24_000,
  sourceChars: 1_500,
  answerChars: 12_000,
  numPredict: 1_024,
  numCtx: 8_192,
  temperature: 0.2,
  timeoutMs: 120_000,
  tagsTimeoutMs: 3_000,
  embedTimeoutMs: 15_000,
  retrieve: 6,
  operations: 3,
  failedJobs: 3,
  logLines: 20,
  focusLogLines: 40,
  alerts: 15,
  perAccount: 1,
  total: 4,
});

// When no model is chosen, the first of these the server has; they follow a system prompt well.
const preferredChatModels = ["hermes3", "qwen3", "llama3.2", "llama3.1", "qwen2.5", "mistral", "gemma3", "phi4"];
const modelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const appIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const statusMessages = Object.freeze({
  "no-model": "No local model is set up. Install Ollama from the catalog and pull a model, or give the address of one on your network in Settings.",
  "unreachable": "The model server did not answer at its address.",
  "model-missing": "The chosen model is not on the model server. Pull it there, or choose another in Settings.",
});

export class AssistantError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

/** The owner's choices as they are stored; throws an AssistantError (400) on anything else. */
export function normalizeAssistantSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssistantError(400, "Send the model server's address and the model names", "invalid_setting");
  const unset = (value) => value === undefined || value === null || (typeof value === "string" && !value.trim());
  let endpoint = null;
  if (!unset(input.endpoint)) {
    try { endpoint = normalizeEndpoint(input.endpoint); } catch (error) { throw new AssistantError(400, error.message, "invalid_setting"); }
  }
  const name = (value, what) => {
    if (unset(value)) return null;
    if (typeof value !== "string" || !modelNamePattern.test(value.trim())) throw new AssistantError(400, `${what} must be a model name such as hermes3:8b`, "invalid_setting");
    return value.trim();
  };
  return { endpoint, model: name(input.model, "The model"), embedModel: name(input.embedModel, "The embedding model") };
}

/** The question and its focus, checked; throws an AssistantError (400) on anything else. */
export function readQuestion(body, { questionChars = defaultLimits.questionChars } = {}) {
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) throw new AssistantError(400, "Ask a question", "invalid_question");
  if (question.length > questionChars) throw new AssistantError(400, `Keep the question under ${questionChars} characters`, "question_too_long");
  const raw = body?.context ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AssistantError(400, "context must be an object", "invalid_question");
  const extra = Object.keys(raw).filter((key) => !["jobId", "alertKey", "appId"].includes(key));
  if (extra.length) throw new AssistantError(400, "context may hold only jobId, alertKey and appId", "invalid_question");
  const context = {};
  if (raw.jobId !== undefined && raw.jobId !== null) {
    if (typeof raw.jobId !== "string" || !uuidPattern.test(raw.jobId)) throw new AssistantError(400, "jobId must be a job's id", "invalid_question");
    context.jobId = raw.jobId;
  }
  if (raw.alertKey !== undefined && raw.alertKey !== null) {
    if (typeof raw.alertKey !== "string" || !raw.alertKey || raw.alertKey.length > 300 || /[\u0000-\u001f\u007f]/.test(raw.alertKey)) throw new AssistantError(400, "alertKey must be a health alert's key", "invalid_question");
    context.alertKey = raw.alertKey;
  }
  if (raw.appId !== undefined && raw.appId !== null) {
    if (typeof raw.appId !== "string" || !appIdPattern.test(raw.appId)) throw new AssistantError(400, "appId must be a catalog app's id", "invalid_question");
    context.appId = raw.appId;
  }
  return { question, context };
}

/**
 * Hide a plan block while it streams: text is sent as it arrives up to the block's opening fence,
 * holding back a tail that could still turn into one. The finished answer, without the block, is
 * in the final result either way.
 */
export function createPlanFilter(emit) {
  const marker = "```plan";
  let sent = 0;
  return (full) => {
    const start = full.search(planFence);
    let visible = start >= 0 ? full.slice(0, start) : full;
    if (start < 0) {
      for (let size = Math.min(marker.length - 1, visible.length); size > 0; size -= 1) {
        if (marker.startsWith(visible.slice(-size).toLowerCase())) { visible = visible.slice(0, -size); break; }
      }
    }
    if (visible.length > sent) { emit(visible.slice(sent)); sent = visible.length; }
  };
}

const excerptOf = (text) => {
  const value = String(text ?? "").trim();
  return value.length > 300 ? `${value.slice(0, 299)}…` : value;
};
const operationOf = (job) => (typeof job?.type === "string" && job.type.startsWith("op:") ? job.type.slice(3) : null);
// nomic-embed-text is trained with these task prefixes and ranks noticeably better with them.
const documentText = (model, chunk) => `${/^nomic-embed/i.test(model) ? "search_document: " : ""}${chunk.title}\n${chunk.text}`;
const queryText = (model, text) => `${/^nomic-embed/i.test(model) ? "search_query: " : ""}${text}`;

export function createAssistantService({
  state,
  registry,
  catalog = null,
  helper = null,
  inventory = null,
  secretEnvNamesFor = null,
  ollama = createOllamaClient(),
  knowledge = null,
  redactor = null,
  loadRedaction = loadRedactionPolicy,
  generations = null,
  limits: overrides = {},
  now = () => new Date(),
  recordAudit = null,
} = {}) {
  const limits = { ...defaultLimits, ...overrides };
  const index = knowledge ?? createKnowledgeIndex({ registry, catalog, now });
  // One answer at a time per account, a few across the server: a CPU model serves one well.
  const budget = generations ?? createStreamBudget({ perAccount: limits.perAccount, total: limits.total });
  const audit = recordAudit ?? ((type, entry) => state.recordAudit?.(type, entry));
  let redactorReady = redactor ? Promise.resolve(redactor) : null;
  const redactorFor = () => (redactorReady ??= Promise.resolve().then(() => loadRedaction()).then((policy) => createRedactor(policy), () => createRedactor()));

  function settings() {
    const saved = state.getSetting?.(assistantSettingKey, null) ?? {};
    return { endpoint: saved.endpoint ?? null, model: saved.model ?? null, embedModel: saved.embedModel ?? null };
  }

  // app.inspect answers both "where is the catalog's Ollama" and "what state are the apps in".
  let appsRead = null;
  function readApps() {
    if (!helper) return Promise.resolve(null);
    const at = now().getTime();
    if (appsRead && at - appsRead.at < 15_000) return appsRead.promise;
    const promise = helper.request("app.inspect", {}, { timeoutMs: 20_000 });
    appsRead = { at, promise };
    promise.catch(() => { if (appsRead?.promise === promise) appsRead = null; });
    return promise;
  }

  /** The owner's address, else the catalog's own model server when it is installed, else none. */
  async function resolveEndpoint() {
    const saved = settings();
    if (saved.endpoint) return { endpoint: saved.endpoint, source: "setting" };
    const apps = await readApps().catch(() => null);
    const installed = (Array.isArray(apps?.applications) ? apps.applications : []).filter((entry) => entry?.installed);
    installed.sort((a, b) => Number(b.id === "ollama") - Number(a.id === "ollama"));
    for (const entry of installed) {
      // Only while its container is up: a stopped model server's port is free for anything else to
      // take, and the prompt - the owner's is every account's work - would go to whatever did.
      if (entry.container?.running !== true) continue;
      const manifest = catalog ? await catalog.get(entry.id).catch(() => null) : null;
      // An app that runs its own models and publishes Ollama's API port (the catalog's Ollama).
      if (!manifest?.modelRunner || manifest.modelRunner.service !== manifest.id) continue;
      const port = (manifest.ports ?? []).find((candidate) => Number(candidate.container) === ollamaApiPort);
      if (!port) continue;
      const hostNetworked = (entry.state?.values?.networkMode ?? manifest.network) === "host";
      const published = Number(hostNetworked ? port.container : entry.state?.values?.ports?.[port.id] ?? port.host);
      if (Number.isInteger(published) && published > 0 && published < 65536) return { endpoint: `http://127.0.0.1:${published}`, source: "catalog", appId: entry.id };
    }
    return { endpoint: null, source: "none" };
  }

  let modelRead = null;
  async function probeModels() {
    const saved = settings();
    const { endpoint, source } = await resolveEndpoint();
    const none = { endpoint, source, reachable: false, models: [], chatModel: null, embedModel: null };
    if (!endpoint) return { ...none, problem: "no-model" };
    let models;
    try {
      models = await ollama.tags(endpoint, { timeoutMs: limits.tagsTimeoutMs });
    } catch {
      return { ...none, problem: "unreachable" };
    }
    const names = models.map((model) => model.name);
    const present = (wanted) => names.find((name) => name === wanted || name === `${wanted}:latest`) ?? null;
    const chatNames = names.filter((name) => !isEmbeddingModel(name));
    const chatModel = saved.model ? present(saved.model) : preferredChatModels.map((prefix) => chatNames.find((name) => name.startsWith(prefix))).find(Boolean) ?? chatNames[0] ?? null;
    const embedModel = saved.embedModel ? present(saved.embedModel) : names.find(isEmbeddingModel) ?? null;
    return { endpoint, source, reachable: true, models: names, chatModel, embedModel, problem: chatModel ? null : saved.model ? "model-missing" : "no-model" };
  }
  async function modelState({ fresh = false } = {}) {
    const at = now().getTime();
    if (!fresh && modelRead && at - modelRead.at < 30_000) return modelRead.value;
    const value = await probeModels();
    modelRead = { at, value };
    return value;
  }

  // The whole index is embedded once per model, in the background, a batch at a time and only
  // while nobody is waiting for an answer: with the catalog's default of one loaded model, every
  // switch between the embedding model and the chat model costs a reload. An answer that starts
  // stops it after the batch in hand; the next answer to finish, or the next status read, resumes it.
  let warming = null;
  let resumeWarming = null;
  function warmEmbeddings(endpoint, model) {
    if (warming || !endpoint || !model) return;
    warming = (async () => {
      for (let round = 0; round < 500; round += 1) {
        if (budget.stats().active > 0) break;
        const batch = index.missingEmbeddings(model, { limit: 16 });
        if (!batch.length) break;
        const vectors = await ollama.embed(endpoint, model, batch.map((chunk) => documentText(model, chunk)), { timeoutMs: 60_000 });
        batch.forEach((chunk, position) => index.embeddings.set(model, chunk.hash, vectors[position]));
      }
    })().catch(() => {}).finally(() => { warming = null; });
  }

  /** The question's vector, embedding the best keyword matches alongside it if they are not cached yet. */
  async function embedQuestion(model, query, signal) {
    const missing = index.missingEmbeddings(model.embedModel, { question: query, limit: 16 });
    const vectors = await ollama.embed(model.endpoint, model.embedModel, [queryText(model.embedModel, query), ...missing.map((chunk) => documentText(model.embedModel, chunk))], { timeoutMs: limits.embedTimeoutMs, signal });
    missing.forEach((chunk, position) => index.embeddings.set(model.embedModel, chunk.hash, vectors[position + 1]));
    return vectors[0];
  }

  async function answer(caller, { question, context }, focusJob, { onEvent, signal }) {
    const started = now().getTime();
    const role = ["owner", "operator", "viewer"].includes(caller.role) ? caller.role : "viewer";
    const mayPlan = role === "owner" || role === "operator";
    const [facts, model] = await Promise.all([
      gatherFacts({ caller, context, focusJob, state, registry, helper, inventory, catalog, secretEnvNamesFor, readApps, limits }),
      modelState(),
      index.ensure(),
    ]);

    // What BoxPilot knows that bears on the question: the best matches, the operations that could
    // fix it (for someone who could approve them), and whatever the question is focused on.
    const query = [question, focusJob?.title, context.appId, context.alertKey].filter(Boolean).join(" ");
    const redactor = await redactorFor();
    let vector = null;
    if (model.embedModel) {
      // The embedding goes to the model server as surely as the prompt does, so it is redacted too.
      vector = await embedQuestion(model, finalRedaction(query, redactor), signal).catch(() => null);
      resumeWarming = { endpoint: model.endpoint, model: model.embedModel };
    }
    const search = (options) => index.search(query, { ...options, vector, model: model.embedModel });
    const pinned = [operationOf(focusJob) ? index.get(`op:${operationOf(focusJob)}`) : null, context.appId ? index.get(`app:${context.appId}`) : null].filter(Boolean);
    const hits = [...search({ limit: limits.retrieve }), ...(mayPlan ? search({ limit: limits.operations, kinds: ["operation"] }) : [])].map((hit) => hit.chunk);
    const knowledge = [...new Map([...pinned, ...hits].map((chunk) => [chunk.id, chunk])).values()]
      .map((chunk) => ({ key: chunk.id, kind: chunk.kind, title: chunk.title, ref: chunk.ref, text: chunk.text }));
    // Facts most like the question first among the rest, so a prompt that runs out of room drops
    // the least relevant ones.
    const words = new Set(tokenize(question));
    const overlap = (source) => tokenize(`${source.title} ${source.text}`).filter((token) => words.has(token)).length;
    const background = facts.sources.filter((source) => !source.focus).map((source, position) => ({ source, position, score: overlap(source) }))
      .sort((a, b) => b.score - a.score || a.position - b.position).map((entry) => entry.source);
    const ordered = [...facts.sources.filter((source) => source.focus), ...knowledge.slice(0, 3), ...background, ...knowledge.slice(3)];

    const prompt = buildPrompt({ question, sources: ordered, role, notes: facts.notes, now: now(), promptChars: limits.promptChars, redactor });
    const sources = prompt.sources.map(({ id, kind, title, ref, text }) => ({ id, kind, title, ref, excerpt: excerptOf(text) }));
    onEvent("sources", { sources, model: model.chatModel });

    let text = "";
    let degraded = model.chatModel ? null : model.problem ?? "no-model";
    let outcome = "answered";
    let truncated = false;
    if (!degraded) {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error("timeout")), limits.timeoutMs);
      timer.unref?.();
      const filter = createPlanFilter((piece) => onEvent("delta", { text: piece }));
      try {
        const finished = await ollama.chat(model.endpoint, {
          model: model.chatModel,
          messages: prompt.messages,
          options: { temperature: limits.temperature, num_predict: limits.numPredict, num_ctx: limits.numCtx },
        }, {
          signal: signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal,
          timeoutMs: limits.timeoutMs + 5_000,
          onDelta: (piece) => {
            text += piece.slice(0, Math.max(0, limits.answerChars - text.length));
            filter(text);
            if (text.length >= limits.answerChars) { truncated = true; return false; }
            return true;
          },
        });
        if (!finished.done && !finished.stopped) truncated = true;
      } catch (error) {
        if (signal?.aborted) outcome = "cancelled";
        else if (deadline.signal.aborted) degraded = "timeout";
        else degraded = error?.code === "model_missing" ? "model-missing" : "model-error";
      } finally {
        clearTimeout(timer);
      }
    }

    const extracted = extractPlan(text);
    let answerText = extracted.answer;
    if (degraded && !answerText) answerText = fallbackAnswer({ reason: degraded, sources: prompt.sources });
    else if (degraded === "timeout") answerText = `${answerText}\n\n(The model took too long, so the answer stops here.)`;
    else if (degraded) answerText = `${answerText}\n\n(The model stopped with an error, so the answer stops here.)`;
    else if (truncated) answerText = `${answerText}\n\n(The answer was cut off at its size limit.)`;
    if (degraded && degraded !== "timeout") outcome = "degraded";
    if (degraded === "timeout") outcome = "timeout";

    let plan = null;
    if (mayPlan) {
      plan = await validatePlan(extracted.steps ?? [], { registry, role, secretEnvNamesFor });
      if (extracted.problem) plan.dropped.push({ index: null, operationId: null, reason: extracted.problem });
    }
    const citations = verifyCitations(answerText, prompt.sources);
    const cited = new Set(citations.cited);
    const result = {
      answer: answerText,
      sources: sources.map((source) => ({ ...source, cited: cited.has(source.id) })),
      plan,
      model: model.chatModel,
      degraded: degraded ? { reason: degraded, message: degradedMessages[degraded] ?? degradedMessages["model-error"] } : null,
      citations: { unknown: citations.unknown, uncited: citations.uncited },
      notes: facts.notes,
    };
    audit("assistant.asked", {
      actorId: caller.id,
      details: {
        role,
        outcome,
        model: model.chatModel,
        sources: prompt.sources.length,
        cited: citations.cited.length,
        unknownCitations: citations.unknown.length,
        uncitedClaims: citations.uncited.length,
        planSteps: plan?.steps.length ?? 0,
        droppedSteps: plan?.dropped.length ?? 0,
        promptCharacters: prompt.characters,
        answerCharacters: answerText.length,
        focus: { job: Boolean(context.jobId), alert: Boolean(context.alertKey), app: Boolean(context.appId) },
        durationMs: Math.max(0, now().getTime() - started),
      },
    });
    return { ...result, outcome };
  }

  /**
   * Check a question and claim this account's one answer slot. Throws an AssistantError (400, 404,
   * 429) before anything is read or sent; the returned `run` writes the answer and gives the slot
   * back however it ends, and `cancel` gives it back when `run` will not be called.
   */
  function begin(caller, body) {
    if (!caller?.id) throw new AssistantError(401, "Sign in to ask", "unauthorized");
    const input = readQuestion(body, limits);
    let focusJob = null;
    if (input.context.jobId) {
      const job = state.getJob?.(input.context.jobId) ?? null;
      // Another account's job is the owner's to see, exactly as GET /jobs/:id answers.
      if (!job || !(seesEveryAccount(asRequest(caller)) || job.createdBy === caller.id)) throw new AssistantError(404, "Job not found", "job_not_found");
      focusJob = job;
    }
    const release = budget.acquire(caller.id);
    if (!release) throw new AssistantError(429, "An answer is already being written for you. Wait for it to finish, then ask again.", "assistant_busy");
    return {
      run: async ({ onEvent = () => {}, signal = null } = {}) => {
        try {
          return await answer(caller, input, focusJob, { onEvent, signal });
        } finally {
          release();
          if (resumeWarming && budget.stats().active === 0) warmEmbeddings(resumeWarming.endpoint, resumeWarming.model);
        }
      },
      cancel: release,
    };
  }

  async function ask(caller, body, options = {}) {
    return begin(caller, body).run(options);
  }

  async function status(caller) {
    const role = caller?.role;
    const [stats, model] = await Promise.all([
      index.ensure().catch(() => index.stats()),
      modelState({ fresh: true }),
    ]);
    if (model.embedModel) warmEmbeddings(model.endpoint, model.embedModel);
    const operatorView = role === "owner" || role === "operator";
    return {
      ready: Boolean(model.chatModel),
      reachable: model.reachable,
      problem: model.problem ? { reason: model.problem, message: statusMessages[model.problem] } : null,
      source: model.source,
      chatModel: model.chatModel,
      embeddings: Boolean(model.embedModel),
      // Which models the server holds, and where it is, like app.models.inspect: an operator's to read (M29.6).
      ...(operatorView ? { endpoint: model.endpoint, embedModel: model.embedModel, models: model.models } : {}),
      ...(role === "owner" ? { settings: settings() } : {}),
      index: { ...stats, embedded: model.embedModel ? index.embeddings.count(model.embedModel) : 0 },
      limits: { questionChars: limits.questionChars, timeoutMs: limits.timeoutMs, perAccount: limits.perAccount },
    };
  }

  function saveSettings(input, { actorId = null } = {}) {
    const value = normalizeAssistantSettings(input);
    state.setSetting(assistantSettingKey, value, { updatedBy: actorId });
    modelRead = null;
    audit("settings.assistant.changed", { actorId, subjectId: actorId, details: { endpoint: value.endpoint, model: value.model, embedModel: value.embedModel } });
    return value;
  }

  /** Build the index now, at startup, rather than on the first question. */
  function warm() {
    return index.ensure().catch(() => null);
  }

  /** Settles when background embedding has stopped (tests wait on it before looking at requests). */
  const whenIdle = () => warming ?? Promise.resolve();

  return { begin, ask, status, settings, saveSettings, warm, whenIdle, index };
}
