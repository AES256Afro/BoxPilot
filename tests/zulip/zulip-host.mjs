#!/usr/bin/env node
/**
 * Zulip on a real Docker host (M38), for .github/workflows/zulip-host.yml. It installs
 * catalog/zulip.yaml with BoxPilot's own deployer and its registered install operation, as the
 * helper does on the owner's server - tailnet only, then published with Tailscale Serve (a stand-in,
 * tests/zulip/fake-tailscale.mjs) - and then asks for the organization link with the registered
 * operation and opens it as Serve would forward a browser to it. Then the agents (M38.2): an
 * organization made with create_realm (this test only), Connect run twice with the real script,
 * a finding and a trace posted as the bot, and a file the owner drops in #agent-files read back.
 * Then two-way chat (M40.5): the owner, mapped to their BoxPilot account, sends the bot a direct
 * message; the bot's event queue is read with the real task, the Server Keeper answers on the fake
 * model, and the answer is posted back in the same direct message with its link to BoxPilot.
 * What each container uses is written to the job's summary.
 *
 *   BOXPILOT_TAILSCALE_BINARY=tests/zulip/fake-tailscale.mjs node tests/zulip/zulip-host.mjs <workdir>
 *
 * It stops at the first thing that is not as the owner's server needs it, and says which.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAppHelper } from "../../server/app-helper.mjs";
import { findingMessage, traceMessage } from "../../server/agents/zulip.mjs";
import { finalRedaction } from "../../server/assistant/prompt.mjs";
import { createCredentialStore } from "../../server/credentials.mjs";
import { fixedRun } from "../../server/exec.mjs";
import { appOperations } from "../../server/ops/apps.mjs";
import { zulipManagePy, zulipOperations } from "../../server/ops/zulip.mjs";
import { createRedactor } from "../../server/redaction.mjs";
import { zulipCheck, zulipClient, zulipEvents, zulipPoll, zulipPost } from "../../server/tasks/zulip.mjs";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

const redactor = createRedactor();
const redact = (text) => finalRedaction(text, redactor);

const workdir = path.resolve(process.argv[2] ?? "zulip-host");
const catalogRoot = path.join(workdir, "catalog");
const backupRoot = path.join(workdir, "backups");
mkdirSync(catalogRoot, { recursive: true });
mkdirSync(backupRoot, { recursive: true });

const operations = Object.fromEntries([...appOperations(), ...zulipOperations()].map((operation) => [operation.id, operation]));
const apps = createAppHelper({ catalogRoot, backupRoot, lanAddress: "127.0.0.1", tailscaleBinary: process.env.BOXPILOT_TAILSCALE_BINARY });
const progress = (line) => console.error(`  ${line}`);
const summary = [];
const say = (line = "") => { console.log(line); summary.push(line); };
const fail = (message) => { say(`FAILED: ${message}`); flush(); process.exit(1); };
function flush() { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`); }
const docker = (args, timeout = 60_000) => fixedRun("/usr/bin/docker", args, { timeout, maxBuffer: 8 * 1024 * 1024 });

/** A request to Zulip's port as Tailscale Serve sends one: HTTPS forwarded, under Zulip's own name. */
function throughServe(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: host, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.9" }, timeout: 30_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

export async function resourceUse() {
  const stats = await docker(["stats", "--no-stream", "--format", "json"]);
  const rows = String(stats.stdout).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => /^bp-zulip/.test(row.Name));
  const images = await docker(["image", "ls", "--format", "json"]);
  const sizes = String(images.stdout).split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => /zulip|memcached|rabbitmq|redis/.test(row.Repository));
  // As root: the database and the queue belong to their containers' users.
  const disk = await fixedRun("/usr/bin/sudo", ["-n", "/usr/bin/du", "-sh", path.join(catalogRoot, "zulip")], { timeout: 60_000 });
  return { rows, sizes, disk: String(disk.stdout).split("\t")[0] || "unknown" };
}

export function describeUse({ rows, sizes, disk }) {
  const lines = ["| Container | Memory | CPU |", "| --- | --- | --- |", ...rows.map((row) => `| ${row.Name} | ${String(row.MemUsage).split("/")[0].trim()} | ${row.CPUPerc} |`)];
  lines.push("", "| Image | Size |", "| --- | --- |", ...sizes.map((row) => `| ${row.Repository}:${row.Tag} | ${row.Size} |`), "", `Zulip's project folder (database, uploads, queue): ${disk}`);
  return lines;
}

say("## Zulip on a real Docker host");
say();
const started = Date.now();
let installed;
try {
  installed = await operations["app.install"].run({ id: "zulip", values: { env: { SETTING_ZULIP_ADMINISTRATOR: "owner@example.com" } } }, { apps, run: fixedRun, progress, timeScale: 2 });
} catch (error) {
  const logs = await docker(["compose", "--project-name", "bp-zulip", "--file", path.join(catalogRoot, "zulip", "compose.yaml"), "--env-file", path.join(catalogRoot, "zulip", ".env"), "logs", "--tail", "80"], 120_000).catch(() => ({ stdout: "" }));
  console.error(logs.stdout);
  fail(`the install failed: ${error.message}`);
}
say(`Installed in ${Math.round((Date.now() - started) / 1000)} s: ${installed.health} (${installed.hostPorts.map((port) => `${port.id} ${port.host} ${port.exposure}`).join(", ")}).`);
if (installed.exposure !== "tailnet") fail(`it was installed for ${installed.exposure}, not the tailnet only`);
if (!installed.served || installed.warnings) fail(`it was not published with Serve: ${JSON.stringify(installed.warnings ?? installed.urls)}`);
say(`Published at ${installed.urls.join(", ")} (Serve stand-in).`);

// #323: the port Serve fronts is on 127.0.0.1 and nothing else.
const port = installed.hostPorts[0].host;
const bound = await docker(["port", "bp-zulip"]);
say(`docker port bp-zulip: ${String(bound.stdout).trim().replace(/\n/g, "; ")}`);
if (!/^80\/tcp -> 127\.0\.0\.1:\d+$/m.test(String(bound.stdout)) || /0\.0\.0\.0|\[::\]/.test(String(bound.stdout))) fail("Zulip's web port is published somewhere other than 127.0.0.1");

// Zulip keeps /health to itself (its nginx answers it only from inside); its public settings
// answer anyone, so they show a request through Serve reaches Zulip and is taken as HTTPS.
const served = await throughServe(port, "/api/v1/server_settings", `boxpilot-ci.example-tailnet.ts.net:${port}`);
let version = null;
try { version = JSON.parse(served.body).zulip_version ?? null; } catch { version = null; }
say(`/api/v1/server_settings through Serve's headers: ${served.status}${version ? `, Zulip ${version}` : ""}`);
if (served.status !== 200 || !version) fail(`Zulip did not answer through Serve's headers (${served.status}): ${served.body.slice(0, 200)}`);

const made = await operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps, progress }).catch((error) => fail(`Create your organization failed: ${error.message}`));
const link = new URL(made.link);
say(`Create your organization: a link to https://${link.host}/new/… (${made.expiresInDays} days).`);
if (link.host !== `boxpilot-ci.example-tailnet.ts.net:${port}`) fail(`the link is for ${link.host}, not Zulip's Serve address`);
const form = await throughServe(port, link.pathname, link.host);
say(`Opening it through Serve's headers: ${form.status}${/organization/i.test(form.body) ? ", the organization form" : ""}.`);
if (form.status !== 200 || !/organization/i.test(form.body)) fail(`the creation link answered ${form.status} without the organization form`);

// ---- M38.2: the agents in Zulip ----
// The organization is made the way only this test makes one: manage.py create_realm with no
// password. On the owner's server it is the owner, through the link above.
say();
say("### The agents in Zulip");
say();
const realm = await apps.execIn({ id: "zulip", user: "zulip", argv: [zulipManagePy, "create_realm", "CI house", "owner@example.com", "CI Owner"], timeoutMs: 120_000 });
if (!realm.ok) fail(`create_realm failed: ${realm.stderr.split("\n").slice(-3).join(" ")}`);
// Once there is an organization, Create your organization says where to sign in instead.
const refusedLink = await operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps, progress }).then(() => null, (error) => error.message);
say(`Create your organization with one already there: ${refusedLink ?? "a link was made"}`);
if (!/already has an organization, CI house: sign in at https:\/\//.test(refusedLink ?? "")) fail("Create your organization did not see the organization list_realms named");
const credentials = createCredentialStore({ file: path.join(workdir, "credentials.json") });
const taskTable = { "agents.zulip.check": zulipCheck, "agents.zulip.post": zulipPost, "agents.zulip.poll": zulipPoll };
const runUnit = { runTask: (task, parameters) => taskTable[task](parameters, { credentials, log: progress }) };
const context = { apps, credentials, runUnit, progress };

const first = await operations["agents.zulip.connect"].run({ boxpilotUrl: "https://boxpilot-ci.example-tailnet.ts.net" }, context).catch((error) => fail(`Connect failed: ${error.message}`));
say(`Connect: the bot ${first.botEmail} ${first.botCreated ? "made" : "reused"}; channels made: ${first.made.map((name) => `#${name}`).join(", ") || "none"}.`);
if (!first.botCreated || first.made.length !== 4 || first.public.length) fail(`the first Connect should make the bot and four private channels: ${JSON.stringify(first)}`);
const again = await operations["agents.zulip.connect"].run({}, context).catch((error) => fail(`Connecting again failed: ${error.message}`));
say(`Connect again: the bot ${again.botCreated ? "made" : "reused"}; channels made: ${again.made.length}.`);
if (again.botCreated || again.made.length) fail("connecting again made something that was already there");
const key = await credentials.read("zulip-agents-bot");
if (JSON.stringify([first, again, summary]).includes(key)) fail("the bot's key reached a result or the summary");
const where = { base: `http://127.0.0.1:${first.port}`, host: first.host, botEmail: first.botEmail };

// A run's outcome, as the service posts it: a finding with a mention it must not make, and a trace as a file.
const run = { id: "c1c1c1c1-0000-4000-8000-000000000001", kind: "ask", state: "completed", question: "How full is the disk?", answer: "The disk is 42% full [T1]. @**all** password=hunter2", usage: { wallMs: 90_000, toolCalls: 1 } };
const trace = traceMessage({ agentName: "Server Keeper", run, steps: Array.from({ length: 40 }, (_value, index) => ({ seq: index + 1, kind: "tool", name: "storage.health", state: "done", output: `line ${index}` })), redact });
const posted = await operations["agents.zulip.post"].run({ ...where, posts: [
  { id: "c1c1c1c1-0000-4000-8000-000000000011", channel: "agent-findings", topic: "Server Keeper", content: findingMessage({ agentName: "Server Keeper", run, redact }) },
  { id: "c1c1c1c1-0000-4000-8000-000000000012", channel: "agent-logs", topic: "Server Keeper", content: trace.content, attachment: trace.attachment },
] }, context);
say(`Posted: ${posted.results.map((result) => (result.ok ? `message ${result.messageId}` : result.error)).join("; ")}.`);
if (!posted.results.every((result) => result.ok)) fail("a post was refused");

// The owner drops a file in #agent-files, as a person would, with their own key.
const ownerKey = await apps.execIn({ id: "zulip", user: "zulip", argv: [zulipManagePy, "shell", "--command", "from zerver.models import UserProfile; print('OWNER_KEY', UserProfile.objects.get(delivery_email='owner@example.com').api_key)"], timeoutMs: 120_000 });
const ownerStore = { read: async () => /OWNER_KEY (\S+)/.exec(ownerKey.stdout)?.[1] ?? null };
const owner = await zulipClient({ ...where, botEmail: "owner@example.com", credentialName: "owner" }, { credentials: ownerStore });
const seen = await owner.messages({ channel: "agent-findings", after: null, count: 10 });
const finding = seen.messages.find((message) => message.sender_email === first.botEmail && /42% full/.test(message.content));
say(`The owner reads #agent-findings: ${finding ? "the finding is there" : "no finding"}${finding && !/@\*\*all\*\*/.test(finding.content) && !/hunter2/.test(finding.content) ? ", redacted and paging nobody" : ""}.`);
if (!finding || /@\*\*all\*\*|hunter2/.test(finding.content)) fail("the finding did not arrive as BoxPilot wrote it");
const uploaded = await owner.upload({ name: "router notes.md", text: "# Router\nThe router is upstairs in the office." });
await owner.send({ channel: "agent-files", topic: "network", content: `The router [router notes.md](${uploaded})` });
const read = await operations["agents.zulip.poll"].run({ ...where, channel: "agent-files", after: null }, context);
const file = read.messages.flatMap((message) => message.files).find((entry) => entry.name === "router notes.md");
say(`Reading #agent-files: ${read.messages.length} messages; "router notes.md" ${file?.bytes ? `came back (${Buffer.from(file.bytes, "base64").length} bytes)` : "did not come back"}.`);
if (!file?.bytes || !Buffer.from(file.bytes, "base64").toString("utf8").includes("upstairs")) fail("the dropped file did not come back as it was written");

// ---- M40.5: asking an agent in Zulip, a direct message there and back ----
// BoxPilot's own agents service (the stand-in model in place of Qwen), with the real root tasks
// reading the bot's event queue and posting the reply, against this real Zulip.
say();
say("### Asking an agent in Zulip");
say();
const h = await createAgentsHarness({ start: new Date(), serviceOptions: { chatOptions: { schedule: () => null } } });
try {
  const withKey = (parameters) => ({ ...parameters, credentialName: "zulip-agents-bot" });
  h.helperAnswers["agents.zulip.events"] = (parameters) => zulipEvents(withKey(parameters), { credentials, log: progress });
  h.helperAnswers["agents.zulip.post"] = (parameters) => zulipPost(withKey(parameters), { credentials, log: progress });
  h.helperAnswers["agents.zulip.poll"] = (parameters) => zulipPoll(withKey(parameters), { credentials, log: progress });
  h.enable();
  h.service.zulipConnected(first, { actorId: h.accounts.owner.id, boxpilotUrl: "https://boxpilot-ci.example-tailnet.ts.net" });
  h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
  const botSelf = await zulipCheck({ ...where, credentialName: "zulip-agents-bot" }, { credentials });
  const ownerSelf = await owner.me();
  // The owner lets their own Zulip account ask as their BoxPilot account.
  await h.service.setZulipPeople(h.caller("owner"), { people: [{ zulipId: ownerSelf.user_id, zulipEmail: "owner@example.com", zulipName: ownerSelf.full_name, boxpilotId: h.accounts.owner.id }] });
  // The first read opens the bot's event queue; then the owner asks in a direct message.
  const opened = await h.service.zulipPollNow(h.caller("owner"));
  say(`The bot's event queue: ${opened.asked?.error ? `not opened (${opened.asked.error})` : "opened"}.`);
  if (opened.asked?.error) fail(`the bot's event queue could not be read: ${opened.asked.error}`);
  const question = await owner.sendDirect({ to: [botSelf.userId], content: "What is this server called?" });
  const asked = await h.service.zulipPollNow(h.caller("owner"));
  const [run] = h.store.activeRuns();
  say(`The owner's direct message: ${asked.asked?.asked ?? 0} question asked; ${run ? `a run of the Server Keeper as ${run.readRole}, from ${run.trigger?.chat?.kind ?? "?"}` : "no run"}.`);
  if (!run || run.readRole !== "owner" || run.trigger?.chat?.kind !== "direct") fail("the direct message did not become the owner's question");
  await h.runNext();
  await h.service.chat.drain();
  const replies = await owner.since({ narrow: [{ operator: "is", operand: "dm" }], after: question.id, count: 10 });
  const reply = (replies.messages ?? []).find((message) => message.sender_email === first.botEmail);
  say(`The reply in the same direct message: ${reply ? `"${String(reply.content).split("\n")[0].slice(0, 120)}"` : "none"}.`);
  if (!reply || !/open the run in BoxPilot/.test(reply.content)) fail("the answer did not come back in the direct message with its link to BoxPilot");
  if (JSON.stringify(h.state.getSetting("agentsZulip")).includes(key)) fail("the bot's key reached BoxPilot's settings");
} finally {
  await h.close();
}

// Settle a minute, then say what it costs.
await new Promise((resolve) => setTimeout(resolve, 60_000));
say();
say("### What it uses, a minute after it came up");
say();
for (const line of describeUse(await resourceUse())) say(line);
flush();
