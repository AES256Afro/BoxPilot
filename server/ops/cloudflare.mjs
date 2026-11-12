/**
 * Publishing an app to the internet through Cloudflare Tunnel (M42, ADR-011), from the Tunnel tab of
 * the Cloudflare Tunnel app's sheet. Owner-only throughout: it puts this server's apps in front of
 * everyone, and it holds a token that can change the owner's DNS.
 *
 * The helper does what it can without a network - the credential store, BoxPilot's Cloudflare
 * record, which port an app listens on, installing and starting the Cloudflare Tunnel app - and hands
 * every call to Cloudflare to a root task (server/tasks/cloudflare.mjs). Login walls (Cloudflare
 * Access) are a later step.
 */
import os from "node:os";
import { defineOperation } from "./registry.mjs";
import { cloudflareApiCredential, cloudflarePreviousTunnelCredential, cloudflareTunnelCredential, createTunnelStateStore, dnsLabelPattern, hostnamePattern, sameName, tunnelAppId, tunnelKeySetting, tunnelNameFor, tunnelOfKey } from "../cloudflare-tunnel.mjs";
import { normalizeBind } from "../ports.mjs";
import { containerRunning } from "../app-run-state.mjs";

const minutes = (count) => count * 60_000;
const appIdField = { type: "string", pattern: /^[a-z0-9][a-z0-9-]{1,62}$/ };
const portIdField = { type: "string", pattern: /^[a-z][a-z0-9-]{0,31}$/ };
const domainField = { type: "string", maxLength: 253, pattern: hostnamePattern };
/** Addresses the Cloudflare Tunnel app, on the host's own network, reaches an app's port at as 127.0.0.1. */
const reachableBinds = new Set(["*", "0.0.0.0", "::", "127.0.0.1"]);

const storeOf = (cloudflareState) => cloudflareState ?? createTunnelStateStore();
const savedNames = async (credentials) => new Set((await credentials.listNames().catch(() => [])).map((entry) => entry.name));

/** Whether a container of the app's name is there, whatever BoxPilot's record of the app says. */
const containerThere = (app) => app?.container?.exists === true || app?.container?.running === true;

/**
 * What the Cloudflare Tunnel app runs with now. Null when there is no such app here: not installed,
 * and no container of its name. Otherwise `key` is its TUNNEL_TOKEN, or null when that reads as
 * nothing: the app helper answers an unreadable settings file with no settings, and an unreadable
 * record with "not installed", so neither is taken to mean nothing is running.
 *
 * Read here in the helper; the key goes to the credential store or through tunnelOfKey and nowhere
 * else (never a log, a result, or a task's parameters).
 */
async function runningTunnelApp(apps) {
  const { applications = [] } = await apps.inspect({ id: tunnelAppId });
  const app = applications.find((entry) => entry.id === tunnelAppId);
  if (!app?.installed && !containerThere(app)) return null;
  const { secrets = [] } = await apps.secrets({ id: tunnelAppId });
  const value = secrets.find((entry) => entry.name === tunnelKeySetting)?.value;
  return { installed: Boolean(app?.installed), key: typeof value === "string" && value.trim() ? value.trim() : null };
}

/**
 * Why nothing should be published now, or null: the Cloudflare Tunnel app runs another tunnel than
 * the one recorded (M65.3), so a name added to the recorded one would answer nowhere. Only a key
 * that names another tunnel counts: one that cannot be read says nothing either way.
 */
async function otherTunnelRunning({ apps, state, connected }) {
  if (!state?.tunnelId || !apps) return null;
  const running = tunnelOfKey((await runningTunnelApp(apps).catch(() => null))?.key);
  if (!running || running.tunnelId === state.tunnelId.toLowerCase()) return null;
  return `The Cloudflare Tunnel app is running another tunnel than the one BoxPilot recorded (${state.tunnelName ?? state.tunnelId}), so a name published here would go to a tunnel nothing runs. ${connected ? "Disconnect, then connect Cloudflare again" : "Connect Cloudflare again"}: BoxPilot will use the tunnel that is running and leave its names as they are.`;
}

/**
 * What the tab shows: from the record, the credential names and the key the Cloudflare Tunnel app
 * runs with, so it costs no network. `apps` lets it say when the app runs another tunnel than the
 * one recorded (M65.3).
 * @param {{ credentials?: ReturnType<typeof import("../credentials.mjs").createCredentialStore>, store?: ReturnType<typeof createTunnelStateStore>, hostname?: string, apps?: any }} [options]
 */
export async function inspectCloudflareTunnel({ credentials, store = createTunnelStateStore(), hostname = os.hostname(), apps = null } = {}) {
  const names = await savedNames(credentials);
  let state = null;
  let problem = null;
  try { state = await store.read(); } catch (error) { problem = error.message; }
  if (!problem) problem = await otherTunnelRunning({ apps, state, connected: names.has(cloudflareApiCredential) });
  return {
    connected: names.has(cloudflareApiCredential),
    account: state?.accountId ? { id: state.accountId, name: state.accountName ?? state.accountId } : null,
    tunnel: state?.tunnelId ? { id: state.tunnelId, name: state.tunnelName ?? state.tunnelId } : null,
    plannedTunnelName: tunnelNameFor(hostname),
    zones: state?.zones ?? [],
    routes: (state?.routes ?? []).map((route) => ({ hostname: route.hostname, url: `https://${route.hostname}`, appId: route.appId, portId: route.portId, hostPort: route.hostPort, service: route.service, publishedAt: route.publishedAt })),
    connectedAt: state?.connectedAt ?? null,
    problem,
  };
}

/** The record, refusing when Cloudflare was never connected or the API token has been forgotten. */
async function readyToChange({ credentials, store, doing = "change what is published" }) {
  const state = await store.read();
  if (!state?.tunnelId) throw new Error("Cloudflare is not connected yet: paste an API token and choose Connect Cloudflare first");
  if (!(await savedNames(credentials)).has(cloudflareApiCredential)) throw new Error(`BoxPilot no longer has your Cloudflare API token (you disconnected), so it cannot ${doing}. Connect Cloudflare again first; what is published keeps working meanwhile.`);
  return state;
}

/**
 * What the root task is told about the tunnel the app runs: its id and account, never the key. A
 * key that names no tunnel is BoxPilot's own when it is the one BoxPilot saved for the tunnel it
 * recorded; otherwise it is said to be unreadable, and the task refuses to replace it unasked.
 */
async function tunnelToAskAbout({ key, credentials, store }) {
  const named = tunnelOfKey(key);
  if (named) return named;
  const state = await store.read().catch(() => null);
  const saved = await credentials.read(cloudflareTunnelCredential).catch(() => null);
  return saved === key && state?.tunnelId && state.accountId ? { tunnelId: state.tunnelId, accountTag: state.accountId } : { unreadable: true };
}

/**
 * The Cloudflare Tunnel app installed and running with the tunnel's key: installed when it is not,
 * given the key when `replaceKey` (Connect), started or resumed when it is stopped or paused.
 */
export async function ensureTunnelApp({ apps, credentials, progress = null, timeScale = 1, replaceKey = false }) {
  const key = await credentials.read(cloudflareTunnelCredential);
  if (!key) throw new Error("BoxPilot has no key for your tunnel; connect Cloudflare again");
  const { applications = [] } = await apps.inspect({ id: tunnelAppId });
  const app = applications.find((entry) => entry.id === tunnelAppId);
  const values = { env: { TUNNEL_TOKEN: key } };
  if (!app?.installed) {
    // Its container without a record BoxPilot can read: an install would write over a project that is running.
    if (!replaceKey && containerThere(app)) throw new Error("its container is there but BoxPilot cannot read the app's record, so it was left as it is");
    progress?.("Installing the Cloudflare Tunnel app with your tunnel's key", "stdout");
    await apps.install({ id: tunnelAppId, values, devices: null }, { progress, timeScale });
    return "installed";
  }
  if (replaceKey) {
    progress?.("Giving the Cloudflare Tunnel app your BoxPilot tunnel's key, in place of the one it ran with", "stdout");
    await apps.reconfigure({ id: tunnelAppId, values, devices: null }, { progress, checkpoint: false });
    return "updated";
  }
  if (app.container?.status === "paused") {
    await apps.action({ id: tunnelAppId, action: "unpause" }, { progress });
    return "resumed";
  }
  if (!app.container?.running) {
    progress?.("The Cloudflare Tunnel app was not running; starting it", "stdout");
    await apps.action({ id: tunnelAppId, action: "start" }, { progress });
    return "started";
  }
  return "running";
}

/** The installed app's port to publish, and the host port the tunnel reaches it on, or why not. */
export async function publishTarget({ apps, appId, portId }) {
  if (appId === tunnelAppId) throw new Error("The Cloudflare Tunnel app has nothing of its own to publish");
  const { applications = [] } = await apps.inspect({ id: appId });
  const app = applications.find((entry) => entry.id === appId);
  if (!app?.installed) throw new Error(`${app?.name ?? appId} is not installed`);
  const port = (app.published ?? []).find((entry) => entry.id === portId && entry.protocol === "tcp");
  if (!port || !Number.isInteger(port.host)) throw new Error(`${app.name} has no TCP port called ${portId}`);
  const bind = normalizeBind(port.bind);
  if (!reachableBinds.has(bind)) throw new Error(`${app.name} listens on that port only at ${bind}, which the Cloudflare Tunnel app cannot reach. On ${app.name}'s Reach tab, publish it on your home network, then publish it here again.`);
  return { name: app.name ?? appId, hostPort: port.host, running: containerRunning(app.container) };
}

export function cloudflareOperations() {
  return [
    defineOperation({
      // owner (ADR-003): it reads the root-only record of what is published and which domains the token covers.
      id: "cloudflare.tunnel.inspect", title: "Read the Cloudflare tunnel", risk: "low", readOnly: true, minimumRole: "owner", timeoutMs: 30_000,
      description: "Whether Cloudflare is connected, the account and tunnel BoxPilot uses, the domains your token covers, the apps BoxPilot published through the tunnel, and whether the Cloudflare Tunnel app runs that tunnel or another. Read from BoxPilot's own record and the app's settings; Cloudflare is not asked, and no token is ever returned.",
      parameters: { fields: {} },
      run: (_parameters, { credentials, cloudflareState, apps }) => inspectCloudflareTunnel({ credentials, store: storeOf(cloudflareState), apps }),
    }),
    defineOperation({
      id: "cloudflare.tunnel.check", title: "Check the tunnel with Cloudflare", risk: "low", readOnly: true, minimumRole: "owner", timeoutMs: 60_000,
      description: "Asks Cloudflare whether the tunnel is healthy, how many connectors hold it up, and which names it routes, so a name missing at Cloudflare or added there by hand shows. Nothing is changed.",
      parameters: { fields: {} },
      run: async (_parameters, { credentials, runUnit, cloudflareState }) => {
        await readyToChange({ credentials, store: storeOf(cloudflareState), doing: "ask Cloudflare about the tunnel" });
        return runUnit.runTask("cloudflare.check", {}, { timeoutMs: 45_000 });
      },
    }),
    defineOperation({
      // high: the token can change the owner's DNS, and this decides which tunnel the tunnel app runs.
      id: "cloudflare.connect", title: "Connect Cloudflare", risk: "high", minimumRole: "owner", timeoutMs: minutes(25),
      description: `Saves your Cloudflare API token as a root-only credential and checks it with Cloudflare. If the Cloudflare Tunnel app is already running a tunnel of yours that the token can reach, BoxPilot uses that tunnel: it makes no other, leaves the app's key and the names the tunnel serves as they are, and saves that key as a credential. If the app is running a tunnel the token cannot reach, or one BoxPilot cannot tell from the app's settings, nothing is changed and BoxPilot says so, unless you choose to replace the running tunnel: then its key is kept as the credential ${cloudflarePreviousTunnelCredential}, and the names it serves stop answering until they are moved. Otherwise BoxPilot finds this server's tunnel (boxpilot- and this server's name) in your account or makes it, saves its key as a credential, and installs the Cloudflare Tunnel app with it. Nothing is published yet. If Cloudflare refuses the token, the one saved before stays.`,
      parameters: { fields: {
        token: { type: "string", secret: true, maxLength: 4096, validate: (value) => (/^\S{20,4096}$/.test(value) ? null : "must be the token Cloudflare showed you: 20 to 4096 characters, no spaces") },
        // Only for a tunnel the token cannot reach: without it, Connect refuses rather than strand the names that tunnel serves.
        replaceRunningTunnel: { type: "boolean", optional: true },
      } },
      run: async (parameters, { credentials, runUnit, apps, jobLog, progress, timeScale, cloudflareState }) => {
        // Before anything is saved: what the app runs decides the rest.
        const tunnelApp = await runningTunnelApp(apps).catch((error) => { throw new Error(`BoxPilot could not read which tunnel the Cloudflare Tunnel app runs (${error.message}), so nothing was changed`); });
        const runningKey = tunnelApp?.key ?? null;
        // An app that is here with no key BoxPilot can read, or with a container and no record, runs
        // something BoxPilot cannot name: the task is told so, and refuses to replace it unasked.
        const running = !tunnelApp ? null : tunnelApp.installed && runningKey ? await tunnelToAskAbout({ key: runningKey, credentials, store: storeOf(cloudflareState) }) : { unreadable: true };
        const before = await credentials.read(cloudflareApiCredential).catch(() => null);
        await credentials.set({ name: cloudflareApiCredential, value: parameters.token });
        progress?.(`Saved your Cloudflare API token as the root-only credential ${cloudflareApiCredential}; it is not written to this log.`, "stdout");
        let connected;
        try {
          connected = await runUnit.runTask("cloudflare.connect", { tunnelName: tunnelNameFor(os.hostname()), ...(running ? { running, replaceRunningTunnel: parameters.replaceRunningTunnel === true } : {}) }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null });
        } catch (error) {
          // A token Cloudflare refused is not kept: the one saved before (or none) is put back.
          if (before) await credentials.set({ name: cloudflareApiCredential, value: before }).catch(() => {});
          else await credentials.remove({ name: cloudflareApiCredential }).catch(() => {});
          progress?.(before ? "Put back the API token saved before." : "Did not keep the token.", "stderr");
          throw error;
        }
        const adopted = Boolean(runningKey) && connected?.tunnel?.adopted === true;
        if (adopted) {
          // The tunnel that was running is BoxPilot's now: the app keeps its key, and later starts use it.
          await credentials.set({ name: cloudflareTunnelCredential, value: runningKey });
          progress?.(`Saved the key the Cloudflare Tunnel app runs with as the root-only credential ${cloudflareTunnelCredential}; it is not written to this log.`, "stdout");
        } else if (runningKey && runningKey !== await credentials.read(cloudflareTunnelCredential)) {
          // Kept before it is replaced: the only other copy is the one the app is about to lose.
          await credentials.set({ name: cloudflarePreviousTunnelCredential, value: runningKey });
          progress?.(`Kept the key the Cloudflare Tunnel app ran with until now as the root-only credential ${cloudflarePreviousTunnelCredential}, for recovery from the server's console; it is not written to this log.`, "stdout");
        } else if (tunnelApp && !runningKey) {
          progress?.("The key the Cloudflare Tunnel app ran with could not be read, so none is kept.", "stderr");
        }
        const app = await ensureTunnelApp({ apps, credentials, progress, timeScale, replaceKey: !adopted });
        return {
          connected: true,
          account: connected?.account?.name ?? null,
          tunnel: connected?.tunnel?.name ?? null,
          tunnelMade: Boolean(connected?.tunnel?.created),
          tunnelAdopted: adopted,
          domains: (connected?.zones ?? []).map((zone) => zone.name),
          app,
        };
      },
    }),
    defineOperation({
      // high, with the full name typed: it makes an app reachable by anyone on the internet.
      id: "cloudflare.publish", title: "Publish an app to the internet", risk: "high", minimumRole: "owner", timeoutMs: minutes(25),
      confirm: (parameters) => `${parameters.name}.${parameters.domain}`,
      description: "Makes an installed app reachable by anyone on the internet at https://<name>.<your domain>, through your Cloudflare tunnel, without opening a port on your router: Cloudflare adds the name to your domain and sends visitors to the app's port on this server. A name that already points somewhere else, or that your tunnel already routes somewhere else, is never replaced. Other routes in the tunnel are kept. The Cloudflare Tunnel app is started if it was stopped. There is no extra login in front: the app's own sign-in is the only lock.",
      parameters: { fields: {
        appId: appIdField,
        portId: portIdField,
        domain: domainField,
        name: { type: "string", maxLength: 63, pattern: dnsLabelPattern },
        https: { type: "boolean", optional: true },
      } },
      run: async (parameters, { credentials, runUnit, apps, jobLog, progress, timeScale, cloudflareState }) => {
        const state = await readyToChange({ credentials, store: storeOf(cloudflareState) });
        // On the tunnel nothing runs, the name would be added at Cloudflare and answer nowhere.
        const elsewhere = await otherTunnelRunning({ apps, state, connected: true });
        if (elsewhere) throw new Error(`${elsewhere} Nothing was published.`);
        const zone = state.zones.find((entry) => sameName(entry.name, parameters.domain));
        if (!zone) throw new Error(`${parameters.domain} is not one of the domains your token covers${state.zones.length ? ` (${state.zones.map((entry) => entry.name).join(", ")})` : ""}. Give the token that domain in Cloudflare, then connect again.`);
        const target = await publishTarget({ apps, appId: parameters.appId, portId: parameters.portId });
        const hostname = `${parameters.name}.${zone.name}`;
        if (!hostnamePattern.test(hostname)) throw new Error(`${hostname} is too long for a name on the internet; choose a shorter one`);
        const service = `${parameters.https ? "https" : "http"}://127.0.0.1:${target.hostPort}`;
        progress?.(`Publishing ${target.name} (port ${target.hostPort} on this server) at https://${hostname}`, "stdout");
        const published = await runUnit.runTask("cloudflare.publish", { hostname, zoneId: zone.id, service, noTLSVerify: Boolean(parameters.https), appId: parameters.appId, portId: parameters.portId, hostPort: target.hostPort }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null });
        const warnings = [];
        let app = null;
        try {
          app = await ensureTunnelApp({ apps, credentials, progress, timeScale });
        } catch (error) {
          warnings.push(`${hostname} is set up at Cloudflare, but the Cloudflare Tunnel app could not be started (${error.message}); start it from its Overview tab.`);
        }
        if (!target.running) warnings.push(`${target.name} is not running, so https://${hostname} shows an error page until it is started.`);
        return { url: published?.url ?? `https://${hostname}`, hostname, appId: parameters.appId, app, ...(warnings.length ? { warnings } : {}) };
      },
    }),
    defineOperation({
      id: "cloudflare.unpublish", title: "Stop publishing an app to the internet", risk: "medium", minimumRole: "owner", timeoutMs: minutes(3),
      description: "Takes one name BoxPilot published out of your tunnel and removes the DNS record BoxPilot made for it, if it still points at the tunnel. Other routes and names, and the app itself, are left as they are.",
      parameters: { fields: { hostname: domainField } },
      run: async (parameters, { credentials, runUnit, jobLog, cloudflareState }) => {
        const state = await readyToChange({ credentials, store: storeOf(cloudflareState) });
        // Not refused while the app runs another tunnel: it takes out of the recorded tunnel only what
        // BoxPilot put there, and connecting again forgets those names, so this is the one way to tidy them.
        if (!state.routes.some((route) => sameName(route.hostname, parameters.hostname))) throw new Error(`BoxPilot did not publish ${parameters.hostname}, so it leaves it alone; change it in the Cloudflare dashboard`);
        return runUnit.runTask("cloudflare.unpublish", { hostname: parameters.hostname }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null });
      },
    }),
    defineOperation({
      id: "cloudflare.disconnect", title: "Disconnect Cloudflare", risk: "medium", minimumRole: "owner", timeoutMs: minutes(1),
      description: "Forgets your Cloudflare API token. The tunnel and the apps published through it keep working: the Cloudflare Tunnel app runs with the tunnel's own key, which stays. To publish or unpublish again, connect again. To take an app off the internet, unpublish it before disconnecting.",
      parameters: { fields: {} },
      run: async (_parameters, { credentials, cloudflareState }) => {
        const forgotten = await credentials.remove({ name: cloudflareApiCredential }).then(() => true, () => false);
        const state = await storeOf(cloudflareState).read().catch(() => null);
        return { disconnected: true, forgotten, stillPublished: (state?.routes ?? []).map((route) => route.hostname) };
      },
    }),
  ];
}
