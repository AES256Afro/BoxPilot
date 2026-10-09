/**
 * Zulip (M38), the team chat the owner chose for the agents: what BoxPilot does inside the Zulip
 * app it installed from the catalog (catalog/zulip.yaml). App-specific because Zulip's own setup
 * is a management command run inside its container, not a setting.
 *
 * No account is ever made by BoxPilot with a password. The first organization, and its owner, come
 * from Zulip's own single-use creation link (`manage.py generate_realm_creation_link`, run as the
 * zulip user): the owner opens it and chooses their own name and password. The link is shown once,
 * to the person who ran the job, and never stored with it (the registry's oneTimeFields).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineOperation } from "./registry.mjs";
import { chatLimits, readChannelName, readTopic, zulipBot, zulipChannels, zulipCredentialName } from "../agents/zulip.mjs";

export const zulipAppId = "zulip";
/** The fixed script Connect runs through manage.py shell (M38.2): the bot and its channels. */
export const connectScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents", "zulip-connect.py");
export const zulipManagePy = "/home/zulip/deployments/current/manage.py";
/** Zulip's default for CAN_CREATE_REALM_LINK_VALIDITY_DAYS. */
export const creationLinkDays = 7;

const minutes = (count) => count * 60_000;
const withoutColours = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");

/** The single-use link generate_realm_creation_link printed, without its colours; null if none. */
export function readCreationLink(stdout) {
  const match = /https:\/\/[^\s"'<>]+\/new\/[a-z0-9]{16,64}/i.exec(withoutColours(stdout));
  return match ? match[0] : null;
}

/**
 * The organizations `manage.py list_realms` names, without Zulip's own internal one (its system
 * bots) and without deactivated ones (printed in colour).
 */
export function readRealms(stdout) {
  const realms = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (/\u001b\[/.test(line)) continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(.*?)\s+(https?:\/\/\S+)\s*$/.exec(line);
    if (!match || match[2] === "zulipinternal") continue;
    realms.push({ id: Number(match[1]), stringId: match[2] === "''" ? "" : match[2], name: match[3].trim(), url: match[4] });
  }
  return realms;
}

/** Why a manage.py call failed, in a sentence, from the end of what it printed; never its output. */
function failure(result, what) {
  if (result?.timedOut) return new Error(`${what} did not finish in time; Zulip may still be starting. Try again in a minute.`);
  const tail = withoutColours(result?.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? "";
  return new Error(`${what} failed${tail ? `: ${tail.slice(0, 300)}` : ""}`);
}

export function zulipOperations() {
  return [
    defineOperation({
      // medium, owner: whoever opens the link becomes the owner of the organization.
      id: "app.zulip.organization.link", title: "Create your Zulip organization", risk: "medium", minimumRole: "owner", timeoutMs: minutes(3),
      description: "Runs Zulip's own manage.py generate_realm_creation_link inside the Zulip container, as the zulip user, and shows you the single-use link it prints: open it to create your organization and your own account, with a name and password you choose. BoxPilot creates no account. The link is shown to you once, is not kept by BoxPilot, works once and expires after 7 days. Refused when Zulip already has an organization.",
      parameters: { exact: true, fields: { id: { type: "string", enum: [zulipAppId] } } },
      oneTimeFields: ["link"],
      run: async (_parameters, { apps, progress }) => {
        progress?.("Checking whether Zulip already has an organization", "stdout");
        const listed = await apps.execIn({ id: zulipAppId, user: "zulip", argv: [zulipManagePy, "list_realms"], timeoutMs: minutes(1) });
        if (!listed.ok) throw failure(listed, "Asking Zulip for its organizations");
        const existing = readRealms(listed.stdout);
        if (existing.length) throw new Error(`Zulip already has an organization, ${existing[0].name}: sign in at ${existing[0].url}. More organizations are made from Zulip's own settings, not here.`);
        progress?.("Asking Zulip for a single-use link to create your organization (the link is not written to this log)", "stdout");
        const made = await apps.execIn({ id: zulipAppId, user: "zulip", argv: [zulipManagePy, "generate_realm_creation_link"], timeoutMs: minutes(1) });
        if (!made.ok) throw failure(made, "generate_realm_creation_link");
        const link = readCreationLink(made.stdout);
        if (!link) throw new Error("Zulip ran generate_realm_creation_link but printed no link BoxPilot recognises; check the Zulip app's logs");
        progress?.(`Zulip made the link: it works once and expires after ${creationLinkDays} days`, "stdout");
        return { link, expiresInDays: creationLinkDays, host: new URL(link).host };
      },
    }),
    defineOperation({
      id: "agents.zulip.connect", title: "Connect the agents to Zulip", risk: "medium", minimumRole: "owner", timeoutMs: minutes(5),
      description: "Runs one fixed script with Zulip's own manage.py inside the Zulip container, as the zulip user: it makes a bot for BoxPilot's agents owned by your organization's owner (or reuses the one it made before), and makes four private channels only you and the bot are in - #agent-findings, #agent-logs, #agent-knowledge and #agent-files. The bot's key goes straight into BoxPilot's credential store; it is never shown or logged. Then it checks the key with Zulip and says hello in #agent-findings. Safe to run again: it repairs what is missing and changes nothing that is right.",
      parameters: { exact: true, fields: { boxpilotUrl: { type: "string", optional: true, nullable: true, maxLength: 200, pattern: /^https?:\/\/[A-Za-z0-9.-]{1,180}(?::\d{1,5})?$/ } } },
      run: async (_parameters, { apps, credentials, runUnit, jobLog, progress }) => {
        const { applications = [] } = await apps.inspect({ id: zulipAppId });
        const app = applications.find((entry) => entry.id === zulipAppId);
        if (!app?.installed) throw new Error("Zulip is not installed; install it from the App catalog first");
        if (!app.container?.running) throw new Error("Zulip is installed but not running; start it, then connect");
        const port = app.urls?.[0]?.host;
        if (!Number.isInteger(port)) throw new Error("Zulip has no web port BoxPilot can reach");
        progress?.("Making the agents' bot and channels with Zulip's own manage.py (the bot's key is not written to this log)", "stdout");
        const script = await readFile(connectScriptPath, "utf8");
        const channels = Object.values(zulipChannels).map((channel) => ({ name: channel.name, description: channel.description }));
        const made = await apps.execIn({ id: zulipAppId, user: "zulip", argv: [zulipManagePy, "shell", "--command", script], env: { BOXPILOT_BOT_SHORT_NAME: zulipBot.shortName, BOXPILOT_BOT_FULL_NAME: zulipBot.fullName, BOXPILOT_CHANNELS: JSON.stringify(channels) }, timeoutMs: minutes(3) });
        if (!made.ok) throw failure(made, "Zulip's manage.py");
        const found = readConnectResult(made.stdout);
        if (!found) throw new Error("Zulip's manage.py finished without saying what it made; check the Zulip app's logs");
        if (found.error === "no-organization") throw new Error("Zulip has no organization yet. On Zulip's sheet in the App catalog, choose Create your organization and finish it in Zulip, then connect.");
        if (found.error === "no-owner") throw new Error("Zulip's organization has no active owner to own the bot; make someone its owner in Zulip, then connect");
        if (found.error === "address-taken") throw new Error(`A person's account already has the bot's address (${found.bot}); rename or remove it in Zulip, then connect`);
        if (typeof found.apiKey !== "string" || !/^[A-Za-z0-9]{16,64}$/.test(found.apiKey) || typeof found.url !== "string") throw new Error("Zulip's manage.py did not give a bot key BoxPilot recognises");
        const site = new URL(found.url);
        await credentials.set({ name: zulipCredentialName, value: found.apiKey });
        progress?.(`The bot ${found.bot} ${found.botCreated ? "was made" : found.reactivated ? "was switched back on" : "was already there"}; its key is saved as the credential ${zulipCredentialName}`, "stdout");
        for (const channel of found.channels ?? []) progress?.(`#${channel.name}: ${channel.created ? "made" : "already there"}${channel.private ? ", private" : ", public: only the owner can make it private, in Zulip's channel settings"}`, "stdout");
        const checked = await runUnit.runTask("agents.zulip.check", {
          base: `http://127.0.0.1:${port}`, host: site.host, botEmail: found.bot, credentialName: zulipCredentialName,
          hello: { channel: zulipChannels.findings.name, topic: "BoxPilot", content: `**BoxPilot's agents are connected.** Their answers, digests and cards come to #**${zulipChannels.findings.name}**, each run's trace to #**${zulipChannels.logs.name}**, what they learn to #**${zulipChannels.knowledge.name}**. Drop files for them in #**${zulipChannels.files.name}**. Approvals happen in BoxPilot, never here.` },
        }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null });
        progress?.(`Zulip accepted the key and ${checked?.hello ? "the bot said hello in" : "the bot can post to"} #${zulipChannels.findings.name}`, "stdout");
        return {
          connected: true, site: site.origin, host: site.host, port, realm: String(found.realm ?? "").slice(0, 120), realmId: Number.isInteger(found.realmId) ? found.realmId : null,
          botEmail: found.bot, botCreated: Boolean(found.botCreated), credential: zulipCredentialName,
          channels: Object.fromEntries(Object.entries(zulipChannels).map(([kind, channel]) => [kind, channel.name])),
          made: (found.channels ?? []).filter((channel) => channel.created).map((channel) => channel.name),
          public: (found.channels ?? []).filter((channel) => !channel.private).map((channel) => channel.name),
        };
      },
    }),
    defineOperation({
      id: "agents.zulip.disconnect", title: "Disconnect the agents from Zulip", risk: "low", minimumRole: "owner", timeoutMs: minutes(1),
      description: "Removes the agents' bot key from BoxPilot's credential store, so BoxPilot stops posting to Zulip and reading #agent-files. Nothing in Zulip is deleted: the bot, its channels and what was posted stay until you remove them there.",
      parameters: { exact: true, fields: {} },
      run: async (_parameters, { credentials }) => {
        const removed = await credentials.remove({ name: zulipCredentialName }).then(() => true, () => false);
        return { disconnected: true, keyRemoved: removed };
      },
    }),
    defineOperation({
      // Run by BoxPilot itself once the owner connected Zulip, as the TLS renewal runs its operation:
      // the model never posts, and no agent proposes it (internal). Its own lane, so a post never
      // waits behind an app backup or an upgrade.
      id: "agents.zulip.post", title: "Post the agents' outcomes to Zulip", risk: "low", minimumRole: "owner", timeoutMs: minutes(2), internal: true,
      description: "Sends what BoxPilot's agents finished - answers, digests, cards, run traces and notes, already redacted - to the Zulip channels Connect made, as the agents' bot, on this server's loopback address. Nothing leaves the server.",
      parameters: { exact: true, fields: { ...connectionFields, posts: { type: "array", validate: validPosts } } },
      run: async (parameters, { apps, runUnit, jobLog }) => runUnit.runTask("agents.zulip.post", { ...parameters, base: await zulipBase(apps), credentialName: zulipCredentialName }, { timeoutMs: minutes(1.5), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      // owner (ADR-003): it reads what people wrote to the bot, with its key, as root. M40.5.
      id: "agents.zulip.events", title: "Read what was asked of the agents in Zulip", risk: "low", readOnly: true, minimumRole: "owner", timeoutMs: minutes(1), internal: true,
      description: "Reads the agents' bot's event queue in Zulip without waiting - direct messages to the bot, and messages that mention it - opening the queue again when Zulip has let it expire, and reading back what was asked since the last message BoxPilot handled. Nothing in Zulip is changed.",
      parameters: {
        exact: true,
        fields: {
          ...connectionFields,
          queueId: { type: "string", nullable: true, optional: true, maxLength: 120, pattern: /^[A-Za-z0-9:_.-]{1,120}$/ },
          lastEventId: { type: "number", nullable: true, optional: true, validate: (value) => (Number.isInteger(value) && value >= -1 ? null : "must be an event id") },
          after: { type: "number", nullable: true, optional: true, validate: (value) => (Number.isInteger(value) && value >= 0 ? null : "must be a message id") },
          catchUpMinutes: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 120 ? null : "must be 1 to 120 minutes") },
        },
      },
      run: async (parameters, { apps, runUnit }) => runUnit.runTask("agents.zulip.events", { ...parameters, base: await zulipBase(apps), credentialName: zulipCredentialName }, { timeoutMs: 50_000 }),
    }),
    defineOperation({
      // owner (ADR-003): it reads what people wrote in #agent-files, with the bot's key, as root.
      id: "agents.zulip.poll", title: "Read #agent-files in Zulip", risk: "low", readOnly: true, minimumRole: "owner", timeoutMs: minutes(3), internal: true,
      description: "Reads the messages in #agent-files after the last one BoxPilot read, as the agents' bot, and downloads the files they link to - PDFs, Markdown, text and images, 5 MB each at most - for the agents' Knowledge. Nothing in Zulip is changed.",
      parameters: { exact: true, fields: { ...connectionFields, channel: { type: "string", validate: (value) => (readChannelName(value) ? null : "must be a channel name") }, after: { type: "number", nullable: true, validate: (value) => (Number.isInteger(value) && value >= 0 ? null : "must be a message id") } } },
      run: async (parameters, { apps, runUnit }) => runUnit.runTask("agents.zulip.poll", { ...parameters, base: await zulipBase(apps), credentialName: zulipCredentialName }, { timeoutMs: minutes(2.5) }),
    }),
  ];
}

/**
 * Who Zulip is to the bot: its own name and the bot's address, as Connect found them. Where it is,
 * is not a parameter (2026-10 sweep 2): any http://127.0.0.1:<port> was accepted, and the bot's key
 * goes out with every request (Basic auth), so a card naming another container's port sent it
 * there. Each task is given the port the Zulip app itself publishes (zulipBase).
 */
const connectionFields = {
  host: { type: "string", maxLength: 260, pattern: /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/ },
  botEmail: { type: "string", maxLength: 300, pattern: /^[^\s@]{1,100}@[^\s@]{1,200}$/ },
};

/** Zulip's own address on this server: the loopback port its app publishes, as Connect reads it. */
async function zulipBase(apps) {
  const { applications = [] } = await apps.inspect({ id: zulipAppId });
  const app = applications.find((entry) => entry.id === zulipAppId);
  if (!app?.installed) throw new Error("Zulip is not installed; nothing was sent to it");
  const port = app.urls?.[0]?.host;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Zulip has no web port BoxPilot can reach; nothing was sent to it");
  return `http://127.0.0.1:${port}`;
}

/** A batch of posts as the service queues them: bounded in number, size and shape. */
function validPosts(posts) {
  if (!Array.isArray(posts) || !posts.length || posts.length > chatLimits.batchPosts) return `must list 1 to ${chatLimits.batchPosts} posts`;
  if (Buffer.byteLength(JSON.stringify(posts)) > chatLimits.batchBytes + 8_192) return "is too large for one batch";
  for (const post of posts) {
    if (!post || typeof post !== "object" || Array.isArray(post)) return "each post must be an object";
    if (Object.keys(post).some((key) => !["id", "channel", "topic", "content", "attachment", "to"].includes(key))) return "a post has a field it may not";
    if (typeof post.id !== "string" || !/^[0-9a-f-]{36}$/.test(post.id)) return "each post needs its id";
    // A reply to a direct message (M40.5) goes to the people in it, by their Zulip ids; the rest to a channel.
    if (post.to !== undefined && post.to !== null) {
      if (!Array.isArray(post.to) || !post.to.length || post.to.length > 8 || !post.to.every((id) => Number.isInteger(id) && id > 0)) return "a direct reply names one to eight people by their Zulip ids";
    } else {
      if (!readChannelName(post.channel)) return "each post needs a channel name";
      if (!readTopic(post.topic)) return "each post needs a topic of one line";
    }
    if (typeof post.content !== "string" || !post.content.trim() || post.content.length > 9_000) return "each post's text must be 1 to 9,000 characters";
    if (post.attachment !== undefined && post.attachment !== null) {
      if (typeof post.attachment !== "object" || typeof post.attachment.name !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(post.attachment.name) || typeof post.attachment.text !== "string" || post.attachment.text.length > chatLimits.attachmentChars) return "an attachment is a named text of at most 48,000 characters";
    }
  }
  return null;
}

/** What the connect script printed: its one result line, parsed; null when there is none. */
export function readConnectResult(stdout) {
  const line = String(stdout ?? "").split("\n").reverse().find((entry) => entry.startsWith("BOXPILOT_ZULIP_RESULT "));
  if (!line) return null;
  try { return JSON.parse(line.slice("BOXPILOT_ZULIP_RESULT ".length)); } catch { return null; }
}
