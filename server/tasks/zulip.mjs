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
      const sent = await client.send({ channel: post.channel, topic: post.topic, content: content.slice(0, 9_800) });
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
