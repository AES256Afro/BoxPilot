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
import { cloudflareApiCredential, cloudflareTunnelCredential, createTunnelStateStore, dnsLabelPattern, hostnamePattern, sameName, tunnelAppId, tunnelNameFor } from "../cloudflare-tunnel.mjs";
import { normalizeBind } from "../ports.mjs";

const minutes = (count) => count * 60_000;
const appIdField = { type: "string", pattern: /^[a-z0-9][a-z0-9-]{1,62}$/ };
const portIdField = { type: "string", pattern: /^[a-z][a-z0-9-]{0,31}$/ };
const domainField = { type: "string", maxLength: 253, pattern: hostnamePattern };
/** Addresses the Cloudflare Tunnel app, on the host's own network, reaches an app's port at as 127.0.0.1. */
const reachableBinds = new Set(["*", "0.0.0.0", "::", "127.0.0.1"]);

const storeOf = (cloudflareState) => cloudflareState ?? createTunnelStateStore();
const savedNames = async (credentials) => new Set((await credentials.listNames().catch(() => [])).map((entry) => entry.name));

/** What the tab shows: from the record and the credential names alone, so it costs no network. */
export async function inspectCloudflareTunnel({ credentials, store = createTunnelStateStore(), hostname = os.hostname() } = {}) {
  const names = await savedNames(credentials);
  let state = null;
  let problem = null;
  try { state = await store.read(); } catch (error) { problem = error.message; }
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
  return { name: app.name ?? appId, hostPort: port.host, running: Boolean(app.container?.running) && app.container?.status !== "paused" };
}

export function cloudflareOperations() {
  return [
    defineOperation({
      // owner (ADR-003): it reads the root-only record of what is published and which domains the token covers.
      id: "cloudflare.tunnel.inspect", title: "Read the Cloudflare tunnel", risk: "low", readOnly: true, minimumRole: "owner", timeoutMs: 30_000,
      description: "Whether Cloudflare is connected, the account and tunnel BoxPilot uses, the domains your token covers, and the apps BoxPilot published through the tunnel. Read from BoxPilot's own record; Cloudflare is not asked, and no token is ever returned.",
      parameters: { fields: {} },
      run: (_parameters, { credentials, cloudflareState }) => inspectCloudflareTunnel({ credentials, store: storeOf(cloudflareState) }),
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
      // high: the token can change the owner's DNS, and this replaces the key the tunnel app runs with.
      id: "cloudflare.connect", title: "Connect Cloudflare", risk: "high", minimumRole: "owner", timeoutMs: minutes(25),
      description: "Saves your Cloudflare API token as a root-only credential, checks it with Cloudflare, and finds this server's tunnel (boxpilot- and this server's name) in your account or makes it. The tunnel's key is saved as a credential too, and the Cloudflare Tunnel app is installed with it, or, if it is already installed, given it in place of the token it runs with now. Nothing is published yet. If Cloudflare refuses the token, the one saved before stays.",
      parameters: { fields: {
        token: { type: "string", secret: true, maxLength: 4096, validate: (value) => (/^\S{20,4096}$/.test(value) ? null : "must be the token Cloudflare showed you: 20 to 4096 characters, no spaces") },
      } },
      run: async (parameters, { credentials, runUnit, apps, jobLog, progress, timeScale }) => {
        const before = await credentials.read(cloudflareApiCredential).catch(() => null);
        await credentials.set({ name: cloudflareApiCredential, value: parameters.token });
        progress?.(`Saved your Cloudflare API token as the root-only credential ${cloudflareApiCredential}; it is not written to this log.`, "stdout");
        let connected;
        try {
          connected = await runUnit.runTask("cloudflare.connect", { tunnelName: tunnelNameFor(os.hostname()) }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null });
        } catch (error) {
          // A token Cloudflare refused is not kept: the one saved before (or none) is put back.
          if (before) await credentials.set({ name: cloudflareApiCredential, value: before }).catch(() => {});
          else await credentials.remove({ name: cloudflareApiCredential }).catch(() => {});
          progress?.(before ? "Put back the API token saved before." : "Did not keep the token.", "stderr");
          throw error;
        }
        const app = await ensureTunnelApp({ apps, credentials, progress, timeScale, replaceKey: true });
        return {
          connected: true,
          account: connected?.account?.name ?? null,
          tunnel: connected?.tunnel?.name ?? null,
          tunnelMade: Boolean(connected?.tunnel?.created),
          domains: (connected?.zones ?? []).map((zone) => zone.name),
          app,
        };
      },
    }),
    defineOperation({
      // high, with the full name typed: it makes an app reachable by anyone on the internet.
      id: "cloudflare.publish", title: "Publish an app to the internet", risk: "high", minimumRole: "owner", timeoutMs: minutes(25),
      confirm: (parameters) => `${parameters.name}.${parameters.domain}`,
      description: "Makes an installed app reachable by anyone on the internet at https://<name>.<your domain>, through your Cloudflare tunnel, without opening a port on your router: Cloudflare adds the name to your domain and sends visitors to the app's port on this server. A name that already points somewhere else is never replaced. Other routes in the tunnel are kept. The Cloudflare Tunnel app is started if it was stopped. There is no extra login in front: the app's own sign-in is the only lock.",
      parameters: { fields: {
        appId: appIdField,
        portId: portIdField,
        domain: domainField,
        name: { type: "string", maxLength: 63, pattern: dnsLabelPattern },
        https: { type: "boolean", optional: true },
      } },
      run: async (parameters, { credentials, runUnit, apps, jobLog, progress, timeScale, cloudflareState }) => {
        const state = await readyToChange({ credentials, store: storeOf(cloudflareState) });
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
