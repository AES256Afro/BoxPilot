/**
 * Cloudflare Tunnel's network half (M42, ADR-011): the root tasks that talk to Cloudflare. Tasks,
 * because the helper has no network (PrivateNetwork=true). Each reads the owner's API token from the
 * credential store itself, uses it in one header, and returns only names and ids: never the token,
 * never the tunnel's key. Each writes what it made to BoxPilot's Cloudflare record before it returns,
 * so the record and Cloudflare agree even when the helper never hears back.
 *
 * Two rules hold everywhere: a DNS name that points anywhere but this tunnel is never replaced or
 * removed, and a route BoxPilot did not make is never touched. The helper side is
 * server/ops/cloudflare.mjs; the client and the route rules are server/cloudflare-api.mjs.
 */
import { createCloudflareApi, routeNames, withRoute, withoutRoute } from "../cloudflare-api.mjs";
import { cloudflareApiCredential, cloudflareTunnelCredential, createTunnelStateStore, hostnamePattern, sameName, servicePattern, tunnelNamePattern, tunnelTargetFor } from "../cloudflare-tunnel.mjs";
import { createCredentialStore } from "../credentials.mjs";

const idPattern = /^[A-Za-z0-9-]{1,64}$/;

/** The task's tools: the credential store, the record, and a fetch that tests replace. */
function toolsOf({ credentials = createCredentialStore(), state = createTunnelStateStore(), fetcher = fetch, log = () => {}, now = () => new Date() } = {}) {
  return { credentials, state, fetcher, log, now };
}

async function apiFor(credentials, fetcher) {
  const token = await credentials.read(cloudflareApiCredential);
  if (!token) throw new Error("BoxPilot has no Cloudflare API token: connect Cloudflare first (the App catalog, Cloudflare Tunnel, Tunnel tab)");
  return createCloudflareApi({ token, fetcher });
}

async function connectedState(state) {
  const current = await state.read();
  if (!current?.accountId || !current.tunnelId) throw new Error("Cloudflare is not connected yet: connect it first (the App catalog, Cloudflare Tunnel, Tunnel tab)");
  return current;
}

/**
 * Connect: check the token, learn the account and its domains, find this server's tunnel or make
 * it, and save the tunnel's key as a credential for the Cloudflare Tunnel app. Routes recorded for
 * the same tunnel are kept; nothing is published.
 */
export async function cloudflareConnect({ tunnelName } = {}, deps = {}) {
  const { credentials, state, fetcher, log, now } = toolsOf(deps);
  if (typeof tunnelName !== "string" || !tunnelNamePattern.test(tunnelName)) throw new Error("The tunnel's name must be boxpilot- and this server's name");
  const api = await apiFor(credentials, fetcher);
  const zones = await api.listZones();
  if (!zones.length) throw new Error("Cloudflare accepted the token, but it covers no active domain. Give it Zone · Zone · Read and Zone · DNS · Edit for the domain you want to use, then connect again.");
  const account = zones.find((zone) => zone.account)?.account ?? null;
  if (!account) throw new Error("Cloudflare did not say which account your domains belong to; check the token's Account permission");
  const domains = zones.filter((zone) => zone.account?.id === account.id).map((zone) => ({ id: zone.id, name: zone.name }));
  log(`Cloudflare accepted the token: ${domains.length === 1 ? "1 domain" : `${domains.length} domains`} in the account ${account.name} (${domains.map((zone) => zone.name).join(", ")}).`, "stdout");
  if (domains.length < zones.length) log("The token also covers domains in another Cloudflare account; BoxPilot uses this one.", "stdout");

  let tunnel = await api.findTunnel(account.id, tunnelName);
  const created = !tunnel;
  if (tunnel && !tunnel.remoteConfig) throw new Error(`A tunnel called ${tunnelName} is already in your Cloudflare account and is set up from a file on a machine rather than from Cloudflare, so BoxPilot cannot change its routes. Delete or rename it in Cloudflare, then connect again.`);
  if (!tunnel) tunnel = await api.createTunnel(account.id, tunnelName);
  log(created ? `Made the tunnel ${tunnelName} in your Cloudflare account.` : `Using the tunnel ${tunnelName} that is already in your Cloudflare account.`, "stdout");
  const runKey = typeof tunnel.runKey === "string" && tunnel.runKey.length >= 20 ? tunnel.runKey : await api.tunnelRunKey(account.id, tunnel.id);
  await credentials.set({ name: cloudflareTunnelCredential, value: runKey });
  log(`Saved the tunnel's key as the root-only credential ${cloudflareTunnelCredential}; it is not written to this log.`, "stdout");

  const before = await state.read().catch(() => null);
  const kept = before?.tunnelId === tunnel.id ? before.routes : [];
  if (before?.tunnelId && before.tunnelId !== tunnel.id && before.routes.length) log(`Names BoxPilot published through the tunnel ${before.tunnelName ?? before.tunnelId} are not carried over: ${before.routes.map((route) => route.hostname).join(", ")}. Remove them in Cloudflare if they are no longer wanted.`, "stderr");
  await state.write({ accountId: account.id, accountName: account.name, tunnelId: tunnel.id, tunnelName: tunnel.name, zones: domains, routes: kept, connectedAt: now().toISOString() });
  return { account: { id: account.id, name: account.name }, tunnel: { id: tunnel.id, name: tunnel.name, created }, zones: domains };
}

/**
 * Publish one name: refuse a name that already points anywhere but this tunnel, route the name to
 * the app's port (keeping every other route), add the CNAME (or keep BoxPilot's own), and record it.
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

  // Routes first: a name that resolves before its route exists shows Cloudflare's 404 page; a route with no name yet is harmless.
  const { config, ingress } = await api.configuration(current.accountId, current.tunnelId);
  const next = withRoute(ingress, { hostname, service, originRequest: noTLSVerify ? { noTLSVerify: true } : {} });
  await api.setConfiguration(current.accountId, current.tunnelId, { ...config, ingress: next });
  log(`The tunnel now sends ${hostname} to ${service}${noTLSVerify ? " (HTTPS, the app's own certificate not checked)" : ""}; ${next.length - 2 === 0 ? "no other routes" : `${next.length - 2} other route${next.length - 2 === 1 ? "" : "s"} kept`}.`, "stdout");

  let record = ours;
  if (!record) {
    try {
      record = await api.createCname(zoneId, { name: hostname, target, comment: `BoxPilot: ${appId}` });
    } catch (error) {
      // Nothing has recorded the route yet, so left in place it is one unpublishing refuses as not
      // BoxPilot's. The routes go back exactly as they were read, other names' and all.
      const restored = await api.setConfiguration(current.accountId, current.tunnelId, config).then(() => null, (failure) => failure);
      if (!restored) {
        log(`Put the tunnel's routes back as they were: ${hostname} no longer goes to ${service}.`, "stderr");
        throw Object.assign(new Error(`${error.message}. The route the tunnel was given for ${hostname} was rolled back, so nothing changed.`), { rolledBack: true });
      }
      log(`Could not take ${hostname}'s route back out of the tunnel: ${restored.message}`, "stderr");
      throw Object.assign(new Error(`${error.message}, and taking its route back out of the tunnel also failed (${restored.message}). The tunnel still sends ${hostname} to ${service}: Publish it again to finish, or remove that route in the Cloudflare dashboard.`), { rolledBack: false });
    }
  }
  log(ours ? `${hostname} already points at this tunnel; kept it.` : `Added ${hostname} to ${zone.name}, pointing at this tunnel through Cloudflare.`, "stdout");

  const latest = await connectedState(state);
  const route = { hostname, zoneId, dnsRecordId: record.id, appId, portId, hostPort, service, publishedAt: now().toISOString() };
  await state.write({ ...latest, routes: [...latest.routes.filter((entry) => !sameName(entry.hostname, hostname)), route] });
  return { url: `https://${hostname}`, hostname, appId, dnsRecord: ours ? "kept" : "added" };
}

/**
 * Unpublish one name BoxPilot published: take its route out (keeping every other), delete its DNS
 * record only when it is the one BoxPilot made and it still points at this tunnel, and forget it.
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
