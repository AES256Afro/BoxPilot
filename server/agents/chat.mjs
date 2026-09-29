/**
 * The agents' Zulip connection, in the web process (M38): what is posted when a run finishes, the
 * outbox that sends it, and #agent-files read into Knowledge. The words and limits are zulip.mjs's;
 * the network and the bot's key are the root tasks' (server/tasks/zulip.mjs), reached through the
 * registered agents.zulip.post and agents.zulip.poll the way the TLS renewal reaches its operation:
 * BoxPilot runs them itself once the owner has connected, and the model never does.
 *
 * Bounded everywhere: a few posts a run, sixty an hour for every agent together, an outbox of two
 * hundred that drops its oldest rather than grow, a batch the helper can take, and a poll of twenty
 * messages and ten files at most. Nothing is posted or read while Agents are off, paused or killed:
 * posts wait in the outbox, files wait in Zulip.
 */
import { ConnectorError, cleanDocumentText, textOfUpload } from "./connectors.mjs";
import { ackMessage, boxpilotLink, cardMessage, chatLimits, destinationFor, findingMessage, imageMediaType, messageWords, noteMessage, traceMessage, zulipChannels } from "./zulip.mjs";

export const zulipSettingKey = "agentsZulip";

const clip = (text, max) => { const value = String(text ?? ""); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const originPattern = /^https?:\/\/[A-Za-z0-9.-]{1,180}(?::\d{1,5})?$/;
const findingKinds = new Set(["ask", "manual", "schedule", "event", "webhook", "continue"]);
const answered = new Set(["completed", "degraded"]);

export function createAgentChat({ state, store, helper = null, now = () => new Date(), redact = (text) => text, audit = () => {}, active = () => true, limits: overrides = {}, schedule = (task, ms) => { const timer = setTimeout(task, ms); timer.unref?.(); return timer; } } = {}) {
  const limits = { ...chatLimits, pollEveryMs: 3 * 60_000, drainDelayMs: 1_500, ...overrides };
  let draining = null;
  let polling = null;
  let drainTimer = null;
  let lastPoll = 0;

  const saved = () => state.getSetting?.(zulipSettingKey, null) ?? null;
  /** The connection when the owner has connected Zulip; null otherwise. */
  const connection = () => { const value = saved(); return value?.connected ? value : null; };
  const remember = (patch) => { const current = saved() ?? {}; state.setSetting?.(zulipSettingKey, { ...current, ...patch }); };
  const base = (link) => `http://127.0.0.1:${link.port}`;
  const where = (link) => ({ base: base(link), host: link.host, botEmail: link.botEmail });

  // ---- connecting ----

  /** agents.zulip.connect finished in the helper: remember where Zulip is and what Connect made. */
  function connected(result, { actorId = null, boxpilotUrl = null } = {}) {
    if (!result?.connected) return null;
    const before = saved() ?? {};
    const sameSite = before.site === result.site;
    remember({
      connected: true, site: result.site, host: result.host, port: result.port, realm: result.realm ?? null, realmId: result.realmId ?? null,
      botEmail: result.botEmail, credential: result.credential, channels: { ...result.channels },
      boxpilotUrl: typeof boxpilotUrl === "string" && originPattern.test(boxpilotUrl) ? boxpilotUrl : before.boxpilotUrl ?? null,
      connectedAt: now().toISOString(), connectedBy: actorId, public: result.public ?? [],
      // Reconnecting to the same Zulip keeps the place in #agent-files, so nothing is read twice.
      files: sameSite ? before.files ?? {} : {},
      lastError: null,
    });
    audit("agents.zulip.connected", { actorId, details: { realm: result.realm ?? null, botCreated: Boolean(result.botCreated), made: result.made ?? [] } });
    return connection();
  }

  function disconnected({ actorId = null } = {}) {
    const dropped = store.dropQueuedChatPosts("Zulip was disconnected before this was posted.");
    remember({ connected: false, disconnectedAt: now().toISOString(), lastError: null });
    audit("agents.zulip.disconnected", { actorId, details: { dropped } });
    return { dropped };
  }

  // ---- after a run ----

  const linkTo = (link, query, words) => boxpilotLink(link?.boxpilotUrl ?? null, query, words);

  /**
   * What a finished run leaves in chat: its answer or digest and its cards in #agent-findings, its
   * trace in #agent-logs, the notes it kept in #agent-knowledge. Each only where the agent's own
   * chat outputs say, and nothing at all unless Zulip is connected.
   */
  function afterRun(agent, spec, run) {
    const link = connection();
    if (!link || !agent || !run || ["index", "describe", "eval"].includes(run.kind)) return [];
    const queued = [];
    const queue = (kind, destination, content, attachment = null) => {
      if (!destination || !String(content ?? "").trim()) return;
      const { post, dropped } = store.queueChatPost({ kind, agentId: agent.id, runId: run.id, channel: destination.channel, topic: destination.topic, content, attachment }, { max: limits.queued });
      if (dropped) audit("agents.zulip.dropped", { details: { dropped, reason: "outbox full" } });
      queued.push(post);
    };
    const name = spec?.name ?? agent.name;
    const runLink = linkTo(link, `view=agents&tab=test&agent=${agent.id}&run=${run.id}`, "open the run in BoxPilot");
    try {
      // A supervisor that handed work on answers in its follow-up run; that one is posted, once.
      const handedOn = run.kind !== "continue" && store.listChildren(run.id).some((entry) => entry.kind === "handoff");
      const proposals = store.listProposalsForRun(run.id).slice(0, limits.cardsPerRun);
      const findings = destinationFor(spec, "findings", link);
      if (findings && findingKinds.has(run.kind) && answered.has(run.state) && run.answer && !handedOn && !run.flags?.clarify) {
        queue("findings", findings, findingMessage({ agentName: name, run, digest: run.kind === "schedule" && Boolean(spec?.outputs?.digest), link: runLink, redact }));
      }
      for (const proposal of proposals) {
        queue("findings", findings, cardMessage({ agentName: name, proposal, link: linkTo(link, `view=agents&agent=${agent.id}`, "the card on the Agents page"), redact }));
      }
      const logs = destinationFor(spec, "logs", link);
      if (logs) {
        const trace = traceMessage({ agentName: name, run, steps: store.listSteps(run.id), link: runLink, redact });
        queue("logs", logs, trace.content, trace.attachment);
      }
      const knowledge = destinationFor(spec, "knowledge", link);
      if (knowledge) {
        const notes = store.listNotes(agent.id, { limit: 200 }).filter((note) => note.source?.runId === run.id).slice(0, limits.notesPerRun);
        for (const note of notes) queue("knowledge", knowledge, noteMessage({ agentName: name, note, redact }));
      }
    } catch { /* chat is a copy of what BoxPilot keeps; a run never fails over it */ }
    if (queued.length) soon();
    return queued;
  }

  // ---- the outbox ----

  function soon() {
    if (drainTimer) return;
    drainTimer = schedule(() => { drainTimer = null; void drain(); }, limits.drainDelayMs);
  }

  /** One batch of what waits, sent as the bot: within the hour's allowance and what the helper takes. */
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      const link = connection();
      if (!link || !helper || !active()) return { sent: 0, waiting: store.countChatPosts().queued ?? 0 };
      const hourAgo = new Date(now().getTime() - 3600_000).toISOString();
      const allowance = limits.postsPerHour - store.chatPostsSince(hourAgo);
      if (allowance <= 0) return { sent: 0, waiting: store.countChatPosts().queued ?? 0, held: "hourly limit" };
      const batch = [];
      let bytes = 0;
      for (const post of store.listChatPosts({ state: "queued", limit: limits.batchPosts })) {
        const entry = { id: post.id, channel: post.channel, topic: post.topic, content: post.content, ...(post.attachment ? { attachment: post.attachment } : {}) };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (batch.length && bytes + size > limits.batchBytes) break;
        if (batch.length >= Math.min(limits.batchPosts, allowance)) break;
        batch.push(entry);
        bytes += size;
      }
      if (!batch.length) return { sent: 0, waiting: 0 };
      let answer;
      try {
        answer = await helper.request("agents.zulip.post", { ...where(link), posts: batch }, { timeoutMs: 120_000 });
      } catch (error) {
        // Nothing was sent: the posts wait for the next try, each counting it.
        for (const post of batch) retryOrFail(post.id, error.message);
        remember({ lastError: { at: now().toISOString(), message: clip(error.message, 300) } });
        return { sent: 0, error: error.message };
      }
      let sent = 0;
      let lastPost = null;
      let lastError = null;
      for (const result of answer?.results ?? []) {
        const post = batch.find((entry) => entry.id === result.id);
        if (!post) continue;
        if (result.ok) {
          store.markChatPost(post.id, { state: "sent", messageId: Number.isInteger(result.messageId) ? result.messageId : null });
          sent += 1;
          lastPost = { at: now().toISOString(), channel: post.channel, topic: post.topic };
        } else {
          retryOrFail(post.id, result.error);
          lastError = { at: now().toISOString(), message: clip(result.error ?? "Zulip did not take it", 300) };
        }
      }
      remember({ ...(lastPost ? { lastPost } : {}), ...(lastError ? { lastError } : lastPost ? { lastError: null } : {}) });
      store.pruneChatPosts({ keep: limits.kept });
      if ((store.countChatPosts().queued ?? 0) > 0 && sent) soon();
      return { sent, failed: batch.length - sent };
    })().finally(() => { draining = null; });
    return draining;
  }

  function retryOrFail(id, error) {
    const tries = (store.getChatPost(id)?.attempts ?? 0) + 1;
    store.markChatPost(id, { state: tries >= limits.attempts ? "failed" : "queued", error: clip(error ?? "Zulip did not take it", 300) });
  }

  // ---- #agent-files ----

  /**
   * One file or message from #agent-files into the library. PDF, Markdown and text become
   * documents through the uploads' own reader; an image is kept as it came, with a line of context,
   * for the model to describe in quiet hours. Redacted like every document; data, never
   * instructions.
   */
  function ingestMessage(message, link) {
    const outcomes = [];
    const channel = link.channels?.files ?? zulipChannels.files.name;
    const context = messageWords(message.content).slice(0, 400);
    const sender = clip(String(message.sender ?? "someone").replace(/[\u0000-\u001f\u007f]/g, " "), 80);
    for (const file of message.files ?? []) {
      if (file.skipped) { outcomes.push({ added: false, name: file.name, reason: file.skipped }); continue; }
      const name = clip(String(file.name ?? "file").replace(/[\u0000-\u001f\u007f]/g, " "), 120);
      const title = clip(name.replace(/\.(pdf|md|markdown|txt|text|png|jpe?g|gif|webp)$/i, "").trim(), 110) || "File from Zulip";
      const externalId = clip(`${message.id}:${file.path ?? name}`, 300);
      try {
        const bytes = Buffer.from(String(file.bytes ?? ""), "base64");
        if (!bytes.length) throw new ConnectorError("the file is empty");
        if (bytes.length > limits.fileBytes) throw new ConnectorError("larger than 5 MB");
        if (store.listDocuments().length >= 300) throw new ConnectorError("the library holds 300 documents already; remove some in Knowledge");
        if (file.kind === "image") {
          if (store.countImageDocuments() >= limits.imageDocuments) throw new ConnectorError(`the library holds ${limits.imageDocuments} images already; remove some in Knowledge`);
          const text = redact(`Image "${name}", dropped in #${channel} by ${sender}${context ? `, who wrote: ${context}` : ""}. Not described yet: the model describes images in quiet hours.`);
          store.upsertDocument({ source: "zulip", externalId, title: `Image: ${title}`, text, mediaType: imageMediaType(name) ?? "image/png", media: bytes });
          outcomes.push({ added: true, title: `Image: ${title}`, detail: "the model describes it in quiet hours" });
        } else {
          const read = textOfUpload(bytes, name);
          if (!read.text) throw new ConnectorError("it has no text");
          store.upsertDocument({ source: "zulip", externalId, title, text: redact(read.text) });
          outcomes.push({ added: true, title, detail: read.detail });
        }
      } catch (error) {
        outcomes.push({ added: false, name, reason: error instanceof ConnectorError ? error.message : "it could not be read" });
      }
    }
    // Words alone, long enough to be worth keeping, are a note from the owner as well.
    if (!(message.files ?? []).length && context.length >= limits.textMinChars) {
      const title = `Note from Zulip: ${clip(context, 60)}`;
      store.upsertDocument({ source: "zulip", externalId: `${message.id}:text`, title, text: redact(cleanDocumentText(`${context}\n\n(${sender}, in #${channel})`)) });
      outcomes.push({ added: true, title });
    }
    return outcomes;
  }

  /** Read #agent-files after the last message seen; bring in what it holds; say so in each topic. */
  function poll({ force = false } = {}) {
    if (polling) return polling;
    polling = (async () => {
      const link = connection();
      if (!link || !helper || !active()) return { skipped: "off" };
      if (!force && now().getTime() - lastPoll < limits.pollEveryMs) return { skipped: "recent" };
      lastPoll = now().getTime();
      let answer;
      try {
        answer = await helper.request("agents.zulip.poll", { ...where(link), channel: link.channels.files, after: Number.isInteger(link.files?.after) ? link.files.after : null }, { timeoutMs: 180_000 });
      } catch (error) {
        remember({ files: { ...(link.files ?? {}), lastPollAt: now().toISOString(), lastError: clip(error.message, 300) } });
        return { error: error.message };
      }
      let added = 0;
      let lastIngest = link.files?.lastIngest ?? null;
      for (const message of answer?.messages ?? []) {
        const outcomes = ingestMessage(message, link);
        added += outcomes.filter((outcome) => outcome.added).length;
        const first = outcomes.find((outcome) => outcome.added);
        if (first) lastIngest = { at: now().toISOString(), title: first.title };
        if (outcomes.length) {
          const { dropped } = store.queueChatPost({ kind: "ack", channel: link.channels.files, topic: clip(message.topic || "files", limits.topicChars), content: ackMessage(outcomes) }, { max: limits.queued });
          if (dropped) audit("agents.zulip.dropped", { details: { dropped, reason: "outbox full" } });
        }
      }
      remember({ files: { after: Number.isInteger(answer?.last) ? answer.last : link.files?.after ?? null, lastPollAt: now().toISOString(), lastError: null, lastIngest } });
      if (added) audit("agents.zulip.ingested", { details: { documents: added, messages: (answer?.messages ?? []).length } });
      if ((answer?.messages ?? []).length) soon();
      // More waiting: read on at the next tick rather than in a loop now.
      if (answer?.more) lastPoll = 0;
      return { messages: (answer?.messages ?? []).length, added };
    })().finally(() => { polling = null; });
    return polling;
  }

  // ---- for the page ----

  function present(person, { app = null } = {}) {
    const value = saved() ?? {};
    const owner = person.role === "owner";
    const recent = owner ? store.listChatPosts({ limit: 8 }).map((post) => ({
      id: post.id, kind: post.kind, channel: post.channel, topic: post.topic, state: post.state, error: post.error, createdAt: post.createdAt, sentAt: post.sentAt,
      agentName: post.agentId ? store.getAgent(post.agentId, { includeDeleted: true })?.name ?? null : null,
      // As it reads in Zulip, roughly: links as their words, no bold or code marks.
      preview: clip(post.content.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim(), 160),
    })) : [];
    return {
      connected: Boolean(value.connected),
      site: value.site ?? null, realm: value.realm ?? null, botEmail: value.botEmail ?? null,
      channels: value.channels ?? Object.fromEntries(Object.entries(zulipChannels).map(([kind, channel]) => [kind, channel.name])),
      notPrivate: value.public ?? [],
      connectedAt: value.connectedAt ?? null, boxpilotUrl: owner ? value.boxpilotUrl ?? null : null,
      lastPost: value.lastPost ?? null, lastError: value.lastError ?? null,
      files: { lastPollAt: value.files?.lastPollAt ?? null, lastIngest: value.files?.lastIngest ?? null, lastError: value.files?.lastError ?? null },
      counts: store.countChatPosts(), recent,
      active: active(), app,
      canChange: owner,
    };
  }

  /** The connection as an agent's prompt names it (prompt.mjs), or null. */
  const promptConnection = () => { const link = connection(); return link ? { channels: link.channels } : null; };

  /** Every minute from the service's tick: send what waits, and read #agent-files every few minutes. */
  async function tick() {
    if (!connection()) return;
    if ((store.countChatPosts().queued ?? 0) > 0) await drain().catch(() => null);
    await poll().catch(() => null);
  }

  return { connection, connected, disconnected, afterRun, drain, poll, present, promptConnection, tick, ingestMessage };
}
