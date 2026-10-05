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
import { ackMessage, boxpilotLink, cardMessage, chatLimits, chatText, destinationFor, findingMessage, imageMediaType, messageWords, notSetUpMessage, noteMessage, replyMessage, traceMessage, zulipChannels } from "./zulip.mjs";

export const zulipSettingKey = "agentsZulip";

/**
 * Two-way chat (M40.5): the bot's event queue is read once a minute; a person the owner has mapped
 * to a BoxPilot account asks as that account, and the answer comes back in the thread they asked in.
 * Someone not mapped is told so, at most once an hour, and never reaches a model.
 */
export const askLimits = Object.freeze({ pollEveryMs: 60_000, refuseEveryMs: 3_600_000, askers: 20, people: 50, catchUpMinutes: 15 });

const clip = (text, max) => { const value = String(text ?? ""); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const originPattern = /^https?:\/\/[A-Za-z0-9.-]{1,180}(?::\d{1,5})?$/;
const findingKinds = new Set(["ask", "manual", "schedule", "event", "webhook", "continue"]);
const answered = new Set(["completed", "degraded"]);

export function createAgentChat({ state, store, helper = null, now = () => new Date(), redact = (text) => text, audit = () => {}, active = () => true, ask = null, limits: overrides = {}, schedule = (task, ms) => { const timer = setTimeout(task, ms); timer.unref?.(); return timer; } } = {}) {
  const limits = { ...chatLimits, pollEveryMs: 3 * 60_000, drainDelayMs: 1_500, askPollEveryMs: askLimits.pollEveryMs, ...overrides };
  let draining = null;
  let polling = null;
  let asking = null;
  let drainTimer = null;
  let stopped = false;
  let lastPoll = 0;
  let lastAskPoll = 0;

  const saved = () => state.getSetting?.(zulipSettingKey, null) ?? null;
  /** The connection when the owner has connected Zulip; null otherwise. */
  const connection = () => { const value = saved(); return value?.connected ? value : null; };
  const remember = (patch) => { const current = saved() ?? {}; state.setSetting?.(zulipSettingKey, { ...current, ...patch }); };
  // Who Zulip is to the bot. Where it is, the helper reads from the Zulip app itself (2026-10 sweep 2).
  const where = (link) => ({ host: link.host, botEmail: link.botEmail });

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
      const { post, dropped } = store.queueChatPost({ kind, agentId: agent.id, runId: run.id, channel: destination.channel ?? "", topic: destination.topic ?? "", to: destination.to ?? null, content, attachment }, { max: limits.queued });
      if (dropped) audit("agents.zulip.dropped", { details: { dropped, reason: "outbox full" } });
      queued.push(post);
    };
    const name = spec?.name ?? agent.name;
    const runLink = linkTo(link, `view=agents&tab=test&agent=${agent.id}&run=${run.id}`, "open the run in BoxPilot");
    try {
      // A supervisor that handed work on answers in its follow-up run; that one is posted, once.
      const handedOn = run.kind !== "continue" && store.listChildren(run.id).some((entry) => entry.kind === "handoff");
      // A specialist's answer, or a second supervisor's follow-up under a hand-off, is for the
      // supervisor that asked, not the person (2026-10 sweep 2): its cards may still go to the thread.
      const forSupervisor = run.kind === "handoff" || (run.kind === "continue" && (run.depth ?? 0) > 0);
      const proposals = store.listProposalsForRun(run.id).slice(0, limits.cardsPerRun);
      // Asked in Zulip (M40.5): the answer, and its cards, go back to the thread it was asked in -
      // the root question's thread for a supervisor's follow-up - and not to #agent-findings as well.
      const asked = chatOrigin(run);
      const findings = asked ?? destinationFor(spec, "findings", link);
      // However it ended: a question BoxPilot cancelled (it waited too long), refused (no runs left
      // today) or stopped is answered with why, not left unanswered (2026-10 sweep). A run that
      // handed on and ended with an answer is answered by its follow-up; one that ended any other
      // way gets none, so it says why itself (sweep 3: nobody answered).
      const followUpComes = handedOn && ["completed", "degraded"].includes(run.state);
      if (asked && !followUpComes && !forSupervisor && ["completed", "degraded", "failed", "timeout", "interrupted", "cancelled", "refused", "killed"].includes(run.state)) {
        queue("reply", asked, replyMessage({ agentName: name, run, link: runLink, redact }));
      } else if (!asked && findings && findingKinds.has(run.kind) && answered.has(run.state) && run.answer && !handedOn && !forSupervisor && !run.flags?.clarify) {
        queue("findings", findings, findingMessage({ agentName: name, run, digest: run.kind === "schedule" && Boolean(spec?.outputs?.digest), link: runLink, redact }));
      }
      for (const proposal of proposals) {
        // A question asked back is in the reply itself; answered here, in the thread.
        if (asked && proposal.kind === "question") continue;
        queue("findings", findings, cardMessage({ agentName: name, proposal, link: linkTo(link, `view=agents&agent=${agent.id}`, "the card on the Agents page"), flagged: Boolean(run.flags?.injection), redact }));
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
    if (drainTimer || stopped) return;
    // A send that fails later is retried from the queue; it must never surface as an unhandled rejection.
    drainTimer = schedule(() => { drainTimer = null; drain().catch(() => {}); }, limits.drainDelayMs);
  }

  /**
   * Stops the outbox for good: the waiting send is cancelled and none is started, so nothing reads the
   * database after its owner closed it (a demo world torn down 1.5 s after it queued a post did).
   */
  function stop() {
    stopped = true;
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  }

  /** One batch of what waits, sent as the bot: within the hour's allowance and what the helper takes. */
  function drain() {
    if (draining) return draining;
    if (stopped) return Promise.resolve({ sent: 0, stopped: true });
    draining = (async () => {
      const link = connection();
      if (!link || !helper || !active()) return { sent: 0, waiting: store.countChatPosts().queued ?? 0 };
      const hourAgo = new Date(now().getTime() - 3600_000).toISOString();
      const allowance = limits.postsPerHour - store.chatPostsSince(hourAgo);
      if (allowance <= 0) return { sent: 0, waiting: store.countChatPosts().queued ?? 0, held: "hourly limit" };
      const batch = [];
      let bytes = 0;
      for (const post of store.listChatPosts({ state: "queued", limit: limits.batchPosts })) {
        // A reply to a direct message goes to its people (M40.5); everything else to its channel and topic.
        const entry = { id: post.id, ...(post.to?.length ? { to: post.to } : { channel: post.channel, topic: post.topic }), content: post.content, ...(post.attachment ? { attachment: post.attachment } : {}) };
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

  // ---- two-way chat (M40.5) ----

  /** Where a run asked in Zulip is answered: its own question's thread, or its root's for a follow-up. */
  function chatOrigin(run) {
    const origin = run?.trigger?.chat ?? (run?.rootRunId && run.rootRunId !== run.id ? store.getRun(run.rootRunId)?.trigger?.chat : null) ?? null;
    if (!origin) return null;
    if (Array.isArray(origin.to) && origin.to.length) return { to: origin.to };
    return origin.channel && origin.topic ? { channel: origin.channel, topic: origin.topic } : null;
  }
  const whereAsked = (message) => (message.kind === "direct" ? { to: message.to?.length ? message.to : [message.senderId].filter(Number.isInteger) } : { channel: message.channel, topic: message.topic || "BoxPilot" });

  /** The owner's list: who in Zulip asks as which BoxPilot account, and the agent asked by default. */
  function setPeople({ people = [], defaultAgentId = null, twoWay = true } = {}, { actorId = null, accounts = [], agents = [] } = {}) {
    if (!Array.isArray(people) || people.length > askLimits.people) throw new ConnectorError(`At most ${askLimits.people} people`);
    const known = new Set(accounts.map((account) => account.id));
    const clean = [];
    for (const entry of people) {
      const zulipId = Number.isInteger(entry?.zulipId) && entry.zulipId > 0 ? entry.zulipId : null;
      const zulipEmail = typeof entry?.zulipEmail === "string" && /^[^\s@]{1,100}@[^\s@]{1,200}$/.test(entry.zulipEmail.trim()) ? entry.zulipEmail.trim().toLowerCase() : null;
      if (!zulipId && !zulipEmail) throw new ConnectorError("Each person needs their Zulip address");
      if (!known.has(entry?.boxpilotId)) throw new ConnectorError("Each person asks as a BoxPilot account that exists");
      if (clean.some((other) => (zulipId && other.zulipId === zulipId) || (zulipEmail && other.zulipEmail === zulipEmail))) throw new ConnectorError("A Zulip person is on the list once");
      clean.push({ zulipId, zulipEmail, zulipName: typeof entry.zulipName === "string" ? clip(entry.zulipName.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 80) : null, boxpilotId: entry.boxpilotId });
    }
    if (defaultAgentId !== null && !agents.some((agent) => agent.id === defaultAgentId)) throw new ConnectorError("The default agent is one of the agents");
    const current = saved() ?? {};
    // Whoever is now on the list is no longer waiting to be set up.
    const askers = (current.askers ?? []).filter((asker) => !clean.some((person) => (person.zulipId && person.zulipId === asker.zulipId) || (person.zulipEmail && person.zulipEmail === asker.zulipEmail)));
    remember({ people: clean, defaultAgentId, twoWay: twoWay !== false, askers });
    audit("agents.zulip.people", { actorId, details: { people: clean.length, twoWay: twoWay !== false, defaultAgentId } });
    return clean;
  }

  const personFor = (message, people) => people.find((person) => (person.zulipId && person.zulipId === message.senderId) || (person.zulipEmail && person.zulipEmail === String(message.senderEmail ?? "").toLowerCase())) ?? null;

  /** Queue a reply in the thread a message was asked in. */
  function replyTo(message, content) {
    const { dropped } = store.queueChatPost({ kind: "reply", ...whereAsked(message), content }, { max: limits.queued });
    if (dropped) audit("agents.zulip.dropped", { details: { dropped, reason: "outbox full" } });
  }

  /**
   * Once a minute (and on "Check now"): the bot's event queue, read without waiting. Each message is
   * handled once, in order: a mapped person's question starts a run as their account, exactly as
   * the Test tab's Ask would (their role's tools, their rate limit, their conversation); anyone else
   * is told politely they are not set up, at most once an hour, and listed for the owner.
   */
  function pollAsks({ force = false } = {}) {
    if (asking) return asking;
    asking = (async () => {
      const link = connection();
      const value = saved() ?? {};
      if (!link || !helper || !active() || value.twoWay === false || !ask) return { skipped: "off" };
      if (!force && now().getTime() - lastAskPoll < limits.askPollEveryMs) return { skipped: "recent" };
      lastAskPoll = now().getTime();
      const events = value.events ?? {};
      let answer;
      try {
        answer = await helper.request("agents.zulip.events", { ...where(link), queueId: events.queueId ?? null, lastEventId: Number.isInteger(events.lastEventId) ? events.lastEventId : null, after: Number.isInteger(events.after) ? events.after : null, catchUpMinutes: askLimits.catchUpMinutes }, { timeoutMs: 60_000 });
      } catch (error) {
        remember({ events: { ...events, lastPollAt: now().toISOString(), lastError: clip(error.message, 300) } });
        return { error: error.message };
      }
      let after = Number.isInteger(events.after) ? events.after : 0;
      let asked = 0;
      let refused = 0;
      let lastAsk = events.lastAsk ?? null;
      const askers = [...(saved()?.askers ?? [])];
      for (const message of (answer?.messages ?? []).filter((entry) => Number.isInteger(entry?.id) && entry.id > after).sort((a, b) => a.id - b.id)) {
        after = Math.max(after, message.id);
        const person = personFor(message, saved()?.people ?? []);
        if (!person) {
          const known = askers.find((entry) => (message.senderId && entry.zulipId === message.senderId) || entry.zulipEmail === String(message.senderEmail).toLowerCase());
          const at = now().toISOString();
          if (known && known.lastRefusedAt && now().getTime() - Date.parse(known.lastRefusedAt) < askLimits.refuseEveryMs) { known.lastAt = at; known.count += 1; continue; }
          if (known) Object.assign(known, { lastAt: at, lastRefusedAt: at, count: known.count + 1 });
          else askers.unshift({ zulipId: message.senderId ?? null, zulipEmail: String(message.senderEmail ?? "").toLowerCase(), zulipName: clip(message.senderName ?? "", 80), lastAt: at, lastRefusedAt: at, count: 1 });
          replyTo(message, notSetUpMessage);
          refused += 1;
          continue;
        }
        const outcome = await Promise.resolve(ask({ message, person, where: whereAsked(message) })).catch((error) => ({ refused: clip(error?.message ?? "It could not be asked", 300) }));
        // A refusal names agents and limits: BoxPilot's words, still posted as chat text is (links as code, no mentions).
        if (outcome?.refused) { replyTo(message, chatText(clip(outcome.refused, 600), { redact, maxChars: 800 })); refused += 1; continue; }
        asked += 1;
        lastAsk = { at: now().toISOString(), agentName: outcome?.agentName ?? null, kind: message.kind };
      }
      remember({ askers: askers.slice(0, askLimits.askers), events: { queueId: answer?.queueId ?? null, lastEventId: Number.isInteger(answer?.lastEventId) ? answer.lastEventId : null, after: after || null, lastPollAt: now().toISOString(), lastError: null, lastAsk, reopenedAt: answer?.reopened ? now().toISOString() : events.reopenedAt ?? null } });
      if (asked || refused) { audit("agents.zulip.asked", { details: { asked, refused } }); soon(); }
      // More waiting: the next tick reads on, rather than a loop now.
      if (answer?.more) lastAskPoll = 0;
      return { asked, refused };
    })().finally(() => { asking = null; });
    return asking;
  }

  // ---- for the page ----

  function present(person, { app = null, accounts = [] } = {}) {
    const value = saved() ?? {};
    const owner = person.role === "owner";
    const recent = owner ? store.listChatPosts({ limit: 8 }).map((post) => ({
      id: post.id, kind: post.kind, channel: post.channel, topic: post.topic, direct: Boolean(post.to?.length), state: post.state, error: post.error, createdAt: post.createdAt, sentAt: post.sentAt,
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
      // M40.5: asking in Zulip. Who may ask, as which account, is the owner's to see and change.
      asking: {
        on: value.twoWay !== false,
        lastPollAt: value.events?.lastPollAt ?? null, lastError: value.events?.lastError ?? null, lastAsk: value.events?.lastAsk ?? null,
        defaultAgentId: value.defaultAgentId ?? null,
        people: owner ? (value.people ?? []) : [],
        askers: owner ? (value.askers ?? []).map(({ zulipId, zulipEmail, zulipName, lastAt, count }) => ({ zulipId, zulipEmail, zulipName, lastAt, count })) : [],
        accounts: owner ? accounts : [],
      },
    };
  }

  /** The connection as an agent's prompt names it (prompt.mjs), or null. */
  const promptConnection = () => { const link = connection(); return link ? { channels: link.channels } : null; };

  /** Every minute from the service's tick: send what waits, read what was asked (M40.5), and read #agent-files every few minutes. */
  async function tick() {
    if (!connection()) return;
    await pollAsks().catch(() => null);
    if ((store.countChatPosts().queued ?? 0) > 0) await drain().catch(() => null);
    await poll().catch(() => null);
  }

  return { connection, connected, disconnected, afterRun, drain, poll, pollAsks, setPeople, present, promptConnection, tick, ingestMessage, stop };
}
