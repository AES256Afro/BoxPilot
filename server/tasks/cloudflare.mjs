/**
 * Cloudflare Tunnel's network half (M42, ADR-011): the root tasks that talk to Cloudflare. Tasks,
 * because the helper has no network (PrivateNetwork=true). Each reads the owner's API token from the
 * credential store itself, uses it in one header, and returns only names and ids: never the token,
 * never the tunnel's key. Each writes what it made to BoxPilot's Cloudflare record before it returns,
 * so the record and Cloudflare agree even when the helper never hears back.
 *
 * Three rules hold everywhere: a DNS name that points anywhere but this tunnel is never replaced or
 * removed, a route or a DNS record BoxPilot did not make is never touched, and a tunnel the
 * Cloudflare Tunnel app already runs is used rather than replaced (M65.3). The helper side is
 * server/ops/cloudflare.mjs; the client and the route rules are server/cloudflare-api.mjs.
 */
import { CloudflareError, createCloudflareApi, routeNames, tokenPermissions, withRoute, withoutRoute } from "../cloudflare-api.mjs";
import { cloudflareApiCredential, cloudflareTunnelCredential, createTunnelStateStore, hostnamePattern, sameName, servicePattern, tunnelNamePattern, tunnelTargetFor } from "../cloudflare-tunnel.mjs";
import { createCredentialStore } from "../credentials.mjs";

const idPattern = /^[A-Za-z0-9-]{1,64}$/;
/** How the comment on a DNS record BoxPilot made begins: what tells its records from the owner's. */
const recordComment = "BoxPilot:";

/** The task's tools: the credential store, the record, and a fetch that tests replace. */
function toolsOf({ credentials = createCredentialStore(), state = createTunnelStateStore(), fetcher = fetch, log = (_line, _stream) => {}, now = () => new Date() } = {}) {
  return { credentials, state, fetcher, log, now };
}

async function apiFor(credentials, fetcher) {
  const token = await credentials.read(cloudflareApiCredential);
  if (!token) throw new Error("BoxPilot has no Cloudflare API token: connect Cloudflare first (Apps, Cloudflare Tunnel, Tunnel tab)");
  return createCloudflareApi({ token, fetcher });
}

async function connectedState(state) {
  const current = await state.read();
  if (!current?.accountId || !current.tunnelId) throw new Error("Cloudflare is not connected yet: connect it first (Apps, Cloudflare Tunnel, Tunnel tab)");
  return current;
}

/**
 * The tunnel the Cloudflare Tunnel app runs, as this token sees it. Null when Cloudflare will not
 * show it to this token: it is in an account the token does not cover (403), or it is not in that
 * account (404). Anything else (the network, a token Cloudflare does not know) is the caller's error.
 */
async function reachRunningTunnel(api, running) {
  try {
    const found = await api.tunnel(running.accountTag, running.tunnelId);
    return { ...found, id: running.tunnelId, name: typeof found.name === "string" && found.name ? found.name.slice(0, 64) : running.tunnelId };
  } catch (error) {
    if (error instanceof CloudflareError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

/**
 * Connect: check the token, learn the account and its domains, and settle which tunnel is BoxPilot's.
 *
 * The tunnel the Cloudflare Tunnel app already runs comes first (M65.3; `running` is what the helper
 * read from the app's key: two ids, never the key). When this token can reach it, that tunnel is
 * BoxPilot's from now on: none is made, the app keeps its key (the helper saves that key as the
 * credential), and what the tunnel routes is left alone. When it cannot, nothing is changed unless
 * `replaceRunningTunnel`. With no tunnel running, or this server's own (boxpilot-<name>), this
 * server's tunnel is found or made and its key saved as a credential, as before. Routes recorded for
 * the same tunnel are kept; nothing is published.
 * @param {{ tunnelName?: string, running?: { tunnelId?: string, accountTag?: string, unreadable?: boolean } | null, replaceRunningTunnel?: boolean }} [parameters]
 */
export async function cloudflareConnect({ tunnelName, running = null, replaceRunningTunnel = false } = {}, deps = {}) {
  const { credentials, state, fetcher, log, now } = toolsOf(deps);
  if (typeof tunnelName !== "string" || !tunnelNamePattern.test(tunnelName)) throw new Error("The tunnel's name must be boxpilot- and this server's name");
  const unreadable = running?.unreadable === true;
  if (running && !unreadable && !(typeof running.tunnelId === "string" && idPattern.test(running.tunnelId) && typeof running.accountTag === "string" && idPattern.test(running.accountTag))) throw new Error("The tunnel the Cloudflare Tunnel app runs was not named in a way BoxPilot knows");
  const api = await apiFor(credentials, fetcher);
  const zones = await api.listZones();
  if (!zones.length) throw new Error("Cloudflare accepted the token, but it covers no active domain. Give it Zone · Zone · Read and Zone · DNS · Edit for the domain you want to use, then connect again.");

  let inUse = running;
  let reached = inUse && !unreadable ? await reachRunningTunnel(api, inUse) : null;
  if (reached?.deleted) {
    log(`The Cloudflare Tunnel app's key is for the tunnel ${reached.name}, which was deleted in Cloudflare: nothing answers through it, so the app is given this server's tunnel instead.`, "stdout");
    reached = null;
    inUse = null;
  }
  // The app runs a tunnel this token cannot use: never replaced without being asked to.
  const replacing = Boolean(inUse) && !reached;
  if (replacing && !replaceRunningTunnel) {
    const what = unreadable
      ? "The Cloudflare Tunnel app is already on this server, and BoxPilot cannot tell which tunnel it runs: its token could not be read, or names no tunnel"
      : `The Cloudflare Tunnel app is already running a tunnel this token cannot reach (tunnel ${inUse.tunnelId} in the Cloudflare account ${inUse.accountTag})`;
    const keep = unreadable
      ? "paste that tunnel's token from the Cloudflare dashboard into the app's Settings and connect again"
      : `give the token ${tokenPermissions[0]} for that account and connect again, and BoxPilot will use that tunnel as it is`;
    // The way on that the Tunnel tab can take; replaceRunningTunnel does the same in one step for a caller that can send it.
    const move = unreadable ? "uninstall the Cloudflare Tunnel app and connect again" : "copy the app's token from its Settings somewhere safe, uninstall the Cloudflare Tunnel app and connect again";
    throw new Error(`${what}, so BoxPilot has not replaced it and nothing was changed. Either ${keep}; or, to move this server to ${tunnelName}, ${move}: the names the old tunnel serves stop answering until they are moved.`);
  }

  const account = reached
    ? zones.find((zone) => zone.account?.id === inUse.accountTag)?.account ?? { id: inUse.accountTag, name: inUse.accountTag }
    : zones.find((zone) => zone.account)?.account ?? null;
  if (!account) throw new Error("Cloudflare did not say which account your domains belong to; check the token's Account permission");
  const domains = zones.filter((zone) => zone.account?.id === account.id).map((zone) => ({ id: zone.id, name: zone.name }));
  if (domains.length) log(`Cloudflare accepted the token: ${domains.length === 1 ? "1 domain" : `${domains.length} domains`} in the account ${account.name} (${domains.map((zone) => zone.name).join(", ")}).`, "stdout");
  else log(`Cloudflare accepted the token, but it covers no domain in the account the running tunnel is in (${account.name}), so no app can be published until it does.`, "stderr");
  if (domains.length < zones.length) log("The token also covers domains in another Cloudflare account; BoxPilot uses this one.", "stdout");

  // This server's own tunnel, running already, goes the way it always did: its key is read again.
  const adopted = Boolean(reached) && !(reached.name === tunnelName && reached.remoteConfig);
  let tunnel = reached;
  let created = false;
  if (adopted) {
    log(`The Cloudflare Tunnel app is already running your tunnel ${tunnel.name}; BoxPilot will use it and leave its names as they are.`, "stdout");
    log("No tunnel is made, and the app keeps the key it runs with.", "stdout");
    if (tunnel.localConfig) log(`${tunnel.name} is set up from a file on a machine rather than from Cloudflare, so BoxPilot keeps it running but cannot add a name to it.`, "stderr");
  } else {
    if (replacing) log(`Replacing the tunnel the Cloudflare Tunnel app runs with ${tunnelName}, as you chose. The names the old tunnel serves stop answering until they are moved to ${tunnelName} in Cloudflare.`, "stderr");
    if (!tunnel) tunnel = await api.findTunnel(account.id, tunnelName);
    created = !tunnel;
    if (tunnel && !tunnel.remoteConfig) throw new Error(`A tunnel called ${tunnelName} is already in your Cloudflare account and is set up from a file on a machine rather than from Cloudflare, so BoxPilot cannot change its routes. Delete or rename it in Cloudflare, then connect again.`);
    if (!tunnel) tunnel = await api.createTunnel(account.id, tunnelName);
    log(created ? `Made the tunnel ${tunnelName} in your Cloudflare account.` : `Using the tunnel ${tunnelName} that is already in your Cloudflare account.`, "stdout");
    const runKey = typeof tunnel.runKey === "string" && tunnel.runKey.length >= 20 ? tunnel.runKey : await api.tunnelRunKey(account.id, tunnel.id);
    await credentials.set({ name: cloudflareTunnelCredential, value: runKey });
    log(`Saved the tunnel's key as the root-only credential ${cloudflareTunnelCredential}; it is not written to this log.`, "stdout");
  }

  const before = await state.read().catch(() => null);
  const kept = before?.tunnelId === tunnel.id ? before.routes : [];
  if (before?.tunnelId && before.tunnelId !== tunnel.id) {
    if (before.routes.length) log(`Names BoxPilot published through the tunnel ${before.tunnelName ?? before.tunnelId} are not carried over: ${before.routes.map((route) => route.hostname).join(", ")}. Remove them in Cloudflare if they are no longer wanted.`, "stderr");
    if (adopted) log(`The tunnel ${before.tunnelName ?? before.tunnelId} that BoxPilot used before is no longer used, and nothing runs it. It is still in your Cloudflare account: delete it there if you wish.`, "stdout");
  }
  await state.write({ accountId: account.id, accountName: account.name, tunnelId: tunnel.id, tunnelName: tunnel.name, zones: domains, routes: kept, connectedAt: now().toISOString() });
  return { account: { id: account.id, name: account.name }, tunnel: { id: tunnel.id, name: tunnel.name, created, adopted }, zones: domains, replacedRunning: replacing };
}

/**
 * Publish one name: refuse a name that already points anywhere but this tunnel, or that the tunnel
 * already routes somewhere else for someone else, route the name to the app's port (keeping every
 * other route), add the CNAME (or keep the one that is there), and record it.
 * When the CNAME cannot be added, the routes are put back as they were.
 */
export async function cloudflarePublish(parameters = {}, deps = {}) {
  const { credentials, state, fetcher, log, now } = toolsOf(deps);
  const { hostname, zoneId, service, noTLSVerify = false, appId, portId, hostPort } = parameters;
  if (typeof hostname !== "string" || !hostnamePattern.test(hostname)) throw new Error("The name to publish is not a valid name");
  if (typeof zoneId !== "string" || !idPattern.test(zoneId)) throw new Error("The domain is not one BoxPilot knows");
  if (typeof service !== "string" || !servicePattern.test(service)) throw new Error("The app's address must be on this server's loopback address");
  if (typeof appId !== "string" || !idPattern.test(appId) || typeof portId !== "string" || !idPattern.test(portId) || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error("The app and its port are not valid");
  const current = await connectedState(state);
  const zone = current.zones.find((entry) => entry.id === zoneId);
  if (!zone || !hostname.endsWith(`.${zone.name}`)) throw new Error(`${hostname} is not a name under one of your connected domains`);
  const api = await apiFor(credentials, fetcher);
  const target = tunnelTargetFor(current.tunnelId);

  // A name that already points elsewhere belongs to something else: never replaced.
  const records = await api.dnsRecords(zoneId, hostname);
  const foreign = records.find((record) => !(record.type === "CNAME" && sameName(record.content, target)));
  if (foreign) throw new Error(`${hostname} already points somewhere else; BoxPilot will not replace it. It has a ${foreign.type} record in Cloudflare; choose another name, or remove that record in Cloudflare first.`);
  const ours = records.find((record) => record.type === "CNAME" && sameName(record.content, target)) ?? null;

  // A tunnel BoxPilot took over as it ran (M65.3) may keep its routes in a file on a machine:
  // Cloudflare is asked each time, so one moved to Cloudflare since can be published to at once.
  const tunnel = await api.tunnel(current.accountId, current.tunnelId);
  if (tunnel.localConfig) throw new Error(`BoxPilot cannot add ${hostname} to the tunnel ${current.tunnelName ?? current.tunnelId}: its routes are kept in a file on the machine that set it up, not at Cloudflare, so they cannot be changed from here. Add the name in that file, or move the tunnel's configuration to Cloudflare in the Zero Trust dashboard and publish again. Nothing was changed.`);

  // Routes first: a name that resolves before its route exists shows Cloudflare's 404 page; a route with no name yet is harmless.
  const { config, ingress } = await api.configuration(current.accountId, current.tunnelId);
  // A route for this name that BoxPilot did not record is someone's own (a tunnel taken over as it
  // ran has them): never replaced, even when it goes to the same address, or their rule would lose
  // its own settings and be removed by a later unpublish. One exception, a publish BoxPilot began
  // and its record lost: the same address, and a DNS record for the name that carries BoxPilot's comment.
  const known = current.routes.find((entry) => sameName(entry.hostname, hostname)) ?? null;
  const routed = known ? null : ingress.find((rule) => sameName(rule.hostname, hostname) && !rule.path) ?? null;
  const theirs = routed && !(routed.service === service && ours?.comment.startsWith(recordComment)) ? routed : null;
  if (theirs) throw new Error(`${hostname} is already routed by your tunnel${typeof theirs.service === "string" ? ` to ${theirs.service.slice(0, 120)}` : ""}, and BoxPilot did not add that route, so it will not replace it. Choose another name, or remove that route in Cloudflare first. Nothing was changed.`);
  const next = withRoute(ingress, { hostname, service, originRequest: noTLSVerify ? { noTLSVerify: true } : {} });
  await api.setConfiguration(current.accountId, current.tunnelId, { ...config, ingress: next });
  log(`The tunnel now sends ${hostname} to ${service}${noTLSVerify ? " (HTTPS, the app's own certificate not checked)" : ""}; ${next.length - 2 === 0 ? "no other routes" : `${next.length - 2} other route${next.length - 2 === 1 ? "" : "s"} kept`}.`, "stdout");

  let record = ours;
  if (!record) {
    try {
      record = await api.createCname(zoneId, { name: hostname, target, comment: `${recordComment} ${appId}` });
    } catch (error) {
      // Nothing has recorded the route yet, so left in place it is one unpublishing refuses as not
      // BoxPilot's. The routes go back exactly as they were read, other names' and all.
      const restored = await api.setConfiguration(current.accountId, current.tunnelId, config).then(() => null, (failure) => failure);
      if (!restored) {
        log(`Put the tunnel's routes back as they were: ${hostname} no longer goes to ${service}.`, "stderr");
        throw Object.assign(new Error(`${error.message}. The route the tunnel was given for ${hostname} was rolled back, so nothing changed.`), { rolledBack: true });
      }
      log(`Could not take ${hostname}'s route back out of the tunnel: ${restored.message}`, "stderr");
      // The route is BoxPilot's and still there: recorded with no DNS record, so publishing again
      // finishes it and unpublishing takes it out, where an unrecorded route is left as someone else's.
      const left = await connectedState(state);
      await state.write({ ...left, routes: [...left.routes.filter((entry) => !sameName(entry.hostname, hostname)), { hostname, zoneId, dnsRecordId: null, appId, portId, hostPort, service, publishedAt: now().toISOString() }] }).catch(() => {});
      throw Object.assign(new Error(`${error.message}, and taking its route back out of the tunnel also failed (${restored.message}). The tunnel still sends ${hostname} to ${service}: Publish it again to finish, or unpublish it to take the route out.`), { rolledBack: false });
    }
  }
  // A record that was there already is BoxPilot's only when it made it: the one this name was
  // recorded with, or one that carries BoxPilot's comment. Any other is kept and never removed later.
  const made = !ours || known?.dnsRecordId === ours.id || ours.comment.startsWith(recordComment);
  log(!ours ? `Added ${hostname} to ${zone.name}, pointing at this tunnel through Cloudflare.` : made ? `${hostname} already points at this tunnel; kept it.` : `${hostname} already points at this tunnel through a DNS record BoxPilot did not make; kept it, and unpublishing will leave it.`, "stdout");

  const latest = await connectedState(state);
  const route = { hostname, zoneId, dnsRecordId: made ? record.id : null, appId, portId, hostPort, service, publishedAt: now().toISOString() };
  await state.write({ ...latest, routes: [...latest.routes.filter((entry) => !sameName(entry.hostname, hostname)), route] });
  return { url: `https://${hostname}`, hostname, appId, dnsRecord: ours ? "kept" : "added" };
}

/**
 * Unpublish one name BoxPilot published: take its route out (keeping every other), delete its DNS
 * record only when it is the one BoxPilot made and it still points at this tunnel, and forget it.
 * @param {{ hostname?: string }} [parameters]
 */
export async function cloudflareUnpublish({ hostname } = {}, deps = {}) {
  const { credentials, state, fetcher, log } = toolsOf(deps);
  if (typeof hostname !== "string" || !hostnamePattern.test(hostname)) throw new Error("The name to unpublish is not a valid name");
  const current = await connectedState(state);
  const route = current.routes.find((entry) => sameName(entry.hostname, hostname));
  if (!route) throw new Error(`BoxPilot did not publish ${hostname}, so it leaves it alone; change it in the Cloudflare dashboard`);
  const api = await apiFor(credentials, fetcher);

  const { config, ingress } = await api.configuration(current.accountId, current.tunnelId);
  if (routeNames(ingress).includes(hostname.toLowerCase())) {
    await api.setConfiguration(current.accountId, current.tunnelId, { ...config, ingress: withoutRoute(ingress, hostname) });
    log(`The tunnel no longer sends ${hostname} anywhere; its other routes are as they were.`, "stdout");
  } else {
    log(`The tunnel had no route for ${hostname} any more.`, "stdout");
  }

  const target = tunnelTargetFor(current.tunnelId);
  const records = await api.dnsRecords(route.zoneId, hostname);
  const recorded = route.dnsRecordId ? records.find((record) => record.id === route.dnsRecordId) ?? null : null;
  let dnsRemoved = false;
  let note = null;
  if (recorded && recorded.type === "CNAME" && sameName(recorded.content, target)) {
    await api.deleteDnsRecord(route.zoneId, recorded.id);
    dnsRemoved = true;
    log(`Removed ${hostname} from your domain.`, "stdout");
  } else if (recorded) {
    note = `${hostname} was changed in Cloudflare since BoxPilot made it and no longer points at this tunnel, so BoxPilot left it.`;
  } else if (records.length) {
    note = `${hostname} has a DNS record BoxPilot did not make, so BoxPilot left it.`;
  } else {
    note = `${hostname} was already gone from your domain.`;
  }
  if (note) log(note, "stdout");

  const latest = await connectedState(state);
  await state.write({ ...latest, routes: latest.routes.filter((entry) => !sameName(entry.hostname, hostname)) });
  return { hostname, dnsRemoved, ...(note ? { note } : {}) };
}

/** Ask Cloudflare how the tunnel is: its health, how many connectors hold it up, and the names it routes. */
export async function cloudflareCheck(_parameters = {}, deps = {}) {
  const { credentials, state, fetcher, now } = toolsOf(deps);
  const current = await connectedState(state);
  const api = await apiFor(credentials, fetcher);
  const [tunnel, { ingress }] = await Promise.all([api.tunnel(current.accountId, current.tunnelId), api.configuration(current.accountId, current.tunnelId)]);
  // A connector holds several connections (one per Cloudflare location); count the connectors.
  const connectors = new Set(tunnel.connections.map((connection, index) => (typeof connection.client_id === "string" ? connection.client_id : `connection-${index}`))).size;
  return { status: tunnel.status ?? "unknown", connectors, routesAtCloudflare: routeNames(ingress), checkedAt: now().toISOString() };
}
