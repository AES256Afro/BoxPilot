import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { secretPaths } from "./registry.mjs";
import { inspectCloudflareTunnel } from "./cloudflare.mjs";
import { cloudflareApiCredential, cloudflarePreviousTunnelCredential, cloudflareTunnelCredential, normalizeTunnelState } from "../cloudflare-tunnel.mjs";
import { laneFor } from "../helper-lanes.mjs";
import { cloudflareConnect } from "../tasks/cloudflare.mjs";
import { createFakeCloudflare, fakeAccount, fakeTunnelKey } from "../../test/fake-cloudflare.mjs";

const token = "cf-test-token-0000000000000000000000";
const runKey = "eyJhIjoiZmFrZS1ydW4ta2V5LWZvci10ZXN0cyJ9";
const zone = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "example.com" };
const connected = (routes = []) => ({ accountId: "0123456789abcdef0123456789abcdef", accountName: "Example household", tunnelId: "00000000-0000-4000-8000-0000000000aa", tunnelName: "boxpilot-homebox", zones: [zone], routes, connectedAt: "2026-10-01T09:00:00.000Z" });
const route = { hostname: "share.example.com", zoneId: zone.id, dnsRecordId: "rec1", appId: "pingvin-share", portId: "web", hostPort: 3022, service: "http://127.0.0.1:3022", publishedAt: "2026-10-01T10:00:00.000Z" };
const publish = { appId: "pingvin-share", portId: "web", domain: "example.com", name: "share" };

function credentialStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: async (name) => values.get(name) ?? null,
    set: async ({ name, value }) => { values.set(name, value); return { name }; },
    remove: async ({ name }) => { if (!values.has(name)) throw new Error(`No credential is named ${name}`); values.delete(name); return { name, removed: true }; },
    listNames: async () => [...values.keys()].sort().map((name) => ({ name, createdAt: null, updatedAt: null })),
  };
}
function memoryState(initial = null) {
  let saved = initial ? normalizeTunnelState(initial) : null;
  return { read: async () => saved, write: async (state) => { saved = normalizeTunnelState(state); return saved; }, get current() { return saved; } };
}

/**
 * An app helper that knows Pingvin Share and the Cloudflare Tunnel app, and says what it was asked.
 * `tunnelApp.key` is the TUNNEL_TOKEN an installed tunnel app runs with (the fake run key unless given).
 */
function fakeApps({ tunnelApp = { installed: false }, pingvin = { installed: true, bind: "0.0.0.0", running: true } } = {}) {
  const calls = [];
  const secretsOf = async ({ id }) => {
    if (tunnelApp.unreadable) throw new Error("EACCES");
    return { id, secrets: id === "cloudflared" && tunnelApp.installed ? [{ name: "TUNNEL_TOKEN", label: "Tunnel token", value: tunnelApp.key ?? runKey }] : [] };
  };
  const describe = (id) => (id === "cloudflared"
    ? { id, name: "Cloudflare Tunnel", installed: Boolean(tunnelApp.installed), container: { running: Boolean(tunnelApp.running), status: tunnelApp.status ?? (tunnelApp.running ? "running" : "exited") }, published: [] }
    : id === "pingvin-share"
      ? { id, name: "Pingvin Share", installed: pingvin.installed, container: { running: pingvin.running, status: pingvin.running ? "running" : "exited" }, published: [{ id: "web", host: 3022, protocol: "tcp", bind: pingvin.bind, fixed: false, web: true }] }
      : null);
  return {
    calls,
    inspect: async ({ id }) => ({ applications: [describe(id)].filter(Boolean) }),
    secrets: secretsOf,
    install: async (request) => { calls.push({ install: request }); return { installed: true }; },
    reconfigure: async (request, options) => { calls.push({ reconfigure: request, options }); return { reconfigured: true }; },
    action: async (request) => { calls.push({ action: request }); return { action: request.action }; },
  };
}

function runUnitAnswering(answers = {}) {
  const tasks = [];
  return { tasks, runTask: async (task, parameters) => { tasks.push({ task, parameters }); if (answers[task] instanceof Error) throw answers[task]; return answers[task] ?? {}; } };
}

describe("the Cloudflare operations (M42)", () => {
  it("are the owner's, at the tiers the tab draws, and the token is a secret wherever the job is kept", async () => {
    expect(registry.get("cloudflare.tunnel.inspect")).toMatchObject({ risk: "low", readOnly: true, minimumRole: "owner" });
    expect(registry.get("cloudflare.tunnel.check")).toMatchObject({ risk: "low", readOnly: true, minimumRole: "owner" });
    expect(registry.get("cloudflare.connect")).toMatchObject({ risk: "high", readOnly: false, minimumRole: "owner" });
    expect(registry.get("cloudflare.publish")).toMatchObject({ risk: "high", readOnly: false, minimumRole: "owner" });
    expect(registry.get("cloudflare.unpublish")).toMatchObject({ risk: "medium", minimumRole: "owner" });
    expect(registry.get("cloudflare.disconnect")).toMatchObject({ risk: "medium", minimumRole: "owner" });
    expect(await secretPaths(registry.get("cloudflare.connect"), { token })).toEqual([["token"]]);
    expect(await secretPaths(registry.get("cloudflare.publish"), publish)).toEqual([]);
  });

  it("asks for the full name to be typed before publishing", () => {
    expect(registry.get("cloudflare.publish").confirm(publish)).toBe("share.example.com");
  });

  it("take a token, a name and a domain only in the shapes they come in", () => {
    expect(registry.validate("cloudflare.connect", { token })).toBeNull();
    expect(registry.validate("cloudflare.connect", { token: "short" })).toMatch(/token/);
    expect(registry.validate("cloudflare.connect", { token: `${token} ` })).toMatch(/no spaces/);
    expect(registry.validate("cloudflare.connect", { token: "x".repeat(4097) })).toMatch(/too long/);
    expect(registry.validate("cloudflare.connect", { token, replaceRunningTunnel: true })).toBeNull();
    expect(registry.validate("cloudflare.connect", { token, replaceRunningTunnel: "yes" })).toMatch(/replaceRunningTunnel/);
    expect(registry.validate("cloudflare.publish", publish)).toBeNull();
    expect(registry.validate("cloudflare.publish", { ...publish, https: true })).toBeNull();
    // One label: not the domain itself (the apex), not two labels, not a bad one.
    for (const name of ["", "@", "a.b", "-share", "share-", "Share", "sh_are", "x".repeat(64)]) {
      expect(registry.validate("cloudflare.publish", { ...publish, name }), JSON.stringify(name)).toMatch(/name/);
    }
    expect(registry.validate("cloudflare.publish", { ...publish, domain: "localhost" })).toMatch(/domain/);
    expect(registry.validate("cloudflare.publish", { ...publish, zoneId: zone.id })).toMatch(/zoneId/);
    expect(registry.validate("cloudflare.unpublish", { hostname: "share.example.com" })).toBeNull();
    expect(registry.validate("cloudflare.unpublish", { hostname: "https://share.example.com" })).toMatch(/hostname/);
  });

  it("change the record one at a time, and hold the tunnel app's lane when they may install or start it", () => {
    expect(laneFor("cloudflare.connect", { token })).toEqual(["cloudflare:tunnel", "app:cloudflared", "app:homepage"]);
    expect(laneFor("cloudflare.publish", publish)).toEqual(["cloudflare:tunnel", "app:cloudflared", "app:homepage"]);
    expect(laneFor("cloudflare.unpublish", { hostname: "share.example.com" })).toEqual(["cloudflare:tunnel"]);
    expect(laneFor("cloudflare.disconnect", {})).toEqual(["cloudflare:tunnel"]);
  });
});

describe("reading the tunnel", () => {
  it("says what is connected and published from BoxPilot's record, never a token", async () => {
    const credentials = credentialStore({ [cloudflareApiCredential]: token, [cloudflareTunnelCredential]: runKey });
    const inspected = await inspectCloudflareTunnel({ credentials, store: memoryState(connected([route])), hostname: "homebox" });
    expect(inspected).toEqual({
      connected: true,
      account: { id: "0123456789abcdef0123456789abcdef", name: "Example household" },
      tunnel: { id: "00000000-0000-4000-8000-0000000000aa", name: "boxpilot-homebox" },
      plannedTunnelName: "boxpilot-homebox",
      zones: [zone],
      routes: [{ hostname: "share.example.com", url: "https://share.example.com", appId: "pingvin-share", portId: "web", hostPort: 3022, service: "http://127.0.0.1:3022", publishedAt: "2026-10-01T10:00:00.000Z" }],
      connectedAt: "2026-10-01T09:00:00.000Z",
      problem: null,
    });
    expect(JSON.stringify(inspected)).not.toContain(token);
    expect(JSON.stringify(inspected)).not.toContain(runKey);
    const fresh = await inspectCloudflareTunnel({ credentials: credentialStore(), store: memoryState(), hostname: "homebox" });
    expect(fresh).toMatchObject({ connected: false, account: null, tunnel: null, zones: [], routes: [], problem: null });
    const damaged = await inspectCloudflareTunnel({ credentials: credentialStore(), store: { read: async () => { throw new Error("BoxPilot's Cloudflare record is damaged"); } }, hostname: "homebox" });
    expect(damaged.problem).toMatch(/damaged/);
  });

  // M65.3: the owner put their own tunnel's key back by hand, and BoxPilot still named the empty one it had made.
  it("says when the Cloudflare Tunnel app runs another tunnel than the one recorded, and what to do", async () => {
    const credentials = credentialStore({ [cloudflareApiCredential]: token, [cloudflareTunnelCredential]: runKey });
    const theirs = fakeTunnelKey("11111111-1111-4111-8111-111111111111");
    const reading = (tunnelApp, state = connected([route])) => inspectCloudflareTunnel({ credentials, store: memoryState(state), hostname: "homebox", apps: fakeApps({ tunnelApp }) });
    const inspected = await reading({ installed: true, running: true, key: theirs });
    expect(inspected.problem).toBe("The Cloudflare Tunnel app is running another tunnel than the one BoxPilot recorded (boxpilot-homebox), so a name published here would go to a tunnel nothing runs. Disconnect, then connect Cloudflare again: BoxPilot will use the tunnel that is running and leave its names as they are.");
    expect(inspected.tunnel).toEqual({ id: "00000000-0000-4000-8000-0000000000aa", name: "boxpilot-homebox" });
    // Disconnected already, there is nothing to disconnect first.
    const disconnected = await inspectCloudflareTunnel({ credentials: credentialStore(), store: memoryState(connected()), hostname: "homebox", apps: fakeApps({ tunnelApp: { installed: true, running: true, key: theirs } }) });
    expect(disconnected.problem).toMatch(/nothing runs\. Connect Cloudflare again: BoxPilot will use the tunnel that is running/);
    expect(JSON.stringify(inspected)).not.toContain(theirs);
    expect(JSON.stringify(inspected)).not.toContain("c2VjcmV0");
    // The recorded tunnel's own key, a key that names no tunnel, no app, an app that cannot be read, and nothing recorded: no problem.
    expect((await reading({ installed: true, running: true, key: fakeTunnelKey("00000000-0000-4000-8000-0000000000AA") })).problem).toBeNull();
    expect((await reading({ installed: true, running: true })).problem).toBeNull();
    expect((await reading({ installed: false, key: theirs })).problem).toBeNull();
    expect((await reading({ installed: true, unreadable: true })).problem).toBeNull();
    expect((await reading({ installed: true, running: true, key: theirs }, null)).problem).toBeNull();
  });
});

describe("connecting", () => {
  it("saves the token, connects through the root task, and installs the tunnel app with the tunnel's key", async () => {
    const credentials = credentialStore();
    const apps = fakeApps();
    const runUnit = runUnitAnswering({ "cloudflare.connect": { account: { id: "a", name: "Example household" }, tunnel: { id: "t", name: "boxpilot-homebox", created: true }, zones: [zone] } });
    runUnit.runTask = ((original) => async (task, parameters, options) => { credentials.values.set(cloudflareTunnelCredential, runKey); return original(task, parameters, options); })(runUnit.runTask);
    const lines = [];
    const result = await registry.execute("cloudflare.connect", { token }, { credentials, runUnit, apps, progress: (line) => lines.push(line) });
    expect(credentials.values.get(cloudflareApiCredential)).toBe(token);
    expect(runUnit.tasks).toEqual([{ task: "cloudflare.connect", parameters: { tunnelName: expect.stringMatching(/^boxpilot-[a-z0-9-]+$/) } }]);
    expect(apps.calls).toEqual([{ install: { id: "cloudflared", values: { env: { TUNNEL_TOKEN: runKey } }, devices: null } }]);
    expect(result).toEqual({ connected: true, account: "Example household", tunnel: "boxpilot-homebox", tunnelMade: true, tunnelAdopted: false, domains: ["example.com"], app: "installed" });
    for (const text of [JSON.stringify(result), lines.join("\n")]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(runKey);
    }
  });

  it("gives a tunnel app that runs this server's own tunnel that tunnel's key again", async () => {
    const credentials = credentialStore({ [cloudflareTunnelCredential]: runKey });
    const apps = fakeApps({ tunnelApp: { installed: true, running: true } });
    const runUnit = runUnitAnswering({ "cloudflare.connect": { zones: [zone] } });
    await registry.execute("cloudflare.connect", { token }, { credentials, runUnit, apps, cloudflareState: memoryState(connected()) });
    // The key BoxPilot saved for the tunnel it recorded: the task is told that tunnel, never the key.
    expect(runUnit.tasks[0].parameters).toEqual({ tunnelName: expect.any(String), running: { tunnelId: "00000000-0000-4000-8000-0000000000aa", accountTag: "0123456789abcdef0123456789abcdef" }, replaceRunningTunnel: false });
    expect(apps.calls).toEqual([{ reconfigure: { id: "cloudflared", values: { env: { TUNNEL_TOKEN: runKey } }, devices: null }, options: { progress: null, checkpoint: false } }]);
    expect(credentials.values.has(cloudflarePreviousTunnelCredential)).toBe(false);
  });

  it("does not keep a token Cloudflare refused, and puts back the one saved before", async () => {
    const refused = new Error("Cloudflare did not accept this token while listing your domains");
    const none = credentialStore();
    await expect(registry.execute("cloudflare.connect", { token }, { credentials: none, runUnit: runUnitAnswering({ "cloudflare.connect": refused }), apps: fakeApps() })).rejects.toThrow(/did not accept this token/);
    expect(none.values.has(cloudflareApiCredential)).toBe(false);
    const earlier = credentialStore({ [cloudflareApiCredential]: "the-earlier-token-0000000000" });
    await expect(registry.execute("cloudflare.connect", { token }, { credentials: earlier, runUnit: runUnitAnswering({ "cloudflare.connect": refused }), apps: fakeApps() })).rejects.toThrow();
    expect(earlier.values.get(cloudflareApiCredential)).toBe("the-earlier-token-0000000000");
  });
});

// M65.3. The Cloudflare Tunnel app ran the owner's own tunnel, with their site on it. Connect made
// boxpilot-<this server>, gave the app its key in place of theirs, and kept the old key nowhere.
// These run the operation against the root task and a stand-in for Cloudflare, end to end.
describe("connecting when the Cloudflare Tunnel app already runs a tunnel (M65.3)", () => {
  const theirTunnel = { id: "11111111-1111-4111-8111-111111111111", name: "home", account: fakeAccount.id, status: "healthy", remote_config: true, connections: [] };
  const theirSecret = "dGhlaXItdHVubmVsLXNlY3JldA==";
  const theirKey = fakeTunnelKey(theirTunnel.id, { secret: theirSecret });
  const otherAccount = "fedcba9876543210fedcba9876543210";
  const at = () => new Date("2026-11-12T09:00:00.000Z");

  function connecting({ tunnelApp, state = memoryState(), saved = {}, ...fake } = {}) {
    const cloudflare = createFakeCloudflare({ token, ...fake });
    const credentials = credentialStore(saved);
    const apps = fakeApps({ tunnelApp });
    const lines = [];
    const tasks = [];
    const runUnit = { runTask: async (task, parameters) => { tasks.push({ task, parameters }); return cloudflareConnect(parameters, { credentials, state, fetcher: cloudflare.fetcher, now: at, log: (line) => lines.push(line) }); } };
    const run = (parameters = { token }) => registry.execute("cloudflare.connect", parameters, { credentials, runUnit, apps, cloudflareState: state, progress: (line) => lines.push(line) });
    const made = () => cloudflare.calls.filter((call) => call.method !== "GET");
    return { cloudflare, credentials, apps, lines, tasks, state, run, made };
  }
  /** The key and its secret reach the credential store and the app, and nothing that is kept or shown. */
  const expectKeyUnsaid = (key, ...things) => {
    for (const thing of things) {
      expect(JSON.stringify(thing)).not.toContain(key);
      expect(JSON.stringify(thing)).not.toContain(theirSecret);
    }
  };

  it("uses the tunnel that is running: none is made, the app keeps its key, and that key is the one saved", async () => {
    const { cloudflare, credentials, apps, lines, tasks, state, run, made } = connecting({ tunnelApp: { installed: true, running: true, key: theirKey }, tunnels: [theirTunnel] });
    const result = await run();
    expect(result).toEqual({ connected: true, account: "Example household", tunnel: "home", tunnelMade: false, tunnelAdopted: true, domains: ["example.com"], app: "running" });
    expect(made()).toEqual([]);
    expect(cloudflare.state.tunnels.map((tunnel) => tunnel.name)).toEqual(["home"]);
    expect(apps.calls).toEqual([]);
    expect(state.current).toMatchObject({ tunnelId: theirTunnel.id, tunnelName: "home", accountId: fakeAccount.id, routes: [] });
    expect(credentials.values.get(cloudflareTunnelCredential)).toBe(theirKey);
    expect(credentials.values.get(cloudflareApiCredential)).toBe(token);
    expect(credentials.values.has(cloudflarePreviousTunnelCredential)).toBe(false);
    expect(tasks).toEqual([{ task: "cloudflare.connect", parameters: { tunnelName: expect.any(String), running: { tunnelId: theirTunnel.id, accountTag: fakeAccount.id }, replaceRunningTunnel: false } }]);
    expect(lines).toContain("The Cloudflare Tunnel app is already running your tunnel home; BoxPilot will use it and leave its names as they are.");
    expect(lines).toContain(`Saved the key the Cloudflare Tunnel app runs with as the root-only credential ${cloudflareTunnelCredential}; it is not written to this log.`);
    expectKeyUnsaid(theirKey, result, lines, tasks, state.current);
  });

  it("starts a stopped tunnel app with the key it has, where it used to give it another", async () => {
    const { apps, run } = connecting({ tunnelApp: { installed: true, running: false, key: theirKey }, tunnels: [theirTunnel] });
    expect(await run()).toMatchObject({ tunnelAdopted: true, app: "started" });
    expect(apps.calls).toEqual([{ action: { id: "cloudflared", action: "start" } }]);
  });

  it("goes back to the running tunnel after an earlier Connect made an empty one, which it leaves and names", async () => {
    const empty = { id: "00000000-0000-4000-8000-0000000000aa", name: "boxpilot-homebox", account: fakeAccount.id, status: "inactive", remote_config: true, connections: [] };
    const { cloudflare, credentials, apps, lines, state, run, made } = connecting({ tunnelApp: { installed: true, running: true, key: theirKey }, tunnels: [empty, theirTunnel], state: memoryState(connected()), saved: { [cloudflareTunnelCredential]: runKey } });
    expect(await run()).toMatchObject({ tunnel: "home", tunnelAdopted: true });
    expect(state.current).toMatchObject({ tunnelId: theirTunnel.id, tunnelName: "home" });
    expect(credentials.values.get(cloudflareTunnelCredential)).toBe(theirKey);
    expect(apps.calls).toEqual([]);
    expect(made()).toEqual([]);
    expect(cloudflare.state.tunnels).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/The tunnel boxpilot-homebox that BoxPilot used before is no longer used, and nothing runs it\./);
  });

  it("refuses to replace a running tunnel the token cannot reach, and leaves the app, the record and the saved token as they were", async () => {
    const elsewhere = fakeTunnelKey(theirTunnel.id, { account: otherAccount, secret: theirSecret });
    for (const [key, says] of [[elsewhere, /already running a tunnel this token cannot reach/], ["a-key-pasted-by-hand-that-names-no-tunnel", /a key BoxPilot cannot tell the tunnel from/]]) {
      const earlier = "the-earlier-token-0000000000";
      const { credentials, apps, tasks, state, run, made, lines } = connecting({ tunnelApp: { installed: true, running: true, key }, accounts: [fakeAccount.id], saved: { [cloudflareApiCredential]: earlier } });
      const error = await run().catch((caught) => caught);
      expect(error.message).toMatch(says);
      expect(error.message).toMatch(/nothing was changed\. Either .+; or connect again choosing to replace the running tunnel \(replaceRunningTunnel\)/);
      expect(made()).toEqual([]);
      expect(apps.calls).toEqual([]);
      expect(state.current).toBeNull();
      // As for any Connect that fails: the token saved before is put back, and no other credential appears.
      expect(Object.fromEntries(credentials.values)).toEqual({ [cloudflareApiCredential]: earlier });
      expect(tasks[0].parameters).toMatchObject({ replaceRunningTunnel: false });
      expectKeyUnsaid(key, error.message, tasks, lines);
    }
    // With no token saved before, the refused one is not kept either.
    const fresh = connecting({ tunnelApp: { installed: true, running: true, key: elsewhere }, accounts: [fakeAccount.id] });
    await expect(fresh.run()).rejects.toThrow(/cannot reach/);
    expect([...fresh.credentials.values.keys()]).toEqual([]);
  });

  it("replaces it when the owner chose to, keeping the key the app ran with first", async () => {
    const elsewhere = fakeTunnelKey(theirTunnel.id, { account: otherAccount, secret: theirSecret });
    const { cloudflare, credentials, apps, lines, tasks, state, run } = connecting({ tunnelApp: { installed: true, running: true, key: elsewhere }, accounts: [fakeAccount.id] });
    // The old key is in the store by the time the app is given the new one.
    const reconfigure = apps.reconfigure;
    let keptWhenReplaced = null;
    apps.reconfigure = async (...given) => { keptWhenReplaced = credentials.values.get(cloudflarePreviousTunnelCredential); return reconfigure(...given); };
    const result = await run({ token, replaceRunningTunnel: true });
    expect(result).toMatchObject({ tunnelMade: true, tunnelAdopted: false, app: "updated" });
    expect(keptWhenReplaced).toBe(elsewhere);
    expect(credentials.values.get(cloudflarePreviousTunnelCredential)).toBe(elsewhere);
    expect(credentials.values.get(cloudflareTunnelCredential)).toBe(cloudflare.runKey);
    expect(apps.calls).toEqual([{ reconfigure: { id: "cloudflared", values: { env: { TUNNEL_TOKEN: cloudflare.runKey } }, devices: null }, options: { progress: expect.any(Function), checkpoint: false } }]);
    expect(state.current.tunnelName).toMatch(/^boxpilot-/);
    expect(tasks[0].parameters).toMatchObject({ replaceRunningTunnel: true });
    const log = lines.join("\n");
    expect(log).toMatch(/The names the old tunnel serves stop answering until they are moved to boxpilot-/);
    expect(log).toContain(`Kept the key the Cloudflare Tunnel app ran with until now as the root-only credential ${cloudflarePreviousTunnelCredential}`);
    expectKeyUnsaid(elsewhere, result, lines, tasks, state.current);
  });

  it("changes nothing, and saves no token, when it cannot read which tunnel the app runs", async () => {
    const { credentials, tasks, run } = connecting({ tunnelApp: { installed: true, running: true, unreadable: true } });
    await expect(run()).rejects.toThrow("BoxPilot could not read which tunnel the Cloudflare Tunnel app runs (EACCES), so nothing was changed");
    expect(tasks).toEqual([]);
    expect([...credentials.values.keys()]).toEqual([]);
  });

  it("makes this server's tunnel and installs the app when no tunnel app is installed, as before", async () => {
    const { cloudflare, credentials, apps, tasks, run } = connecting({ tunnelApp: { installed: false, key: theirKey } });
    const result = await run();
    expect(result).toMatchObject({ tunnelMade: true, tunnelAdopted: false, app: "installed" });
    expect(tasks).toEqual([{ task: "cloudflare.connect", parameters: { tunnelName: expect.stringMatching(/^boxpilot-[a-z0-9-]+$/) } }]);
    expect(apps.calls).toEqual([{ install: { id: "cloudflared", values: { env: { TUNNEL_TOKEN: cloudflare.runKey } }, devices: null } }]);
    expect(credentials.values.has(cloudflarePreviousTunnelCredential)).toBe(false);
  });
});

describe("publishing", () => {
  const ready = () => credentialStore({ [cloudflareApiCredential]: token, [cloudflareTunnelCredential]: runKey });

  it("resolves the app's port on this server, publishes through the root task and starts the tunnel app if it is stopped", async () => {
    const apps = fakeApps({ tunnelApp: { installed: true, running: false } });
    const runUnit = runUnitAnswering({ "cloudflare.publish": { url: "https://share.example.com", hostname: "share.example.com", appId: "pingvin-share", dnsRecord: "added" } });
    const result = await registry.execute("cloudflare.publish", { ...publish, https: false }, { credentials: ready(), runUnit, apps, cloudflareState: memoryState(connected()) });
    expect(runUnit.tasks).toEqual([{ task: "cloudflare.publish", parameters: { hostname: "share.example.com", zoneId: zone.id, service: "http://127.0.0.1:3022", noTLSVerify: false, appId: "pingvin-share", portId: "web", hostPort: 3022 } }]);
    expect(apps.calls).toEqual([{ action: { id: "cloudflared", action: "start" } }]);
    expect(result).toEqual({ url: "https://share.example.com", hostname: "share.example.com", appId: "pingvin-share", app: "started" });
  });

  it("sends an HTTPS port as HTTPS, and says when the app itself is not running", async () => {
    const runUnit = runUnitAnswering();
    const result = await registry.execute("cloudflare.publish", { ...publish, https: true }, { credentials: ready(), runUnit, apps: fakeApps({ tunnelApp: { installed: true, running: true }, pingvin: { installed: true, bind: "127.0.0.1", running: false } }), cloudflareState: memoryState(connected()) });
    expect(runUnit.tasks[0].parameters).toMatchObject({ service: "https://127.0.0.1:3022", noTLSVerify: true });
    expect(result.warnings).toEqual(["Pingvin Share is not running, so https://share.example.com shows an error page until it is started."]);
  });

  it("refuses a port the tunnel app cannot reach, a domain not connected, a forgotten token, and an app not installed", async () => {
    const deps = (overrides = {}) => ({ credentials: ready(), runUnit: runUnitAnswering(), apps: fakeApps(), cloudflareState: memoryState(connected()), ...overrides });
    await expect(registry.execute("cloudflare.publish", publish, deps({ apps: fakeApps({ pingvin: { installed: true, bind: "100.64.0.10", running: true } }) }))).rejects.toThrow(/only at 100\.64\.0\.10.*Reach tab/);
    await expect(registry.execute("cloudflare.publish", { ...publish, domain: "example.org" }, deps())).rejects.toThrow(/example\.org is not one of the domains your token covers \(example\.com\)/);
    await expect(registry.execute("cloudflare.publish", publish, deps({ credentials: credentialStore({ [cloudflareTunnelCredential]: runKey }) }))).rejects.toThrow(/Connect Cloudflare again first/);
    await expect(registry.execute("cloudflare.publish", publish, deps({ apps: fakeApps({ pingvin: { installed: false, bind: "0.0.0.0", running: false } }) }))).rejects.toThrow(/Pingvin Share is not installed/);
    await expect(registry.execute("cloudflare.publish", publish, deps({ cloudflareState: memoryState() }))).rejects.toThrow(/not connected yet/);
    await expect(registry.execute("cloudflare.publish", { ...publish, appId: "cloudflared" }, deps())).rejects.toThrow(/nothing of its own/);
  });
});

describe("unpublishing and disconnecting", () => {
  it("unpublishes only a name BoxPilot published", async () => {
    const credentials = credentialStore({ [cloudflareApiCredential]: token });
    const runUnit = runUnitAnswering({ "cloudflare.unpublish": { hostname: "share.example.com", dnsRemoved: true } });
    expect(await registry.execute("cloudflare.unpublish", { hostname: "share.example.com" }, { credentials, runUnit, cloudflareState: memoryState(connected([route])) })).toEqual({ hostname: "share.example.com", dnsRemoved: true });
    await expect(registry.execute("cloudflare.unpublish", { hostname: "wiki.example.com" }, { credentials, runUnit, cloudflareState: memoryState(connected([route])) })).rejects.toThrow(/BoxPilot did not publish wiki\.example\.com/);
  });

  it("forgets only the API token: the tunnel's key and what is published stay", async () => {
    const credentials = credentialStore({ [cloudflareApiCredential]: token, [cloudflareTunnelCredential]: runKey });
    const result = await registry.execute("cloudflare.disconnect", {}, { credentials, cloudflareState: memoryState(connected([route])) });
    expect(result).toEqual({ disconnected: true, forgotten: true, stillPublished: ["share.example.com"] });
    expect([...credentials.values.keys()]).toEqual([cloudflareTunnelCredential]);
    await expect(registry.execute("cloudflare.tunnel.check", {}, { credentials, runUnit: runUnitAnswering(), cloudflareState: memoryState(connected([route])) })).rejects.toThrow(/cannot ask Cloudflare about the tunnel/);
  });
});
