import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { validatePlan } from "../assistant/plan.mjs";
import { loadCatalog } from "../catalog/index.mjs";
import { laneFor } from "../helper-lanes.mjs";
import { registry } from "./index.mjs";
import { connectScriptPath, readConnectResult, readCreationLink, readRealms, zulipManagePy, zulipOperations } from "./zulip.mjs";

const operations = Object.fromEntries(zulipOperations().map((operation) => [operation.id, operation]));
const link = "https://homebox.tail1234.ts.net:8543/new/abcdefghij2345klmnopqrst";
// What generate_realm_creation_link prints: Django's colours around the link.
const printed = `\u001b[32;1mPlease visit the following secure single-use link to register your \u001b[0m\n\u001b[32;1mnew Zulip organization:\u001b[0m\u001b[0m\n\n\u001b[32;1m    \u001b[1;92m${link}\u001b[0m\u001b[0m\n\n`;
const noRealms = "id    string_id            name                           domain                                            \n--    ---------            ----                           ------                                            \n1     zulipinternal        System bot realm               https://homebox.tail1234.ts.net:8543                \n";

function fakeApps(answers) {
  const execIn = vi.fn(async ({ argv }) => answers[argv[1]] ?? { ok: false, stdout: "", stderr: "unknown command" });
  return { execIn };
}

describe("Zulip's organization link", () => {
  it("reads the link out of the colours, and the organizations out of list_realms", () => {
    expect(readCreationLink(printed)).toBe(link);
    expect(readCreationLink("no link here")).toBeNull();
    expect(readRealms(noRealms)).toEqual([]);
    expect(readRealms(`${noRealms}2     ''                   Our house                      https://homebox.tail1234.ts.net:8543\n`)).toEqual([{ id: 2, stringId: "", name: "Our house", url: "https://homebox.tail1234.ts.net:8543" }]);
    // A deactivated organization is printed in red and does not count.
    expect(readRealms(`${noRealms}\u001b[31;1m3     old                  Old one                        https://old.homebox.tail1234.ts.net:8543\u001b[0m\n`)).toEqual([]);
  });

  it("runs manage.py as the zulip user, returns the link and never writes it to the job's log", async () => {
    const apps = fakeApps({ list_realms: { ok: true, stdout: noRealms, stderr: "" }, generate_realm_creation_link: { ok: true, stdout: printed, stderr: "" } });
    const lines = [];
    const result = await operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps, progress: (line) => lines.push(line) });
    expect(result).toEqual({ link, expiresInDays: 7, host: "homebox.tail1234.ts.net:8543" });
    expect(apps.execIn.mock.calls.map(([call]) => [call.id, call.user, call.argv])).toEqual([
      ["zulip", "zulip", [zulipManagePy, "list_realms"]],
      ["zulip", "zulip", [zulipManagePy, "generate_realm_creation_link"]],
    ]);
    expect(lines.join("\n")).not.toContain("/new/");
  });

  it("refuses when Zulip already has an organization, and says where to sign in", async () => {
    const apps = fakeApps({ list_realms: { ok: true, stdout: `${noRealms}2     ''                   Our house                      https://homebox.tail1234.ts.net:8543\n`, stderr: "" } });
    await expect(operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps })).rejects.toThrow("Zulip already has an organization, Our house: sign in at https://homebox.tail1234.ts.net:8543.");
    expect(apps.execIn).toHaveBeenCalledTimes(1);
  });

  it("says why when Zulip cannot answer, without its output", async () => {
    const apps = fakeApps({ list_realms: { ok: false, stdout: "secret-looking stdout", stderr: "django.db.utils.OperationalError: connection refused\n" } });
    await expect(operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps })).rejects.toThrow("Asking Zulip for its organizations failed: django.db.utils.OperationalError: connection refused");
    const noLink = fakeApps({ list_realms: { ok: true, stdout: noRealms, stderr: "" }, generate_realm_creation_link: { ok: true, stdout: "Something else", stderr: "" } });
    await expect(operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps: noLink })).rejects.toThrow("printed no link");
  });

  it("is the owner's, medium risk, for Zulip only, and its link is shown once", () => {
    const operation = registry.get("app.zulip.organization.link");
    expect(operation).toMatchObject({ risk: "medium", minimumRole: "owner", readOnly: false, oneTimeFields: ["link"] });
    expect(registry.validate("app.zulip.organization.link", { id: "zulip" })).toBeNull();
    expect(registry.validate("app.zulip.organization.link", { id: "mattermost" })).toMatch(/must be one of zulip/);
    expect(registry.validate("app.zulip.organization.link", { id: "zulip", extra: 1 })).toMatch(/does not accept/);
  });
});

describe("connecting the agents to Zulip (M38)", () => {
  const key = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
  const printed = (fields) => `Some Django warning\nBOXPILOT_ZULIP_RESULT ${JSON.stringify(fields)}\n`;
  const made = { realm: "Our house", url: "https://homebox.tail1234.ts.net:8543", realmId: 2, bot: "boxpilot-agents-bot@homebox.tail1234.ts.net", apiKey: key, botCreated: true, reactivated: false, channels: [
    { name: "agent-findings", created: true, private: true }, { name: "agent-logs", created: true, private: true }, { name: "agent-knowledge", created: false, private: true }, { name: "agent-files", created: true, private: true },
  ] };
  function setup({ installed = true, running = true, script = printed(made) } = {}) {
    const saved = new Map();
    const apps = {
      inspect: vi.fn(async () => ({ applications: [{ id: "zulip", installed, container: { running }, urls: installed ? [{ id: "web", host: 8543, exposure: "loopback" }] : [] }] })),
      execIn: vi.fn(async () => ({ ok: true, stdout: script, stderr: "" })),
    };
    const credentials = { set: vi.fn(async ({ name, value }) => { saved.set(name, value); return { name, replaced: false }; }), remove: vi.fn(async ({ name }) => { saved.delete(name); return { name, removed: true }; }) };
    const runUnit = { runTask: vi.fn(async () => ({ email: made.bot, isBot: true, hello: 101 })) };
    const lines = [];
    return { apps, credentials, runUnit, saved, lines, progress: (line) => lines.push(line) };
  }

  it("makes the bot and channels with manage.py as the zulip user, keeps the key in the credential store only, and checks it", async () => {
    const context = setup();
    const result = await operations["agents.zulip.connect"].run({ boxpilotUrl: "https://homebox.tail1234.ts.net" }, context);
    const call = context.apps.execIn.mock.calls[0][0];
    expect(call).toMatchObject({ id: "zulip", user: "zulip" });
    expect(call.argv.slice(0, 3)).toEqual([zulipManagePy, "shell", "--command"]);
    expect(call.argv[3]).toBe(await readFile(connectScriptPath, "utf8"));
    expect(JSON.parse(call.env.BOXPILOT_CHANNELS).map((channel) => channel.name)).toEqual(["agent-findings", "agent-logs", "agent-knowledge", "agent-files"]);
    expect(call.env).toMatchObject({ BOXPILOT_BOT_SHORT_NAME: "boxpilot-agents", BOXPILOT_BOT_FULL_NAME: "BoxPilot agents" });
    expect(context.saved.get("zulip-agents-bot")).toBe(key);
    expect(context.runUnit.runTask).toHaveBeenCalledWith("agents.zulip.check", expect.objectContaining({ base: "http://127.0.0.1:8543", host: "homebox.tail1234.ts.net:8543", botEmail: made.bot, credentialName: "zulip-agents-bot", hello: expect.objectContaining({ channel: "agent-findings" }) }), expect.anything());
    expect(result).toEqual({
      connected: true, site: "https://homebox.tail1234.ts.net:8543", host: "homebox.tail1234.ts.net:8543", port: 8543, realm: "Our house", realmId: 2,
      botEmail: made.bot, botCreated: true, credential: "zulip-agents-bot",
      channels: { findings: "agent-findings", logs: "agent-logs", knowledge: "agent-knowledge", files: "agent-files" },
      made: ["agent-findings", "agent-logs", "agent-files"], public: [],
    });
    // The key is in the store and nowhere else: not the result, not the job's log, not the task's parameters.
    expect(JSON.stringify(result)).not.toContain(key);
    expect(context.lines.join("\n")).not.toContain(key);
    expect(JSON.stringify(context.runUnit.runTask.mock.calls)).not.toContain(key);
  });

  it("is safe to run again: what exists is reused and said to be there", async () => {
    const again = setup({ script: printed({ ...made, botCreated: false, channels: made.channels.map((channel) => ({ ...channel, created: false })) }) });
    const result = await operations["agents.zulip.connect"].run({}, again);
    expect(result).toMatchObject({ botCreated: false, made: [] });
    expect(again.lines.join("\n")).toMatch(/was already there/);
    expect(again.lines.filter((line) => /already there, private/.test(line))).toHaveLength(4);
  });

  it("says what to do first when Zulip is not ready", async () => {
    await expect(operations["agents.zulip.connect"].run({}, setup({ installed: false }))).rejects.toThrow("Zulip is not installed");
    await expect(operations["agents.zulip.connect"].run({}, setup({ running: false }))).rejects.toThrow("not running");
    await expect(operations["agents.zulip.connect"].run({}, setup({ script: printed({ error: "no-organization" }) }))).rejects.toThrow("choose Create your organization");
    await expect(operations["agents.zulip.connect"].run({}, setup({ script: "nothing useful" }))).rejects.toThrow("without saying what it made");
    const noKey = setup({ script: printed({ ...made, apiKey: "short" }) });
    await expect(operations["agents.zulip.connect"].run({}, noKey)).rejects.toThrow("did not give a bot key");
    expect(noKey.saved.size).toBe(0);
  });

  it("disconnects by removing the key, and nothing in Zulip", async () => {
    const context = setup();
    context.saved.set("zulip-agents-bot", key);
    expect(await operations["agents.zulip.disconnect"].run({}, context)).toEqual({ disconnected: true, keyRemoved: true });
    expect(context.saved.size).toBe(0);
  });

  it("reads only the script's own result line", () => {
    expect(readConnectResult(`noise\nBOXPILOT_ZULIP_RESULT {"realm":"x"}\n`)).toEqual({ realm: "x" });
    expect(readConnectResult("BOXPILOT_ZULIP_RESULT not json")).toBeNull();
    expect(readConnectResult("")).toBeNull();
  });

  it("sends the bot's key only to Zulip's own port, and is never a step an agent may propose (R2S3-4)", async () => {
    const at = { host: "homebox.tail1234.ts.net:8543", botEmail: "boxpilot-agents-bot@homebox.tail1234.ts.net" };
    const post = { id: "00000000-0000-4000-8000-000000000001", channel: "agent-findings", topic: "Server Keeper", content: "Hello" };
    const elsewhere = "http://127.0.0.1:3022";
    // Where Zulip is, is not a parameter: an address of another container's port is refused...
    expect(registry.validate("agents.zulip.post", { ...at, base: elsewhere, posts: [post] })).toMatch(/does not accept parameter "base"/);
    expect(registry.validate("agents.zulip.events", { ...at, base: elsewhere })).toMatch(/does not accept parameter "base"/);
    expect(registry.validate("agents.zulip.poll", { ...at, base: elsewhere, channel: "agent-files", after: null })).toMatch(/does not accept parameter "base"/);
    // ...and a card naming any of the three is dropped, with or without one.
    const card = await validatePlan([
      { operationId: "agents.zulip.post", parameters: { ...at, base: elsewhere, posts: [post] } },
      { operationId: "agents.zulip.post", parameters: { ...at, posts: [post] } },
      { operationId: "agents.zulip.events", parameters: { ...at } },
      { operationId: "agents.zulip.poll", parameters: { ...at, channel: "agent-files", after: null } },
    ], { registry, role: "owner" });
    expect(card.steps).toEqual([]);
    expect(card.dropped.map((entry) => entry.reason)).toEqual(Array(4).fill(expect.stringMatching(/BoxPilot's own|never proposed/)));
    for (const id of ["agents.zulip.post", "agents.zulip.events", "agents.zulip.poll"]) expect(registry.get(id).internal, id).toBe(true);
    // Run however it is reached, each task is given the port Zulip itself publishes, never one it was handed.
    const context = setup();
    for (const [id, parameters] of [["agents.zulip.post", { ...at, posts: [post] }], ["agents.zulip.events", { ...at }], ["agents.zulip.poll", { ...at, channel: "agent-files", after: null }]]) {
      await operations[id].run({ ...parameters, base: elsewhere }, context);
    }
    expect(context.runUnit.runTask.mock.calls.map(([task, parameters]) => [task, parameters.base])).toEqual([
      ["agents.zulip.post", "http://127.0.0.1:8543"], ["agents.zulip.events", "http://127.0.0.1:8543"], ["agents.zulip.poll", "http://127.0.0.1:8543"],
    ]);
    expect(JSON.stringify(context.runUnit.runTask.mock.calls)).not.toContain("3022");
    // Zulip gone, nothing is sent anywhere.
    const gone = setup({ installed: false });
    await expect(operations["agents.zulip.post"].run({ ...at, posts: [post] }, gone)).rejects.toThrow("Zulip is not installed");
    expect(gone.runUnit.runTask).not.toHaveBeenCalled();
  });

  it("posts only well-formed, bounded batches, in a lane of their own", () => {
    const post = { id: "00000000-0000-4000-8000-000000000001", channel: "agent-findings", topic: "Server Keeper", content: "Hello" };
    const at = { host: "homebox.tail1234.ts.net:8543", botEmail: "boxpilot-agents-bot@homebox.tail1234.ts.net" };
    expect(registry.validate("agents.zulip.post", { ...at, posts: [post] })).toBeNull();
    expect(registry.validate("agents.zulip.post", { ...at, botEmail: "not an address", posts: [post] })).toMatch(/botEmail/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [] })).toMatch(/1 to 10 posts/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...post, content: "x".repeat(9_001) }] })).toMatch(/1 to 9,000/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...post, topic: "line\nbreak".padEnd(70, "x") }] })).toMatch(/topic/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...post, extra: true }] })).toMatch(/may not/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...post, attachment: { name: "../x", text: "t" } }] })).toMatch(/attachment/);
    expect(registry.get("agents.zulip.post")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: false });
    expect(registry.get("agents.zulip.poll")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: true });
    expect(registry.get("agents.zulip.connect")).toMatchObject({ risk: "medium", minimumRole: "owner" });
    expect(laneFor("agents.zulip.post", {})).toEqual(["chat:zulip"]);
    expect(laneFor("agents.zulip.connect", {})).toEqual(["chat:zulip", "app:zulip"]);
    expect(laneFor("app.zulip.organization.link", { id: "zulip" })).toEqual(["app:zulip"]);
    // M40.5: a reply to a direct message goes to one to eight people, by their Zulip ids, and nowhere else.
    const reply = { id: "00000000-0000-4000-8000-000000000002", to: [11], content: "The answer." };
    expect(registry.validate("agents.zulip.post", { ...at, posts: [reply] })).toBeNull();
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...reply, to: [] }] })).toMatch(/one to eight people/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...reply, to: ["alex@example.com"] }] })).toMatch(/one to eight people/);
    expect(registry.validate("agents.zulip.post", { ...at, posts: [{ ...reply, to: Array.from({ length: 9 }, (_value, index) => index + 1) }] })).toMatch(/one to eight people/);
  });

  it("reads what was asked of the bot as the owner's read, with bounded parameters (M40.5)", () => {
    const at = { host: "homebox.tail1234.ts.net:8543", botEmail: "boxpilot-agents-bot@homebox.tail1234.ts.net" };
    expect(registry.get("agents.zulip.events")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: true });
    expect(registry.validate("agents.zulip.events", { ...at, queueId: "1727-abc:2", lastEventId: 4, after: 1000, catchUpMinutes: 15 })).toBeNull();
    expect(registry.validate("agents.zulip.events", { ...at, queueId: null, lastEventId: null, after: null })).toBeNull();
    expect(registry.validate("agents.zulip.events", { ...at, queueId: "../../etc" })).toMatch(/queueId/);
    expect(registry.validate("agents.zulip.events", { ...at, catchUpMinutes: 600 })).toMatch(/1 to 120/);
    expect(registry.validate("agents.zulip.events", { ...at, host: "evil.example/path" })).toMatch(/host/);
  });

  // The script runs inside Zulip's own Python; here it is only parsed. zulip-host.yml runs it for real.
  const python = ["python3", "python"].find((binary) => spawnSync(binary, ["--version"]).status === 0) ?? null;
  it.skipIf(!python)("is a Python script that parses, and gives its result on one line", async () => {
    const check = spawnSync(python, ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", connectScriptPath], { encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const script = await readFile(connectScriptPath, "utf8");
    expect(script).toContain("BOXPILOT_ZULIP_RESULT");
    expect(script).toContain("invite_only=True");
    expect(script).toContain("bot_owner=owner");
    expect(script).not.toMatch(/password=(?!None)/);
  });
});

describe("actions a manifest puts on an app's sheet", () => {
  it("name registered operations that take only the app's id", async () => {
    const { manifests } = await loadCatalog();
    const declared = manifests.flatMap((manifest) => manifest.actions.map((action) => ({ app: manifest.id, action })));
    expect(declared.length).toBeGreaterThan(0);
    for (const { app, action } of declared) {
      const operation = registry.get(action.operation);
      expect(operation, `${app}: ${action.operation}`).toBeTruthy();
      expect(operation.readOnly).toBe(false);
      expect(registry.validate(action.operation, { id: app }), `${app}: ${action.operation}`).toBeNull();
    }
  });
});
