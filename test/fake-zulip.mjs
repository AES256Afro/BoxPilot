/**
 * A stand-in for Zulip's REST API (M38), for the tests of the agents' team chat: the few endpoints
 * BoxPilot's root tasks use, on a loopback port, answering the way Zulip 12 answers. It checks what
 * the owner's server would: HTTP basic auth with the bot's key, Zulip's own name in the Host header
 * and the HTTPS Tailscale Serve forwards (X-Forwarded-Proto), and it records every request.
 *
 *   const zulip = await startFakeZulip({ host: "homebox.tail1234.ts.net:8543" });
 *   zulip.addBot("boxpilot-agents-bot@homebox.tail1234.ts.net", "a".repeat(32));
 *   const path = zulip.addUpload("notes.md", Buffer.from("# Notes"));
 *   zulip.postAs("owner@example.com", "agent-files", "router", `the router [notes.md](${path})`);
 *   ... zulip.base is http://127.0.0.1:<port>; zulip.messages("agent-findings") is what was posted.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

export async function startFakeZulip({ host = "homebox.tail1234.ts.net:8543", realmId = 2 } = {}) {
  const users = new Map();
  const channels = new Map();
  const uploads = new Map();
  const temporary = new Map();
  const requests = [];
  // M40.5: direct messages, and each user's event queues (Zulip keeps them per client).
  const directs = [];
  const queues = new Map();
  let nextId = 100;
  let nextEvent = 0;

  const json = (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  const channel = (name) => { if (!channels.has(name)) channels.set(name, []); return channels.get(name); };
  const whoIs = (request) => {
    const match = /^Basic (.+)$/.exec(request.headers.authorization ?? "");
    if (!match) return null;
    const [email, key] = Buffer.from(match[1], "base64").toString("utf8").split(":");
    const user = users.get(email);
    return user && user.key === key ? user : null;
  };

  function addUser(email, key, { bot = false, name = email.split("@")[0] } = {}) {
    users.set(email, { email, key, is_bot: bot, full_name: name, user_id: users.size + 10 });
  }
  function addUpload(name, bytes) {
    const path = `/user_uploads/${realmId}/${randomBytes(2).toString("hex")}/${randomBytes(6).toString("hex")}/${encodeURIComponent(name)}`;
    uploads.set(path, { name, bytes: Buffer.from(bytes) });
    return path;
  }
  /** A message reaches every event queue of the users it is for, with its flags, as Zulip's do. */
  function deliver(message, recipients) {
    for (const queue of queues.values()) {
      const user = users.get(queue.email);
      if (!user || !recipients.includes(user.email)) continue;
      const flags = new RegExp(`@_?\\*\\*${user.full_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\|\\d+)?\\*\\*`).test(message.content) ? ["mentioned"] : [];
      queue.events.push({ id: nextEvent++, type: "message", message, flags });
    }
  }
  function postAs(email, name, topic, content) {
    const user = users.get(email) ?? { email, full_name: email.split("@")[0], user_id: null };
    const message = { id: nextId++, type: "stream", sender_id: user.user_id, sender_email: email, sender_full_name: user.full_name, display_recipient: name, subject: topic, content, timestamp: Math.floor(Date.now() / 1000) };
    channel(name).push(message);
    // Every user in this fake is in every channel.
    deliver(message, [...users.keys()].filter((address) => address !== email));
    return message;
  }
  /** A direct message from one person to others (M40.5), by their addresses. */
  function directAs(email, toEmails, content) {
    const everyone = [email, ...toEmails].map((address) => users.get(address)).filter(Boolean);
    const sender = users.get(email);
    const message = { id: nextId++, type: "private", sender_id: sender?.user_id ?? null, sender_email: email, sender_full_name: sender?.full_name ?? email, display_recipient: everyone.map((user) => ({ id: user.user_id, email: user.email, full_name: user.full_name })), subject: "", content, timestamp: Math.floor(Date.now() / 1000) };
    directs.push(message);
    deliver(message, toEmails);
    return message;
  }

  async function body(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://zulip.invalid");
    const raw = await body(request);
    requests.push({ method: request.method, path: url.pathname, host: request.headers.host, proto: request.headers["x-forwarded-proto"] ?? null, authorization: request.headers.authorization ?? null, body: raw.toString("utf8").slice(0, 20_000) });
    if (request.headers.host !== host) return json(response, 400, { result: "error", msg: `Invalid host ${request.headers.host}` });
    // A file handed out through a temporary address needs no key, as in Zulip.
    const handedOut = /^\/user_uploads\/temporary\/([a-z0-9]+)\//.exec(url.pathname);
    if (handedOut) {
      const path = temporary.get(handedOut[1]);
      if (!path) return json(response, 404, { result: "error", msg: "Not found" });
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      return response.end(uploads.get(path).bytes);
    }
    const user = whoIs(request);
    if (!user) return json(response, 401, { result: "error", msg: "Invalid API key", code: "INVALID_API_KEY" });
    if (url.pathname === "/api/v1/users/me" && request.method === "GET") return json(response, 200, { result: "success", msg: "", email: user.email, full_name: user.full_name, is_bot: user.is_bot, user_id: user.user_id });
    if (url.pathname === "/api/v1/messages" && request.method === "POST" && new URLSearchParams(raw.toString("utf8")).get("type") === "direct") {
      const form = new URLSearchParams(raw.toString("utf8"));
      let ids = [];
      try { ids = JSON.parse(form.get("to") ?? "[]"); } catch { ids = []; }
      const to = [...users.values()].filter((entry) => ids.includes(entry.user_id)).map((entry) => entry.email);
      if (!to.length) return json(response, 400, { result: "error", msg: "Invalid user ID" });
      const message = directAs(user.email, to, form.get("content") ?? "");
      return json(response, 200, { result: "success", msg: "", id: message.id });
    }
    if (url.pathname === "/api/v1/register" && request.method === "POST") {
      const id = `fake:${randomBytes(6).toString("hex")}`;
      queues.set(id, { email: user.email, events: [], opened: nextEvent });
      return json(response, 200, { result: "success", msg: "", queue_id: id, last_event_id: nextEvent - 1 });
    }
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      const queue = queues.get(url.searchParams.get("queue_id"));
      if (!queue || queue.email !== user.email) return json(response, 400, { result: "error", msg: `Bad event queue ID: ${url.searchParams.get("queue_id")}`, code: "BAD_EVENT_QUEUE_ID" });
      const last = Number(url.searchParams.get("last_event_id") ?? -1);
      return json(response, 200, { result: "success", msg: "", events: queue.events.filter((event) => event.id > last), queue_id: url.searchParams.get("queue_id") });
    }
    if (url.pathname === "/api/v1/messages" && request.method === "POST") {
      const form = new URLSearchParams(raw.toString("utf8"));
      if (form.get("type") !== "stream" || !form.get("to") || !form.get("topic")) return json(response, 400, { result: "error", msg: "Missing channel or topic" });
      if (!channels.has(form.get("to"))) return json(response, 400, { result: "error", msg: `Channel '${form.get("to")}' does not exist` });
      const message = postAs(user.email, form.get("to"), form.get("topic"), form.get("content") ?? "");
      return json(response, 200, { result: "success", msg: "", id: message.id });
    }
    if (url.pathname === "/api/v1/messages" && request.method === "GET" && /"operand":"(dm|mentioned)"/.test(url.searchParams.get("narrow") ?? "")) {
      // What was asked of this user: direct messages to them, or messages that mention them.
      const operand = /"operand":"(dm|mentioned)"/.exec(url.searchParams.get("narrow"))[1];
      const after = Number(url.searchParams.get("anchor") ?? 0);
      const count = Number(url.searchParams.get("num_after") ?? 0);
      const mention = new RegExp(`@_?\\*\\*${user.full_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*`);
      const found = operand === "dm"
        ? directs.filter((message) => message.id > after && message.display_recipient.some((entry) => entry.email === user.email))
        : [...channels.values()].flat().filter((message) => message.id > after && mention.test(message.content)).map((message) => ({ ...message, flags: ["mentioned"] }));
      return json(response, 200, { result: "success", msg: "", messages: found.sort((a, b) => a.id - b.id).slice(0, count), found_newest: found.length <= count });
    }
    if (url.pathname === "/api/v1/messages" && request.method === "GET") {
      const narrow = JSON.parse(url.searchParams.get("narrow") ?? "[]");
      const wanted = narrow.find((entry) => entry.operator === "channel" || entry.operator === "stream")?.operand;
      const anchor = url.searchParams.get("anchor");
      const after = anchor === "oldest" ? 0 : Number(anchor);
      const count = Number(url.searchParams.get("num_after") ?? 0);
      const all = channel(wanted).filter((message) => message.id > after);
      return json(response, 200, { result: "success", msg: "", messages: all.slice(0, count), found_newest: all.length <= count });
    }
    if (url.pathname === "/api/v1/user_uploads" && request.method === "POST") {
      const text = raw.toString("utf8");
      const name = /filename="([^"]+)"/.exec(text)?.[1] ?? "file";
      const start = text.indexOf("\r\n\r\n") + 4;
      const end = text.lastIndexOf("\r\n--");
      const path = addUpload(name, Buffer.from(text.slice(start, end), "utf8"));
      return json(response, 200, { result: "success", msg: "", uri: path, url: path, filename: name });
    }
    const asked = /^\/api\/v1(\/user_uploads\/\d+\/.+)$/.exec(url.pathname);
    if (asked && request.method === "GET") {
      if (!uploads.has(asked[1])) return json(response, 404, { result: "error", msg: "Not found" });
      const token = randomBytes(8).toString("hex");
      temporary.set(token, asked[1]);
      return json(response, 200, { result: "success", msg: "", url: `/user_uploads/temporary/${token}/${asked[1].split("/").pop()}` });
    }
    return json(response, 404, { result: "error", msg: `No route ${request.method} ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port, host, base: `http://127.0.0.1:${port}`, realmId, requests,
    addBot: (email, key) => addUser(email, key, { bot: true, name: "BoxPilot agents" }),
    addPerson: (email, key, name) => addUser(email, key, { bot: false, name }),
    addChannel: (name) => { channel(name); },
    addUpload, postAs, directAs,
    messages: (name) => [...channel(name)],
    /** Direct messages that include this address (M40.5). */
    directsWith: (email) => directs.filter((message) => message.display_recipient.some((entry) => entry.email === email)),
    /** Zulip drops a queue after ten quiet minutes: this drops them all now. */
    expireQueues: () => queues.clear(),
    userId: (email) => users.get(email)?.user_id ?? null,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
