/**
 * The agents' library, in the web process: the owner's documents (pasted, uploaded, a folder,
 * connectors), the knowledge sources' switches, and the background runs that serve meaning search -
 * the memory index's embeddings and the image describer's words for #agent-files (M38, M40.6) -
 * queued in quiet hours, claimed by the runner and finished here. Part of the agents service
 * (service.mjs), which hands it what it uses.
 */
import { createHash } from "node:crypto";
import { boxLine, sanitizeUntrusted } from "../../packages/harness/src/index.mjs";
import { quietHoursStart } from "./budget.mjs";
import { ConnectorError, boundSync, cleanDocumentText, connectors, textOfUpload } from "./connectors.mjs";
import { encodeVector, readVector } from "./memory.mjs";

/**
 * @param {{
 *   store: any, state: any, limits: Record<string, number>, now: () => Date,
 *   audit: (type: string, entry: object) => void, redact: (text: string) => string,
 *   clip: (text: unknown, max: number) => string, finite: (value: unknown, max: number) => number,
 *   inTime: (read: () => any, ms: number, error: Error) => Promise<any>,
 *   refuse: (status: number, message: string, code?: string) => never, wake: () => void,
 *   personOf: (caller: any) => { id: string, role: string },
 *   agentFor: (caller: any, id: string, options?: { edit?: boolean }) => any,
 *   canEdit: (caller: any, agent: any) => boolean,
 *   ownActor: (caller: any, id: string | null) => string | null, knowledge: any,
 *   folderScan: (folder: string) => Promise<any>, moduleSettings: () => any,
 *   modulePaused: (settings?: any) => boolean, runtimeSettings: () => any,
 *   knowledgeSettings: () => Record<string, boolean>, moduleBudget: () => any, embedModelName: () => string,
 *   heldRun: (runId: string, lease: string) => any, runtimeClaim: (spec: any, cpuInfo?: any) => any,
 *   runEnded: (run: any, options?: { tree?: boolean }) => void, visionNow: () => any,
 *   presentModule: (person: any) => any, enqueueSystem: (agent: any, kind: string, trigger?: object) => any,
 *   agentsKnowledgeKey: string, visionKey: string, describePrompt: string, memoryIndexAgentId: string,
 *   imageDescribeAgentId: string,
 * }} deps
 */
export function createAgentLibrary({ store, state, limits, now, audit, redact, clip, finite, inTime, refuse, wake, personOf, agentFor, canEdit, ownActor, knowledge, folderScan, moduleSettings, modulePaused, runtimeSettings, knowledgeSettings, moduleBudget, embedModelName, heldRun, runtimeClaim, runEnded, visionNow, presentModule, enqueueSystem, agentsKnowledgeKey, visionKey, describePrompt, memoryIndexAgentId, imageDescribeAgentId }) {
  /** A document in the pieces it is embedded as: at most 1,200 characters, twenty pieces. */
  function chunksOf(document) {
    const pieces = [];
    for (let at = 0; at < document.text.length && pieces.length < 20; at += limits.docChunkChars) pieces.push(document.text.slice(at, at + limits.docChunkChars));
    return pieces;
  }

  /** The claim for an index run: the texts whose embeddings are missing or out of date. */
  function indexPayload(run, lease, { cpu: cpuInfo = null } = {}) {
    const items = pendingEmbeddings().slice(0, limits.indexBatch);
    return {
      run: { id: run.id, kind: "index", question: null, trigger: run.trigger, readRole: run.readRole, startedAt: run.startedAt, deadlineAt: new Date(Date.parse(run.startedAt) + 600_000).toISOString() },
      lease, agent: { id: memoryIndexAgentId, name: "Memory index", version: 0, outputs: {} },
      index: { model: embedModelName(), items: items.map((item) => ({ key: item.key, text: item.text.slice(0, 2_000) })) },
      messages: [], tools: [], runtime: runtimeClaim(null, cpuInfo),
      limits: { steps: 0, tokens: 0, runSeconds: 600, remainingModelMs: moduleBudget().modelMsLeft, toolCallsPerStep: 0, maxToolCalls: 0, heartbeatMs: limits.heartbeatMs },
    };
  }

  const textHash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 32);

  /** Everything memory search may compare by meaning, whose vector is missing or out of date. */
  function pendingEmbeddings() {
    const model = embedModelName();
    const items = [];
    for (const agent of store.listAgents()) {
      for (const note of store.listNotes(agent.id, { limit: 200 })) items.push({ key: `note:${note.id}`, text: `${note.title}\n${note.body}` });
      // Its findings (M47.3): notes of their own kind, kept apart from the list above, matched by meaning once embedded.
      for (const finding of store.listFindings({ agentId: agent.id })) items.push({ key: `note:${finding.id}`, text: `${finding.title}\n${finding.body}` });
      for (const episode of store.listEpisodes(agent.id, { limit: 200 })) items.push({ key: `episode:${episode.id}`, text: episode.text });
      // The example book (M46): the request alone, which is what a new request is compared with.
      for (const example of store.listExamples(agent.id, { limit: 400 })) items.push({ key: `example:${example.id}`, text: example.request });
    }
    for (const document of store.listDocuments({ enabled: true })) chunksOf(document).forEach((text, index) => items.push({ key: `doc:${document.id}#${index}`, text: `${document.title}\n${text}` }));
    const kinds = ["note", "episode", "doc", "example"];
    const vectors = store.vectorKeys(kinds);
    return items.filter((item) => { const stored = vectors.get(item.key); return !stored || stored.model !== model || stored.textHash !== textHash(item.text); });
  }

  /** The runner's embeddings for an index run: each checked, stored against the text it was made from. */
  function runnerVectors(runId, lease, entries) {
    const run = heldRun(runId, lease);
    if (run.kind !== "index") refuse(409, "Only an index run sends embeddings", "not_index");
    const pending = new Map(pendingEmbeddings().map((item) => [item.key, item]));
    const model = embedModelName();
    let saved = 0;
    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, limits.indexBatch)) {
      const item = pending.get(entry?.key);
      const vector = readVector(entry?.vector);
      if (!item || !vector) continue;
      const [kind, itemId] = [item.key.slice(0, item.key.indexOf(":")), item.key.slice(item.key.indexOf(":") + 1)];
      store.setVector(kind, itemId, { model, vector: encodeVector(vector), textHash: textHash(item.text) });
      saved += 1;
    }
    return { saved };
  }

  /**
   * Whether the memory index's or the image describer's last run failed in these quiet hours: it is
   * not queued again until the next ones, rather than starting the model every minute of the night
   * to fail the same way (2026-10 sweep).
   */
  function failedTonight(agentId) {
    const began = quietHoursStart(now(), moduleSettings().quietHours);
    const [last] = began ? store.listRuns({ agentId, limit: 1 }) : [];
    return Boolean(last && ["degraded", "failed", "timeout", "interrupted"].includes(last.state) && Date.parse(last.finishedAt ?? last.queuedAt) >= began.getTime());
  }

  /**
   * In quiet hours, when something waits to be embedded and nothing is indexing: one index run,
   * within every agent's budget for the day, and none after one failed tonight. `force` is the
   * owner's "index now", which goes whenever the budget allows.
   */
  function queueIndexing({ force = false } = {}) {
    const settings = moduleSettings();
    if (!settings.enabled || modulePaused(settings) || settings.embeddings === false || runtimeSettings().driver === "llama-server") return null;
    if (store.activeRuns().some((run) => run.kind === "index")) return null;
    if (moduleBudget().refusal || (!force && failedTonight(memoryIndexAgentId))) return null;
    if (!pendingEmbeddings().length) return null;
    const owner = state.listOwners?.().find((entry) => entry.role === "owner") ?? null;
    const run = store.enqueueRun({ agentId: memoryIndexAgentId, version: 0, kind: "index", trigger: { title: "Index memory for meaning search", quietHours: !force }, readRole: "owner", readAs: owner?.id ?? null });
    wake();
    return run;
  }

  /**
   * In quiet hours, when an image from #agent-files waits to be described (M38): one describe run,
   * one image, within the day's model time for every agent. The model reads the image and says what
   * it shows; that becomes the document's text, which search then finds.
   */
  function queueDescribing() {
    const settings = moduleSettings();
    // llama-server sees only when it is handed the model's projector (--mmproj); Unsloth finds it itself.
    if (!settings.enabled || modulePaused(settings) || settings.killedAt || (runtimeSettings().driver === "llama-server" && !runtimeSettings().projector)) return null;
    if (store.activeRuns().some((run) => run.kind === "describe") || failedTonight(imageDescribeAgentId)) return null;
    const budget = moduleBudget();
    if (!store.listUndescribed({ limit: 1 }).length || budget.refusal || budget.modelMsLeft < 60_000) return null;
    // A model server that said it cannot see is asked again a day later, or after the model or the runtime changed (M40.6).
    const sight = visionNow();
    if (sight?.vision === false && now().getTime() - Date.parse(sight.at) < 86_400_000) return null;
    const owner = state.listOwners?.().find((entry) => entry.role === "owner") ?? null;
    const run = store.enqueueRun({ agentId: imageDescribeAgentId, version: 0, kind: "describe", trigger: { title: "Describe an image from #agent-files", quietHours: true }, readRole: "owner", readAs: owner?.id ?? null });
    wake();
    return run;
  }

  function describePayload(run, lease, { cpu: cpuInfo = null } = {}) {
    const items = store.listUndescribed({ limit: 1 }).map((document) => {
      const media = store.getDocumentMedia(document.id);
      return media ? { key: document.id, title: document.title, dataUrl: `data:${media.mediaType ?? "image/png"};base64,${media.media.toString("base64")}` } : null;
    }).filter(Boolean);
    return {
      run: { id: run.id, kind: "describe", question: null, trigger: run.trigger, readRole: run.readRole, startedAt: run.startedAt, deadlineAt: new Date(Date.parse(run.startedAt) + 600_000).toISOString() },
      lease, agent: { id: imageDescribeAgentId, name: "Image describer", version: 0, outputs: {} },
      describe: { items, prompt: describePrompt },
      messages: [], tools: [], runtime: runtimeClaim(null, cpuInfo),
      limits: { steps: 0, tokens: 2_000, runSeconds: 600, remainingModelMs: moduleBudget().modelMsLeft, toolCallsPerStep: 0, maxToolCalls: 0, heartbeatMs: limits.heartbeatMs },
    };
  }

  /** A describe run's end: each image's text is the model's description, redacted and boxed as data. */
  function finishDescribe(run, result) {
    const usage = { modelMs: Math.round(finite(result.usage?.modelMs, 3_600_000)), loadMs: Math.round(finite(result.usage?.loadMs, 3_600_000)), wallMs: Math.max(0, now().getTime() - Date.parse(run.startedAt)) };
    // Whether the model server can see (M40.6), as it said: kept for Knowledge and Usage, and so a
    // model that cannot is not started again every minute of quiet hours to fail at it.
    if (typeof result.vision?.vision === "boolean") state.setSetting?.(visionKey, { vision: result.vision.vision, reason: typeof result.vision.reason === "string" ? clip(result.vision.reason.replace(/[\u0000-\u001f\u007f]/g, " "), 200) : null, model: runtimeSettings().repo, driver: runtimeSettings().driver, at: now().toISOString() }, { updatedBy: null });
    let described = 0;
    for (const entry of Array.isArray(result.descriptions) ? result.descriptions.slice(0, 4) : []) {
      const document = store.getDocument(entry?.key);
      if (!document?.mediaType) continue;
      const words = typeof entry.text === "string" ? sanitizeUntrusted(entry.text, { maxChars: 1_500, redact }).text.trim() : "";
      // A model that cannot see spends none of the image's three tries: it waits for one that can.
      if (!words) { if (result.vision?.vision !== false) store.describeDocument(document.id, { text: null }); continue; }
      const context = document.text.split(" Not described yet")[0];
      store.describeDocument(document.id, { text: `${context}\n\nWhat it shows, as the model described it: ${words}` });
      described += 1;
    }
    const outcome = ["completed", "degraded", "failed"].includes(result.outcome) ? result.outcome : "failed";
    const finished = store.finishRun(run.id, { state: outcome, reason: outcome === "failed" ? clip(String(result.error ?? "Describing failed"), 300) : null, usage, outputKind: "describe", answer: `Described ${described} ${described === 1 ? "image" : "images"} from #agent-files.` });
    if (!finished) refuse(409, "The run has already finished", "run_finished");
    runEnded(finished);
    audit("agents.images.described", { details: { runId: run.id, outcome: finished.state, described, modelMs: usage.modelMs } });
    wake();
    return { state: finished.state };
  }

  /** An index run's end: its usage counts toward the day's budget like any run's. */
  function finishIndex(run, result) {
    const usage = { modelMs: Math.round(finite(result.usage?.modelMs, 3_600_000)), loadMs: Math.round(finite(result.usage?.loadMs, 3_600_000)), wallMs: Math.max(0, now().getTime() - Date.parse(run.startedAt)) };
    const outcome = ["completed", "degraded", "failed"].includes(result.outcome) ? result.outcome : "failed";
    const finished = store.finishRun(run.id, { state: outcome, reason: outcome === "failed" ? clip(String(result.error ?? "Indexing failed"), 300) : null, usage, outputKind: "index", answer: `Indexed ${Math.round(finite(result.indexed, 10_000))} pieces of memory for meaning search.` });
    if (!finished) refuse(409, "The run has already finished", "run_finished");
    runEnded(finished);
    audit("agents.memory.indexed", { details: { runId: run.id, outcome: finished.state, indexed: Math.round(finite(result.indexed, 10_000)), modelMs: usage.modelMs } });
    wake();
    return { state: finished.state };
  }

  /** An uploaded PDF, Markdown or text file becomes a document in the library. Owner only. */
  /**
   * @param {any} caller
   * @param {{ name?: string, buffer?: Buffer, title?: string | null }} [upload]
   */
  function uploadDocument(caller, { name, buffer, title = null } = {}) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner adds documents", "forbidden");
    if (!Buffer.isBuffer(buffer) || !buffer.length) refuse(400, "Send the file", "invalid_document");
    let read;
    try { read = textOfUpload(buffer, name); } catch (error) { refuse(400, error.message, "invalid_document"); }
    if (!read.text) refuse(400, "The file has no text", "invalid_document");
    if (store.countDocuments() >= 300) refuse(409, "Three hundred documents is the most the library keeps", "document_limit");
    const cleanTitle = clip(String(title ?? name ?? "Uploaded document").replace(/\.(pdf|md|markdown|txt)$/i, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Uploaded document", 120);
    const document = store.addDocument({ title: cleanTitle, text: redact(read.text), createdBy: person.id, source: /\.pdf$/i.test(name ?? "") || buffer.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : "upload" });
    audit("agents.document.added", { actorId: person.id, subjectId: document.id, details: { characters: document.characters, source: document.source } });
    const { text: _text, ...rest } = document;
    return { ...rest, detail: read.detail };
  }

  /** Bring a connector's documents in: new ones added, changed ones replaced, each redacted. */
  function ingestDocuments(source, documents, { actorId = null, removeMissing = false } = {}) {
    let changed = 0; let removed = 0;
    const seen = new Set();
    for (const entry of documents) {
      if (!entry?.externalId || !entry?.text) continue;
      const externalId = String(entry.externalId).slice(0, 300);
      seen.add(externalId);
      // Its title is whoever named the page or file: one safe line, as it comes in (sweep 4).
      const result = store.upsertDocument({ source, externalId, title: boxLine(redact(String(entry.title ?? externalId)), 120) || clip(externalId, 120), text: redact(cleanDocumentText(entry.text)), createdBy: actorId });
      if (result.changed) changed += 1;
    }
    if (removeMissing) {
      for (const document of store.listDocuments().filter((entry) => entry.source === source && entry.externalId && !seen.has(entry.externalId))) { store.deleteDocument(document.id); removed += 1; }
    }
    return { changed, removed };
  }

  /**
   * The folder the owner named, read now: at most once an hour unless the owner asks, and waited on
   * for two minutes at most (2026-10 sweep 2: a NAS whose readdir hangs held up the tick for good).
   * A scan that never answered is not joined by another: each would hold one of the few threads
   * Node reads files with.
   */
  let lastFolderScan = 0;
  let folderScanning = null;
  async function syncFolder({ force = false, actorId = null } = {}) {
    const folder = moduleSettings().folder;
    if (!folder?.enabled || !folder.path) return { skipped: "off" };
    if (!force && now().getTime() - lastFolderScan < 3600_000) return { skipped: "recent" };
    if (folderScanning) return { error: "The folder is still being read from the last time. Try again later." };
    lastFolderScan = now().getTime();
    const scanning = Promise.resolve().then(() => folderScan(folder.path));
    folderScanning = scanning;
    void scanning.catch(() => null).finally(() => { if (folderScanning === scanning) folderScanning = null; });
    try {
      const { documents, skipped } = await inTime(() => scanning, limits.folderScanTimeoutMs, new ConnectorError(`The folder did not answer within ${Math.round(limits.folderScanTimeoutMs / 1000)} seconds`));
      const result = ingestDocuments("folder", documents, { actorId, removeMissing: true });
      audit("agents.folder.synced", { actorId, details: { files: documents.length, changed: result.changed, removed: result.removed, skipped: skipped.length } });
      return { files: documents.length, ...result, skipped };
    } catch (error) {
      return { error: error instanceof ConnectorError ? error.message : "The folder could not be read" };
    }
  }

  function syncFolderNow(caller) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner syncs the folder", "forbidden");
    return syncFolder({ force: true, actorId: person.id });
  }

  /** agents.connector.sync finished in its root task: its documents come into the library. */
  function ingestConnector(result, { actorId = null } = {}) {
    if (!result || !Object.hasOwn(connectors, result.connector) || !Array.isArray(result.documents)) return null;
    const bounded = boundSync(result.documents.filter((entry) => typeof entry?.text === "string"));
    const outcome = ingestDocuments(result.connector, bounded.documents, { actorId, removeMissing: !bounded.truncated });
    audit("agents.connector.synced", { actorId, details: { connector: result.connector, documents: bounded.documents.length, changed: outcome.changed, removed: outcome.removed } });
    return outcome;
  }

  function reindexMemory(caller) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner starts indexing", "forbidden");
    const run = queueIndexing({ force: true });
    return { queued: Boolean(run), pending: pendingEmbeddings().length };
  }

  function setKnowledgeSources(person, input) {
    if (person.role !== "owner") refuse(403, "Only the owner turns knowledge sources on or off", "forbidden");
    if (!input || typeof input !== "object" || Array.isArray(input)) refuse(400, "Send each source's on or off", "invalid_setting");
    const current = knowledgeSettings();
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(current, key) || typeof value !== "boolean") refuse(400, `There is no knowledge source called ${key}`, "invalid_setting");
      current[key] = value;
    }
    state.setSetting(agentsKnowledgeKey, current, { updatedBy: person.id });
    return current;
  }

  async function knowledgeState(caller) {
    const person = personOf(caller);
    if (person.role === "viewer") refuse(403, "The learning library is for the owner and operators", "forbidden");
    const toggles = knowledgeSettings();
    const stats = knowledge ? await knowledge.ensure().catch(() => knowledge.stats()) : null;
    const documents = store.listDocuments();
    const notes = store.listAgents().flatMap((agent) => store.listNotes(agent.id).map((note) => ({ ...note, agentName: agent.name })));
    const lastLearn = store.listAgents().map((agent) => ({ agentId: agent.id, name: agent.name, run: store.listRuns({ agentId: agent.id, kind: "learn", limit: 1 })[0] ?? null }))
      .map((entry) => ({ agentId: entry.agentId, name: entry.name, state: entry.run?.state ?? null, at: entry.run?.finishedAt ?? entry.run?.queuedAt ?? null }));
    return {
      sources: [
        { id: "docs", title: "BoxPilot's documents", enabled: toggles.docs, items: stats?.documents ?? null, size: stats ? stats.documentChunks : null, unit: "sections", indexedAt: stats?.builtAt ?? null },
        { id: "registry", title: "Registered operations", enabled: toggles.registry, items: stats?.operations ?? null, size: stats?.operations ?? null, unit: "operations", indexedAt: stats?.builtAt ?? null },
        { id: "catalog", title: "The app catalog", enabled: toggles.catalog, items: stats?.apps ?? null, size: stats?.apps ?? null, unit: "apps", indexedAt: stats?.builtAt ?? null },
        { id: "notes", title: "What the agents learned (their notes)", enabled: toggles.notes, items: notes.length, size: notes.reduce((sum, note) => sum + note.body.length, 0), unit: "characters", indexedAt: notes[0]?.updatedAt ?? null },
        { id: "documents", title: "Your documents", enabled: toggles.documents, items: documents.length, size: documents.reduce((sum, document) => sum + document.characters, 0), unit: "characters", indexedAt: documents[0]?.createdAt ?? null },
      ],
      documents: documents.map(({ text: _text, ...document }) => ({ ...document, createdBy: ownActor(person, document.createdBy) })),
      search: {
        kind: "words (BM25) and meaning (embeddings), fused",
        embeddings: moduleSettings().embeddings === false ? "Off: search is by words only." : runtimeSettings().driver === "llama-server" ? "Not with llama.cpp's server alone: search is by words only." : `${store.countVectors()} pieces indexed by the model server's embedder; ${pendingEmbeddings().length} wait for the next quiet hours.`,
        pending: pendingEmbeddings().length, vectors: store.countVectors(), enabled: moduleSettings().embeddings !== false,
      },
      connectors: presentModule(person).connectors, folder: presentModule(person).folder, webSearch: presentModule(person).webSearch,
      learning: { quietHours: moduleSettings().quietHours, agents: lastLearn },
      canChange: person.role === "owner",
      // M40.6: whether the model can see the images waiting to be described, as it last said.
      vision: visionNow(),
    };
  }

  /**
   * @param {any} caller
   * @param {{ title?: unknown, text?: unknown }} [body]
   */
  function addDocument(caller, { title, text } = {}) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner adds documents", "forbidden");
    const cleanTitle = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    const cleanText = typeof text === "string" ? text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
    if (!cleanTitle || cleanTitle.length > 120) refuse(400, "Give the document a title under 120 characters", "invalid_document");
    if (!cleanText || cleanText.length > 64_000) refuse(400, "A document is some text, at most 64,000 characters", "invalid_document");
    if (store.countDocuments() >= 100) refuse(409, "A hundred documents is the most the library keeps", "document_limit");
    const document = store.addDocument({ title: cleanTitle, text: redact(cleanText), createdBy: person.id });
    audit("agents.document.added", { actorId: person.id, subjectId: document.id, details: { characters: document.characters } });
    const { text: _text, ...rest } = document;
    return rest;
  }

  function removeDocument(caller, documentId) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner removes documents", "forbidden");
    if (!store.deleteDocument(documentId)) refuse(404, "There is no such document", "document_not_found");
    audit("agents.document.removed", { actorId: person.id, subjectId: documentId });
    return { deleted: true };
  }

  function toggleDocument(caller, documentId, enabled) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner changes documents", "forbidden");
    if (typeof enabled !== "boolean" || !store.setDocumentEnabled(documentId, enabled)) refuse(404, "There is no such document", "document_not_found");
    return { enabled };
  }

  /** Pinned knowledge: a document every agent that reads documents recalls first. Owner only. */
  function pinDocument(caller, documentId, pinned) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner pins documents", "forbidden");
    if (typeof pinned !== "boolean" || !store.setDocumentPinned(documentId, pinned)) refuse(404, "There is no such document", "document_not_found");
    audit("agents.document.pinned", { actorId: person.id, subjectId: documentId, details: { pinned } });
    return { pinned };
  }

  /** Queue a quiet-hours learning pass for one agent, or every agent that keeps notes. */
  function relearn(caller, agentId = null) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot start learning", "forbidden");
    const agents = agentId ? [agentFor(person, agentId, { edit: true })] : store.listAgents().filter((agent) => canEdit(person, agent));
    let queued = 0;
    for (const agent of agents.filter((entry) => entry.spec.memory?.enabled && entry.spec.tools["notes.write"] !== "off")) {
      if (enqueueSystem(agent, "learn", { title: "Learn this server", quietHours: true }).run) queued += 1;
    }
    audit("agents.relearn", { actorId: person.id, details: { agents: queued } });
    return { queued, quietHours: moduleSettings().quietHours };
  }

  return { chunksOf, pendingEmbeddings, runnerVectors, queueIndexing, queueDescribing, indexPayload, describePayload, finishIndex, finishDescribe, uploadDocument, syncFolder, syncFolderNow, ingestConnector, reindexMemory, setKnowledgeSources, knowledgeState, addDocument, removeDocument, toggleDocument, pinDocument, relearn };
}
