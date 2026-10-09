/**
 * Root tasks that reach Zulip for the agents (M38), run in boxpilot-run@.service, the only place the
 * bot's key is read (M13.7's rule: the web process never holds a credential's value). Each talks to
 * Zulip on this server's loopback port, as Tailscale Serve does - under Zulip's own name, with the
 * HTTPS it was reached by - so nothing leaves the machine.
 *
 * - agents.zulip.check  is the key accepted, and is it the bot; optionally say hello in #agent-findings
 * - agents.zulip.post   send what the service queued: messages, and a trace attached as a file
 * - agents.zulip.poll   read #agent-files after the last message seen, and fetch the files it links
 *
 * Nothing here returns or logs the key, and a failure says what Zulip said, never the request.
 */
import http from "node:http";
import { createCredentialStore } from "../credentials.mjs";
import { chatLimits, uploadKind, uploadsIn } from "../agents/zulip.mjs";

const basePattern = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const hostPattern = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;
const keyPattern = /^[A-Za-z0-9]{16,64}$/;

export class ZulipError extends Error {
  constructor(message, { status = null, refused = false } = {}) { super(message); this.status = status; this.refused = refused; }
}

/** One HTTP exchange with Zulip on loopback, bounded in size and time. */
function exchange({ port, host, method = "GET", path, headers = {}, body = null, maxBytes = 2 * 1024 * 1024, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, timeout: timeoutMs, headers: { Host: host, "X-Forwarded-Proto": "https", "User-Agent": "BoxPilot-agents", ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(new ZulipError(`Zulip's answer was larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, buffer: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new ZulipError("Zulip did not answer in time")));
    request.on("error", (error) => reject(error instanceof ZulipError ? error : new ZulipError(`Zulip could not be reached on this server: ${error.code ?? error.message}`)));
    if (body) request.write(body);
    request.end();
  });
}

/**
 * A client for one bot on one Zulip. `read` gives the credential's value; `transport` is the HTTP
 * exchange (a test hands in its own).
 */
export async function zulipClient({ base, host, botEmail, credentialName }, { credentials = createCredentialStore(), transport = exchange } = {}) {
  const port = Number(basePattern.exec(String(base ?? ""))?.[1]);
  if (!port || port > 65535) throw new ZulipError("Zulip is reached on this server's loopback address only");
  if (typeof host !== "string" || !hostPattern.test(host)) throw new ZulipError("Zulip's address is not a host name");
  if (typeof botEmail !== "string" || !/^[^\s@]{1,100}@[^\s@]{1,200}$/.test(botEmail)) throw new ZulipError("The bot's address is not an email address");
  const key = await credentials.read(credentialName);
  if (typeof key !== "string" || !keyPattern.test(key)) throw new ZulipError(`The bot's key is not saved under ${credentialName}; connect Zulip again`);
  const authorization = `Basic ${Buffer.from(`${botEmail}:${key}`).toString("base64")}`;

  const readJson = (response, what) => {
    let body = null;
    try { body = JSON.parse(response.buffer.toString("utf8")); } catch { body = null; }
    if (response.status === 401) throw new ZulipError("Zulip refused the bot's key; connect Zulip again", { status: 401, refused: true });
    if (response.status >= 400 || body?.result !== "success") throw new ZulipError(`${what}: Zulip said ${String(body?.msg ?? `HTTP ${response.status}`).slice(0, 200)}`, { status: response.status });
    return body;
  };
  const form = (fields) => new URLSearchParams(Object.entries(fields).map(([name, value]) => [name, String(value)])).toString();
  const call = async (method, path, { fields = null, query = null, what, maxBytes } = {}) => readJson(await transport({
    port, host, method, maxBytes,
    path: `/api/v1/${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`,
    headers: { Authorization: authorization, Accept: "application/json", ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: fields ? form(fields) : null,
  }), what);

  return {
    me: () => call("GET", "users/me", { what: "Reading the bot" }),
    send: ({ channel, topic, content }) => call("POST", "messages", { fields: { type: "stream", to: channel, topic, content }, what: `Posting to #${channel}` }),
    /** A direct message to these people, by their Zulip user ids (M40.5: a reply to a DM). */
    sendDirect: ({ to, content }) => call("POST", "messages", { fields: { type: "direct", to: JSON.stringify(to), content }, what: "Sending a direct message" }),
    /**
     * An event queue for the messages the bot receives (M40.5): direct messages to it and messages in
     * its channels, with their flags ("mentioned"). No inbound exposure: BoxPilot asks, Zulip answers.
     */
    register: () => call("POST", "register", { fields: { event_types: JSON.stringify(["message"]), apply_markdown: "false", client_gravatar: "true", all_public_streams: "false" }, what: "Opening the bot's event queue" }),
    /** What arrived on the queue after `lastEventId`; `dontBlock` answers at once with what there is. */
    async events({ queueId, lastEventId, dontBlock = true, timeoutMs = 20_000 }) {
      const response = await transport({
        port, host, method: "GET", timeoutMs, maxBytes: 4 * 1024 * 1024,
        path: `/api/v1/events?${new URLSearchParams({ queue_id: queueId, last_event_id: String(lastEventId), dont_block: dontBlock ? "true" : "false" }).toString()}`,
        headers: { Authorization: authorization, Accept: "application/json" },
      });
      let body = null;
      try { body = JSON.parse(response.buffer.toString("utf8")); } catch { body = null; }
      // An expired queue is Zulip's ordinary answer after ten quiet minutes: a new one is opened.
      if (body?.code === "BAD_EVENT_QUEUE_ID") return { expired: true, events: [] };
      return { expired: false, events: readJson(response, "Reading the bot's event queue").events ?? [] };
    },
    /** Direct messages to the bot, or messages mentioning it, after a message id: what a new queue missed. */
    since: ({ narrow, after, count }) => call("GET", "messages", {
      what: "Reading what was asked of the bot", maxBytes: 4 * 1024 * 1024,
      query: { anchor: after ? String(after) : "newest", include_anchor: "false", num_before: after ? "0" : String(count), num_after: after ? String(count) : "0", apply_markdown: "false", narrow: JSON.stringify(narrow) },
    }),
    /** A text file uploaded as the bot; the path Zulip gives it back. */
    async upload({ name, text, type = "text/markdown" }) {
      const boundary = `boxpilot${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const safe = String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file.md";
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${type}\r\n\r\n`),
        Buffer.from(String(text), "utf8"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const answer = readJson(await transport({ port, host, method: "POST", path: "/api/v1/user_uploads", headers: { Authorization: authorization, Accept: "application/json", "Content-Type": `multipart/form-data; boundary=${boundary}` }, body }), "Attaching the trace");
      const url = answer.url ?? answer.uri;
      if (typeof url !== "string" || !url.startsWith("/user_uploads/")) throw new ZulipError("Zulip took the file but gave no address for it");
      return url;
    },
    messages: ({ channel, after, count }) => call("GET", "messages", {
      what: `Reading #${channel}`, maxBytes: 4 * 1024 * 1024,
      query: { anchor: after ? String(after) : "oldest", include_anchor: "false", num_before: "0", num_after: String(count), apply_markdown: "false", narrow: JSON.stringify([{ operator: "channel", operand: channel }]) },
    }),
    /** The bytes of one upload: Zulip hands the bot a short-lived address for it first. */
    async download({ realmId, file }, maxBytes) {
      const answer = await call("GET", `user_uploads/${realmId}/${file}`, { what: "Finding an upload" });
      const temporary = answer.url ?? answer.uri;
      if (typeof temporary !== "string" || !temporary.startsWith("/user_uploads/")) throw new ZulipError("Zulip gave no address for an upload");
      const response = await transport({ port, host, method: "GET", path: temporary, headers: { Accept: "*/*" }, maxBytes, timeoutMs: 60_000 });
      if (response.status !== 200) throw new ZulipError(`Downloading an upload: HTTP ${response.status}`, { status: response.status });
      return response.buffer;
    },
  };
}

/** agents.zulip.check: the key works and belongs to the bot; with `hello`, it says so in #agent-findings. */
export async function zulipCheck(parameters = {}, { log = () => {}, credentials, transport } = {}) {
  const client = await zulipClient(parameters, { credentials, transport });
  const me = await client.me();
  if (!me.is_bot) throw new ZulipError("The saved key belongs to a person, not the bot");
  log(`Zulip accepted the key of ${me.email}`, "stdout");
  let hello = null;
  if (parameters.hello?.channel) {
    const sent = await client.send({ channel: parameters.hello.channel, topic: parameters.hello.topic ?? "BoxPilot", content: String(parameters.hello.content ?? "").slice(0, chatLimits.messageChars) });
    hello = sent.id ?? null;
  }
  return { email: me.email, userId: me.user_id ?? null, isBot: true, hello };
}

/**
 * agents.zulip.post: each queued post in turn; one that fails is reported and the rest still go,
 * unless Zulip refused the key, which stops the batch.
 */
export async function zulipPost(parameters = {}, { log = () => {}, credentials, transport } = {}) {
  const client = await zulipClient(parameters, { credentials, transport });
  const results = [];
  let refused = null;
  for (const post of (parameters.posts ?? []).slice(0, chatLimits.batchPosts)) {
    if (refused) { results.push({ id: post.id, ok: false, error: refused }); continue; }
    try {
      let content = String(post.content ?? "");
      if (post.attachment?.text) {
        const url = await client.upload({ name: post.attachment.name, text: String(post.attachment.text).slice(0, chatLimits.attachmentChars) });
        content = `${content}\n\nThe whole trace: [${String(post.attachment.name).replace(/[[\]]/g, "")}](${url})`;
      }
      // A reply to a direct message goes back to the people in it (M40.5); everything else to its channel.
      const sent = Array.isArray(post.to) && post.to.length
        ? await client.sendDirect({ to: post.to, content: content.slice(0, 9_800) })
        : await client.send({ channel: post.channel, topic: post.topic, content: content.slice(0, 9_800) });
      results.push({ id: post.id, ok: true, messageId: sent.id ?? null });
    } catch (error) {
      const message = error instanceof ZulipError ? error.message : "Zulip could not be reached";
      if (error?.refused) refused = message;
      results.push({ id: post.id, ok: false, error: message });
    }
  }
  const sent = results.filter((result) => result.ok).length;
  log(`${sent} of ${results.length} posted to Zulip`, "stdout");
  return { results };
}

/**
 * What was asked of the bot, from Zulip's own message (M40.5): a direct message to it, or a message
 * in a channel that mentions it. Its own messages and other bots' are not questions. The words are
 * data; who sent it is what the service maps to a BoxPilot account.
 */
export function askedOf(message, { botEmail, flags = [] } = {}) {
  if (!message || !Number.isInteger(message.id)) return null;
  const sender = String(message.sender_email ?? "").toLowerCase();
  if (!sender || sender === String(botEmail ?? "").toLowerCase() || /-bot@/.test(sender)) return null;
  const direct = message.type === "private" || message.type === "direct";
  const mentioned = flags.includes("mentioned") || (Array.isArray(message.flags) && message.flags.includes("mentioned"));
  if (!direct && !mentioned) return null;
  const recipients = direct && Array.isArray(message.display_recipient) ? message.display_recipient : [];
  // A direct message the bot is not in is not for it (a group without it cannot reach its queue anyway).
  if (direct && recipients.length && !recipients.some((entry) => String(entry?.email ?? "").toLowerCase() === String(botEmail ?? "").toLowerCase())) return null;
  return {
    id: message.id, kind: direct ? "direct" : "mention",
    senderId: Number.isInteger(message.sender_id) ? message.sender_id : null, senderEmail: String(message.sender_email ?? "").slice(0, 200), senderName: String(message.sender_full_name ?? "").slice(0, 80),
    // Everyone else in a group direct message is answered too, as Zulip itself would.
    to: direct ? recipients.filter((entry) => String(entry?.email ?? "").toLowerCase() !== String(botEmail ?? "").toLowerCase()).map((entry) => entry?.id).filter(Number.isInteger).slice(0, 8) : [],
    channel: direct ? null : String(message.display_recipient ?? "").slice(0, 60), topic: direct ? null : String(message.subject ?? message.topic ?? "").slice(0, 60),
    content: String(message.content ?? "").slice(0, 4_000),
    at: Number.isInteger(message.timestamp) ? new Date(message.timestamp * 1000).toISOString() : null,
  };
}

/**
 * agents.zulip.events (M40.5): the bot's event queue, read without waiting, once a minute from the
 * service's tick. A queue that is missing or expired (Zulip drops one after ten quiet minutes) is
 * opened again, and what was asked since the last message handled is read back from the message
 * history, so nothing asked while it was gone is lost; only what was asked within `catchUpMinutes`
 * is taken, since an answer hours late helps nobody.
 */
export async function zulipEvents(parameters = {}, { log = () => {}, credentials, transport, now = () => new Date() } = {}) {
  const client = await zulipClient(parameters, { credentials, transport });
  let queueId = typeof parameters.queueId === "string" && /^[A-Za-z0-9:_.-]{1,120}$/.test(parameters.queueId) ? parameters.queueId : null;
  let lastEventId = Number.isInteger(parameters.lastEventId) ? parameters.lastEventId : -1;
  const asked = [];
  let reopened = false;
  if (queueId) {
    const read = await client.events({ queueId, lastEventId, dontBlock: true });
    if (read.expired) queueId = null;
    for (const event of read.events) {
      if (Number.isInteger(event?.id)) lastEventId = Math.max(lastEventId, event.id);
      if (event?.type !== "message") continue;
      const found = askedOf(event.message, { botEmail: parameters.botEmail, flags: event.flags ?? [] });
      if (found) asked.push(found);
    }
  }
  if (!queueId) {
    const opened = await client.register();
    if (typeof opened.queue_id !== "string") throw new ZulipError("Zulip opened no event queue for the bot");
    queueId = opened.queue_id;
    lastEventId = Number.isInteger(opened.last_event_id) ? opened.last_event_id : -1;
    reopened = true;
    // What was asked while there was no queue: direct messages and mentions after the last one handled.
    const after = Number.isInteger(parameters.after) && parameters.after > 0 ? parameters.after : null;
    const cutoff = now().getTime() - (Number.isInteger(parameters.catchUpMinutes) ? parameters.catchUpMinutes : 15) * 60_000;
    if (after) {
      for (const narrow of [[{ operator: "is", operand: "dm" }], [{ operator: "is", operand: "mentioned" }]]) {
        const listed = await client.since({ narrow, after, count: 10 });
        for (const message of listed.messages ?? []) {
          const found = askedOf(message, { botEmail: parameters.botEmail, flags: message.flags ?? [] });
          if (found && !asked.some((entry) => entry.id === found.id) && (!found.at || Date.parse(found.at) >= cutoff)) asked.push(found);
        }
      }
    }
  }
  asked.sort((a, b) => a.id - b.id);
  const kept = asked.slice(0, 10);
  log(`${reopened ? "Opened the bot's event queue; " : ""}${kept.length} ${kept.length === 1 ? "message" : "messages"} asked of the bot`, "stdout");
  return { queueId, lastEventId, reopened, messages: kept, more: asked.length > kept.length };
}

/**
 * agents.zulip.poll: the messages in the files channel after the last one seen, and the files they
 * link to - PDFs, Markdown and text, and images - each within the connectors' size limit and all
 * within one poll's. What people wrote comes back as data; the bot's own messages are skipped.
 */
export async function zulipPoll(parameters = {}, { log = () => {}, credentials, transport } = {}) {
  const client = await zulipClient(parameters, { credentials, transport });
  const after = Number.isInteger(parameters.after) && parameters.after > 0 ? parameters.after : null;
  const answer = await client.messages({ channel: parameters.channel, after, count: chatLimits.pollMessages });
  const listed = (Array.isArray(answer.messages) ? answer.messages : []).filter((message) => Number.isInteger(message?.id) && (!after || message.id > after)).sort((a, b) => a.id - b.id);
  const messages = [];
  let budget = chatLimits.pollBytes;
  let files = 0;
  let last = after;
  for (const message of listed) {
    // Once the poll's files or bytes are used up, stop at a message boundary: the rest come next time.
    if (files >= chatLimits.filesPerPoll || budget <= 0) break;
    last = message.id;
    if (String(message.sender_email ?? "").toLowerCase() === String(parameters.botEmail).toLowerCase()) continue;
    const entry = { id: message.id, topic: String(message.subject ?? message.topic ?? "").slice(0, 60), sender: String(message.sender_full_name ?? "").slice(0, 80), content: String(message.content ?? "").slice(0, 10_000), files: [] };
    for (const upload of uploadsIn(message.content)) {
      if (files >= chatLimits.filesPerPoll) break;
      files += 1;
      const kind = uploadKind(upload.file) ?? uploadKind(upload.name);
      if (!kind) { entry.files.push({ name: upload.name, skipped: "not a PDF, Markdown, text or image file" }); continue; }
      try {
        const bytes = await client.download(upload, Math.min(chatLimits.fileBytes, budget) + 1);
        if (bytes.length > chatLimits.fileBytes) { entry.files.push({ name: upload.name, skipped: "larger than 5 MB" }); continue; }
        budget -= bytes.length;
        entry.files.push({ name: upload.name, kind, path: upload.path, bytes: bytes.toString("base64") });
      } catch (error) {
        entry.files.push({ name: upload.name, skipped: /larger than/.test(error?.message ?? "") ? "larger than 5 MB" : error instanceof ZulipError ? error.message : "it could not be downloaded" });
      }
    }
    messages.push(entry);
  }
  log(`Read ${messages.length} ${messages.length === 1 ? "message" : "messages"} and ${files} ${files === 1 ? "file" : "files"} from #${parameters.channel}`, "stdout");
  const more = (listed.length > 0 && last !== listed.at(-1).id) || answer.found_newest === false;
  return { messages, last, more };
}
