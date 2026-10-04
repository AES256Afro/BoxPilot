import { useCallback, useEffect, useMemo, useState } from "react";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, SecretInput, Select, Table, TextInput, mayStart, riskOf, type KeyValueItem, type Status, type TableColumn } from "../../ui";
import { isPaused, isRunning } from "./appState";
import type { CatalogContext, Entry, ManifestPort } from "./types";

/*
 * The Cloudflare Tunnel app's Tunnel tab (M42, ADR-011): publish an app on this server to the
 * internet at a name on the owner's own domain, without the Cloudflare dashboard or the router.
 * Connect once with an API token; then each app is one form and one approval at its tier. Owner
 * only. What BoxPilot published is read from its own record (cloudflare.tunnel.inspect); asking
 * Cloudflare itself is a button. No token is ever shown back.
 */

export interface TunnelRoute { hostname: string; url: string; appId: string | null; portId: string | null; hostPort: number | null; service: string | null; publishedAt: string | null }
export interface TunnelState {
  connected: boolean;
  account: { id: string; name: string } | null;
  tunnel: { id: string; name: string } | null;
  plannedTunnelName: string;
  zones: Array<{ id: string; name: string }>;
  routes: TunnelRoute[];
  connectedAt: string | null;
  problem: string | null;
}
interface TunnelCheck { status: string; connectors: number; routesAtCloudflare: string[]; checkedAt: string }

/** What the token needs, as Cloudflare's token page names them (server/cloudflare-api.mjs says the same). */
export const tokenPermissions = ["Account · Cloudflare Tunnel · Edit", "Zone · DNS · Edit", "Zone · Zone · Read"];
export const tokenPage = "https://dash.cloudflare.com/profile/api-tokens";
const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Addresses the tunnel app, on the host's own network, reaches as 127.0.0.1 (server/ops/cloudflare.mjs). */
const reachableBinds = new Set(["", "*", "0.0.0.0", "::", "[::]", "127.0.0.1"]);

/** Why a name cannot be used, said before staging; the server checks the same. */
export function nameProblem(name: string): string | undefined {
  if (!name) return undefined;
  if (name.includes(".")) return "One word only; the domain is chosen beside it";
  if (!labelPattern.test(name)) return "Lower-case letters, digits and dashes, not starting or ending with a dash, 63 at most";
  return undefined;
}

/** Whether a pasted token can be one: the server checks the same, and Cloudflare the rest. */
export function tokenProblem(token: string): string | undefined {
  if (!token) return undefined;
  if (/\s/.test(token)) return "A token has no spaces in it; paste just the token";
  if (token.length < 20) return "That is too short to be a Cloudflare API token";
  return undefined;
}

const healthOf = (status: string): { status: Status; words: string } => ({
  healthy: { status: "good" as Status, words: "Healthy" },
  degraded: { status: "warning" as Status, words: "Degraded: some connections are down" },
  down: { status: "danger" as Status, words: "Down: no connector is running it" },
  inactive: { status: "danger" as Status, words: "Not running yet: no connector has ever started it" },
})[status] ?? { status: "unknown", words: status || "Unknown" };

interface Choice { entry: Entry; ports: Array<{ port: ManifestPort; hostPort: number; bind: string | null }> }

/** Installed apps with a TCP port the tunnel could send visitors to, and each port's number here. */
function publishable(entries: Entry[]): Choice[] {
  return entries
    .filter((entry) => entry.live?.installed && entry.manifest.id !== "cloudflared")
    .map((entry) => {
      const live = entry.live!;
      const hostNetwork = (live.state?.values?.networkMode ?? entry.manifest.network) === "host";
      const ports = entry.manifest.ports.filter((port) => port.protocol === "tcp").map((port) => ({
        port,
        hostPort: hostNetwork ? port.container : live.state?.values?.ports?.[port.id] ?? port.host,
        bind: live.published?.find((published) => published.id === port.id && published.protocol === "tcp")?.bind ?? null,
      }));
      return { entry, ports };
    })
    .filter((choice) => choice.ports.length > 0)
    .sort((a, b) => a.entry.manifest.name.localeCompare(b.entry.manifest.name));
}

/** The port to offer first: the app's web interface, else its first TCP port. */
const firstPort = (choice: Choice | undefined) => (choice ? (choice.ports.find((entry) => choice.entry.live?.urls.some((url) => url.id === entry.port.id)) ?? choice.ports[0]).port.id : "");

export function TunnelTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { act, role, data } = ctx;
  const may = (operationId: string) => mayStart(role, operationId);
  const [state, setState] = useState<TunnelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [check, setCheck] = useState<TunnelCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [appId, setAppId] = useState("");
  const [portId, setPortId] = useState("");
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [https, setHttps] = useState(false);

  const read = useCallback(async () => {
    try {
      const { result } = await inspectOperation<TunnelState>("cloudflare.tunnel.inspect");
      setState(result);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The tunnel could not be read");
    }
  }, []);
  useEffect(() => { void read(); }, [read]);

  const askCloudflare = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const { result } = await inspectOperation<TunnelCheck>("cloudflare.tunnel.check");
      setCheck(result);
    } catch (requestError) {
      setCheck(null);
      setCheckError(requestError instanceof Error ? requestError.message : "Cloudflare could not be asked");
    } finally {
      setChecking(false);
    }
  };

  const choices = useMemo(() => publishable(data.applications), [data.applications]);
  const choice = choices.find((candidate) => candidate.entry.manifest.id === appId);
  const nameOf = (id: string | null) => data.applications.find((candidate) => candidate.manifest.id === id)?.manifest.name ?? id ?? "an app";
  const zones = state?.zones ?? [];
  const chosenDomain = zones.some((zone) => zone.name === domain) ? domain : zones[0]?.name ?? "";
  const chosenPort = choice?.ports.find((entry) => entry.port.id === portId) ?? null;
  const fqdn = name && !nameProblem(name) && chosenDomain ? `${name}.${chosenDomain}` : null;
  const taken = Boolean(fqdn && state?.routes.some((route) => route.hostname === fqdn && route.appId !== appId));
  const offServer = Boolean(chosenPort?.bind && !reachableBinds.has(chosenPort.bind));

  const pickApp = (id: string) => {
    const next = choices.find((candidate) => candidate.entry.manifest.id === id);
    // The name follows the app until the owner types one of their own.
    if (!name || name === appId) setName(id);
    setAppId(id);
    setPortId(firstPort(next));
    setHttps(false);
  };

  if (error) return <div className="catalog-tab"><Notice tone="danger" live title="The tunnel could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice></div>;
  if (!state) return <div className="catalog-tab"><p className="catalog-quiet">Reading…</p></div>;

  const live = entry.live;
  const appInstalled = Boolean(live?.installed);
  const appRunning = isRunning(live);
  const published = state.routes;
  const atCloudflare = check ? new Set(check.routesAtCloudflare) : null;
  const elsewhere = check ? check.routesAtCloudflare.filter((hostname) => !published.some((route) => route.hostname === hostname)) : [];

  const connect = () => act({
    operationId: "cloudflare.connect",
    title: "Connect Cloudflare",
    parameters: { token },
    preview: <span>Checks the token with Cloudflare and saves it on this server, readable by root only. Then BoxPilot uses the tunnel called <code>{state.tunnel?.name ?? state.plannedTunnelName}</code> in your Cloudflare account, or makes it if it is not there, and {appInstalled ? <>gives the Cloudflare Tunnel app that tunnel&apos;s key, <strong>replacing the token it runs with now</strong></> : <>installs the Cloudflare Tunnel app with that tunnel&apos;s key</>}. Nothing is published yet.</span>,
  });

  const publish = () => {
    if (!choice || !chosenPort || !fqdn) return;
    const appName = choice.entry.manifest.name;
    act({
      operationId: "cloudflare.publish",
      title: `Publish ${appName} at ${fqdn}`,
      parameters: { appId: choice.entry.manifest.id, portId: chosenPort.port.id, domain: chosenDomain, name, ...(https ? { https: true } : {}) },
      preview: (
        <span>
          Makes {appName} reachable by <strong>anyone on the internet</strong> at <code>https://{fqdn}</code>. Cloudflare adds the name to {chosenDomain} and sends visitors through your tunnel to port {chosenPort.hostPort} on this server; no port is opened on your router. There is no login in front of it: <strong>{appName}&apos;s own sign-in is the only lock</strong>, so make sure it has one. If {fqdn} already points somewhere else, nothing is changed.
          {choice.entry.manifest.id === "pingvin-share" && <> For {appName}: set <strong>Behind a reverse proxy</strong> to Yes in its Settings here, and its <strong>App URL</strong> to <code>https://{fqdn}</code> in {appName}&apos;s own configuration, so the links it hands out use the new address.</>}
        </span>
      ),
    });
  };

  const unpublish = (route: TunnelRoute) => act({
    operationId: "cloudflare.unpublish",
    title: `Stop publishing ${route.hostname}`,
    parameters: { hostname: route.hostname },
    preview: <span>Takes <code>{route.url}</code> off the internet: removes it from your tunnel and deletes the DNS name BoxPilot made for it. {nameOf(route.appId)} keeps running on this server, reachable as before.</span>,
  });

  const disconnect = () => act({
    operationId: "cloudflare.disconnect",
    title: "Disconnect Cloudflare",
    parameters: {},
    preview: <span>Forgets your Cloudflare API token. The tunnel keeps running{published.length ? <>, and {published.length === 1 ? "the app published through it stays" : `the ${published.length} apps published through it stay`} on the internet</> : null}: the Cloudflare Tunnel app runs with the tunnel&apos;s own key, which stays. To publish or unpublish later, connect again.</span>,
  });

  const routeColumns: Array<TableColumn<TunnelRoute>> = [
    { id: "app", header: "App", cell: (route) => <strong>{nameOf(route.appId)}</strong>, sortValue: (route) => nameOf(route.appId) },
    { id: "address", header: "Address", cell: (route) => <a href={route.url} target="_blank" rel="noreferrer"><code>{route.url}</code></a> },
    { id: "port", header: "Port here", numeric: true, hideOnPhone: true, cell: (route) => route.hostPort ?? "—" },
    ...(atCloudflare ? [{ id: "cloudflare", header: "At Cloudflare", cell: (route: TunnelRoute) => (atCloudflare.has(route.hostname) ? "Routed" : "Missing") }] : []),
    ...(state.connected && may("cloudflare.unpublish") ? [{ id: "actions", header: "", label: "Actions", className: "catalog-actions-cell", cell: (route: TunnelRoute) => <span className="catalog-actions"><Button risk={riskOf("cloudflare.unpublish")} aria-label={`Unpublish ${route.hostname}`} onClick={() => unpublish(route)}>Unpublish</Button></span> }] : []),
  ];
  const routeTable = (
    <Table<TunnelRoute>
      caption="Apps published through the tunnel"
      columns={routeColumns}
      rows={published}
      rowKey={(route) => route.hostname}
      rowStatus={(route) => (atCloudflare && !atCloudflare.has(route.hostname) ? "warning" : undefined)}
      stackOnPhone
      empty={<EmptyState title="Nothing is published yet">Publish an app below and it is listed here with its address.</EmptyState>}
    />
  );

  // ── Not connected: what this does, what the token needs, and the token. ──
  if (!state.connected) {
    const problem = tokenProblem(token);
    return (
      <div className="catalog-tab">
        {state.problem && <Notice tone="danger" title="BoxPilot's Cloudflare record could not be read">{state.problem}</Notice>}
        <Panel level={3} title="Connect Cloudflare" padded className="catalog-tunnel">
          <p className="catalog-tunnel__lead">Publish an app on this server to the internet at a name on your own domain, such as <code>share.yourdomain.com</code>, without opening a port on your router. Cloudflare serves it over HTTPS and the tunnel connects out from this server. Your domain has to be on Cloudflare.</p>
          <p className="catalog-tunnel__lead">Make an API token at <a href={tokenPage} target="_blank" rel="noreferrer">Cloudflare&apos;s API tokens page</a> (Create Token, then Create Custom Token) with these three permissions, for your account and the domain you want to use:</p>
          <ul className="catalog-tunnel__permissions">{tokenPermissions.map((permission) => <li key={permission}>{permission}</li>)}</ul>
          {may("cloudflare.connect") && (
            <form className="catalog-tunnel__form" aria-label="Connect Cloudflare" onSubmit={(event) => { event.preventDefault(); if (token && !problem) connect(); }}>
              <Field label="API token" hint="Saved on this server, readable by root only; never shown again." error={problem}>
                <SecretInput value={token} onValueChange={(value) => setToken(value.trim())} />
              </Field>
              <div className="catalog-sheet__actions">
                <Button type="submit" variant="primary" risk={riskOf("cloudflare.connect")} disabled={!token || Boolean(problem)}>Connect Cloudflare</Button>
              </div>
            </form>
          )}
        </Panel>
        {published.length > 0 && (
          <Panel level={3} title="Still published" count={published.length} className="catalog-tunnel">
            <p className="catalog-quiet">These stay on the internet through the tunnel. Connect again to unpublish them or publish more.</p>
            {routeTable}
          </Panel>
        )}
      </div>
    );
  }

  // ── Connected: the tunnel, what is published, and publishing one more. ──
  const health = check ? healthOf(check.status) : null;
  const facts: KeyValueItem[] = [
    { id: "account", label: "Cloudflare account", value: state.account?.name ?? "unknown" },
    { id: "tunnel", label: "Tunnel", mono: true, value: state.tunnel?.name ?? "none yet" },
    { id: "domains", label: zones.length === 1 ? "Domain" : "Domains", mono: true, value: zones.length ? zones.map((zone) => zone.name).join(" · ") : "none" },
    {
      id: "health", label: "At Cloudflare", status: health?.status,
      value: health ? `${health.words}${check!.connectors ? `, ${check!.connectors} connector${check!.connectors === 1 ? "" : "s"}` : ""}` : "Not asked yet",
      hint: check ? `asked ${new Date(check.checkedAt).toLocaleTimeString()}` : undefined,
    },
  ];
  const canPublish = Boolean(choice && chosenPort && fqdn && !taken && !offServer);

  return (
    <div className="catalog-tab">
      {!appInstalled && <Notice tone="warning" title="The Cloudflare Tunnel app is not installed">Nothing published can be reached until it runs. Publishing an app installs it again with your tunnel&apos;s key.</Notice>}
      {appInstalled && !appRunning && <Notice tone="warning" title={`The Cloudflare Tunnel app is ${isPaused(live) ? "paused" : "not running"}`}>Nothing published can be reached until it runs. Start it from the Overview tab, or publish an app, which starts it.</Notice>}
      {state.problem && <Notice tone="danger" title="BoxPilot's Cloudflare record could not be read">{state.problem}</Notice>}
      <KeyValue layout="rows" className="catalog-facts" items={facts} />
      <div className="catalog-sheet__actions">
        <Button busy={checking} onClick={() => void askCloudflare()}>Check with Cloudflare</Button>
      </div>
      {checkError && <Notice tone="danger" live title="Cloudflare could not be asked">{checkError}</Notice>}
      {check && published.some((route) => !atCloudflare!.has(route.hostname)) && <Notice tone="warning" title="Cloudflare no longer routes some of these">A name marked Missing was removed from the tunnel in the Cloudflare dashboard. Publish it again to put it back, or unpublish it to tidy up.</Notice>}
      {elsewhere.length > 0 && <Notice tone="info" title="The tunnel also routes names BoxPilot did not add">{elsewhere.join(", ")}. They were set up in the Cloudflare dashboard; BoxPilot leaves them alone.</Notice>}

      <Panel level={3} title="Published apps" count={published.length} className="catalog-tunnel">{routeTable}</Panel>

      {may("cloudflare.publish") && (
        <Panel level={3} title="Publish an app" padded className="catalog-tunnel">
          {choices.length === 0
            ? <EmptyState title="No app to publish">Install an app with a web page first, such as Pingvin Share.</EmptyState>
            : (
              <form className="catalog-tunnel__form" aria-label="Publish an app" onSubmit={(event) => { event.preventDefault(); if (canPublish) publish(); }}>
                <div className="catalog-tunnel__fields">
                  <Field label="App">
                    <Select placeholder="Choose an app" options={choices.map((candidate) => ({ value: candidate.entry.manifest.id, label: candidate.entry.manifest.name }))} value={appId} onValueChange={pickApp} />
                  </Field>
                  {choice && choice.ports.length > 1 && (
                    <Field label="Port">
                      <Select options={choice.ports.map((candidate) => ({ value: candidate.port.id, label: `${candidate.port.label} (${candidate.hostPort})` }))} value={portId} onValueChange={setPortId} />
                    </Field>
                  )}
                  <Field label="Name" hint={fqdn ? <>Its address will be <code>https://{fqdn}</code></> : "One word, such as share"} error={nameProblem(name) ?? (taken ? `${fqdn} is already published for another app` : undefined)}>
                    <TextInput mono value={name} onValueChange={(value) => setName(value.trim().toLowerCase())} />
                  </Field>
                  <Field label="Domain">
                    <Select mono options={zones.map((zone) => ({ value: zone.name, label: zone.name }))} value={chosenDomain} onValueChange={setDomain} />
                  </Field>
                </div>
                {choice && <Checkbox label="This port speaks HTTPS" description="Only for an app that serves HTTPS itself on this port; its own certificate is not checked." checked={https} onChange={setHttps} />}
                {offServer && <Notice tone="warning" title={`${choice!.entry.manifest.name} cannot be reached on that port from the tunnel`}>It listens only at {chosenPort!.bind}. On its Reach tab, publish it on your home network first.</Notice>}
                {fqdn && <p className="catalog-tunnel__preview">Anyone on the internet will be able to open <code>https://{fqdn}</code>. {choice ? `${choice.entry.manifest.name}'s own sign-in is the only lock.` : ""}</p>}
                {choice?.entry.manifest.id === "pingvin-share" && fqdn && <Notice tone="info" title={`Two settings in ${choice.entry.manifest.name}`}>Set Behind a reverse proxy to Yes in its Settings here, and its App URL to https://{fqdn} in {choice.entry.manifest.name}&apos;s own configuration, so its share links use the new address.</Notice>}
                <div className="catalog-sheet__actions">
                  <Button type="submit" variant="primary" risk={riskOf("cloudflare.publish")} disabled={!canPublish}>Publish</Button>
                </div>
              </form>
            )}
        </Panel>
      )}

      {may("cloudflare.disconnect") && (
        <div className="catalog-sheet__more catalog-tunnel__disconnect">
          <p className="catalog-quiet">Disconnecting forgets your API token only. The tunnel and the apps published through it keep working; connect again to change them.</p>
          <Button risk={riskOf("cloudflare.disconnect")} onClick={disconnect}>Disconnect Cloudflare</Button>
        </div>
      )}
    </div>
  );
}
