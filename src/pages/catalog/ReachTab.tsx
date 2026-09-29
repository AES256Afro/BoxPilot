import { useState } from "react";
import { appAddresses } from "../../appLinks";
import { Button, EmptyState, KeyValue, Notice, Panel, Tag, mayStart, riskOf } from "../../ui";
import { runRead } from "./appState";
import type { CatalogContext, Entry, ManifestPort } from "./types";

/*
 * Who can reach an app, and how (M33.11): every address it answers on from here, whether it is on
 * the home network or only on the tailnet with the switch between the two, a check of each address
 * from the server itself for "can't reach it?", and the wiring between it and the other apps.
 */

/** Whether an app listens on the home network or only through Tailscale. */
export function reachOf(entry: Entry): { tailnetOnly: boolean } {
  const live = entry.live;
  // Tailnet-only is not just a firewall rule: the container stops listening on the network, so the
  // only way in is through Tailscale, which authenticates before the app sees anyone. An empty link
  // list must not read as "all loopback": a database with only a protocol port is on the home
  // network until the owner says otherwise.
  return { tailnetOnly: live?.state?.values?.exposure === "tailnet" || (Boolean(live?.urls.length) && Boolean(live?.urls.every((url) => url.exposure === "loopback"))) };
}

interface Report { headline: string | null; addresses: Array<{ kind: string; url: string; portLabel: string | null; outcome: string; verdict: string | null; note: string | null }> }

export function ReachTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { manifest, live } = entry;
  const { data, serves, act, role, csrfToken } = ctx;
  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  if (!live) return null;
  const https = manifest.id === "portainer";

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const { response, body } = await runRead<Report>(csrfToken, "app.reachability.inspect", { id: manifest.id });
      if (!response.ok || !body.result) throw new Error(body.error ?? "The check could not run");
      setReport({ headline: body.result.headline ?? null, addresses: body.result.addresses ?? [] });
    } catch (requestError) {
      setReport(null);
      setCheckError(requestError instanceof Error ? requestError.message : "The check could not run");
    } finally {
      setChecking(false);
    }
  };

  // ── Home network or tailnet only, and the switch between them. ──
  // Only an app's HTTP ports can go through Tailscale Serve. The rest move to the tailnet address,
  // or stay on the LAN when the home network depends on them (DNS on 53, a reverse proxy's 80 and
  // 443, UniFi's inform port). Saying which is which up front is the difference between an
  // informed choice and an app that half works afterwards.
  const publicPorts = (manifest.ports ?? []).filter((port) => port.exposure !== "loopback");
  const hostNetwork = (live.state?.values?.networkMode ?? manifest.network) === "host";
  const exposable = serves !== null && !hostNetwork && publicPorts.length > 0 && (live.urls.length > 0 || publicPorts.length > 0);
  const servePorts = publicPorts.filter((port) => port.protocol !== "udp" && (port.tailnet ?? "serve") === "serve");
  const stayOnLan = publicPorts.filter((port) => (port.tailnet ?? (port.protocol === "udp" ? "unchanged" : "serve")) === "unchanged");
  const moveToTailnet = publicPorts.filter((port) => port.tailnet === "address");
  const primaryPort = servePorts[0] ? (live.state?.values?.ports?.[servePorts[0].id] ?? servePorts[0].host) : live.urls[0]?.host;
  const served = (serves ?? []).find((serve) => serve.port === primaryPort);
  const names = (ports: ManifestPort[]) => ports.map((port) => port.label).join(", ");
  const { tailnetOnly } = reachOf(entry);
  const addresses = live.urls.flatMap((port) => appAddresses(port, { lanAddress: data.host.lanAddress ?? null, tailnetDnsName: data.host.tailscaleDnsName ?? null, serves: serves ?? [], https }).map((address) => ({ port, address })));
  const toLan = () => act({ operationId: "app.exposure.set", title: `Publish ${manifest.name} on your home network`, parameters: { id: manifest.id, mode: "lan" }, preview: <span>Recreates {manifest.name} listening on this server's network address{primaryPort ? <> on port {primaryPort}</> : null}{servePorts.length > 0 ? ", and stops publishing it on your tailnet" : ""}. Anything on your home network will be able to reach it. The firewall is then the only thing deciding who can.</span> });
  const toTailnet = () => act({ operationId: "app.exposure.set", title: `Make ${manifest.name} reachable only through Tailscale`, parameters: { id: manifest.id, mode: "tailnet" }, preview: <span>{servePorts.length > 0
    ? <>Recreates {manifest.name} so its web interface no longer listens on your home network, then publishes it at <code>https://…ts.net:{primaryPort}</code> with a real certificate. Tailscale authenticates every visitor before {manifest.name} sees them; nothing is opened on your router.</>
    : <>Recreates {manifest.name} so it no longer listens on your home network. It has no web interface to publish through Tailscale Serve, so nothing gets a certificate; being on your tailnet is what lets a machine reach it.</>}{moveToTailnet.length > 0 && <> {names(moveToTailnet)} {moveToTailnet.length === 1 ? "does not speak HTTP, so it moves to" : "do not speak HTTP, so they move to"} this server's tailnet address, reachable from your tailnet and nowhere else.</>}{stayOnLan.length > 0 && <> {names(stayOnLan)} {stayOnLan.length === 1 ? "stays" : "stay"} on your home network, because that is what {stayOnLan.length === 1 ? "it serves" : "they serve"}.</>}</span> });

  // ── The wiring between apps, in both directions, with real addresses. An app reaches another
  // through this server's LAN address and the target's chosen port; each catalog app is its own
  // compose project, so container names do not resolve across them. ──
  const lan = data.host.lanAddress ?? null;
  const portOf = (target: Entry) => target.live?.urls?.[0]?.host ?? target.manifest.ports?.[0]?.host ?? null;
  // A port moved off the LAN never gets a LAN address here: Serve's HTTPS address works for apps
  // too (a real certificate), and a tailnet-bound port without Serve is named as such instead of
  // handed out as a dead LAN URL.
  const addressOf = (target: Entry): { url: string | null; caveat: string | null } => {
    const first = target.live?.urls?.[0] ?? null;
    const port = portOf(target);
    if (!port) return { url: null, caveat: null };
    const servedTarget = (serves ?? []).find((serve) => serve.port === port);
    if (servedTarget) return { url: `https://${servedTarget.dnsName}:${servedTarget.port}`, caveat: null };
    if (first && first.exposure !== "lan") return { url: null, caveat: `${target.manifest.name} is reachable only through Tailscale right now; switch it to home network for app-to-app wiring, or publish it on the tailnet.` };
    return { url: lan ? `http://${lan}:${port}` : null, caveat: null };
  };
  const outgoing = (manifest.connections ?? []).map((connection) => ({ connection, target: data.applications.find((candidate) => candidate.manifest.id === connection.app) ?? null }));
  const incoming = data.applications.filter((candidate) => candidate.live?.installed && (candidate.manifest.connections ?? []).some((connection) => connection.app === manifest.id));

  return (
    <div className="catalog-tab">
      <KeyValue layout="rows" className="catalog-facts" items={[
        { id: "from", label: "Reachable from", value: <span className="catalog-inline">{tailnetOnly ? <Tag reach="tailnet" /> : <Tag reach="lan" />}{tailnetOnly ? "Only through Tailscale" : "Your home network; the firewall decides who can reach it"}</span> },
        { id: "ports", label: "Ports", mono: true, value: live.urls.length ? live.urls.map((url) => `${url.label} ${url.host}`).join(" · ") : manifest.ports.length ? manifest.ports.map((port) => `${port.label} ${live.state?.values?.ports?.[port.id] ?? port.host}/${port.protocol}`).join(" · ") : "none" },
      ]} />

      {exposable && (
        <div className="catalog-sheet__actions">
          {served && <a className="ui-button ui-button--secondary" href={`https://${served.dnsName}:${served.port}`} target="_blank" rel="noreferrer"><span className="ui-button__label">Open on tailnet 🔒</span></a>}
          {mayStart(role, "app.exposure.set") && (tailnetOnly
            ? <Button risk={riskOf("app.exposure.set")} onClick={toLan}>Publish on home network</Button>
            : <Button risk={riskOf("app.exposure.set")} onClick={toTailnet}>Reach only through Tailscale</Button>)}
        </div>
      )}

      {addresses.length > 0 && (
        <Panel level={3} title="Addresses" count={addresses.length} className="catalog-addresses">
          <ul className="catalog-rows">
            {addresses.map(({ port, address }) => (
              <li key={`${port.id}-${address.url}`} className="catalog-row">
                <span className="catalog-row__main">
                  <a href={address.url} target="_blank" rel="noreferrer"><code>{address.url}</code></a>
                  <span className="catalog-row__dim">{live.urls.length > 1 ? `${port.label} · ` : ""}{address.label}{address.reachedThisPageBy ? " · you are on this one now" : ""}{address.caveat ? ` · ${address.caveat}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel level={3} title="Reachability" className="catalog-doctor" actions={<Button busy={checking} onClick={() => void check()}>{report ? "Check again" : "Can't reach it?"}</Button>}>
        {checkError && <Notice tone="danger" live className="catalog-inset" title="The check could not run">{checkError}</Notice>}
        {checking && !report && <p className="catalog-quiet">Asking each address, from the server itself…</p>}
        {!checking && !report && !checkError && <p className="catalog-quiet">Asks each of its addresses from the server itself and says what answered.</p>}
        {report && (
          <>
            {report.headline && <Notice tone="danger" live className="catalog-inset" title={report.headline} />}
            {!report.headline && report.addresses.length === 0 && <EmptyState title="No web addresses to check" />}
            <ul className="catalog-rows">
              {report.addresses.map((address) => (
                <li key={address.url} className="catalog-row ui-marked" data-status={address.outcome === "answered" ? "good" : address.outcome === "not-probed" ? "neutral" : "danger"}>
                  <span className="ui-mark catalog-row__mark" aria-hidden="true" />
                  <span className="catalog-row__main">
                    <span><code>{address.url}</code>{address.portLabel ? <span className="catalog-row__dim"> · {address.portLabel}</span> : null}</span>
                    {address.verdict && <span>{address.verdict}</span>}
                    {address.note && address.outcome !== "not-probed" && <span className="catalog-row__dim">{address.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="catalog-quiet">Checked from the server itself; a device on your network can still be blocked by something between it and the server.</p>
          </>
        )}
      </Panel>

      {(outgoing.length > 0 || incoming.length > 0) && (
        <Panel level={3} title="Wiring" count={outgoing.length + incoming.length} className="catalog-wiring">
          <ul className="catalog-rows">
            {outgoing.map(({ connection, target }) => {
              const address = target?.live?.installed ? addressOf(target) : null;
              return (
                <li key={`out-${connection.app}`} className="catalog-row">
                  <span className="catalog-row__main">
                    <span><strong>{target?.manifest.name ?? connection.app}</strong> as its {connection.role}: in {manifest.name} under {connection.where}.</span>
                    {!target?.live?.installed
                      ? <span className="catalog-row__dim">Install {target?.manifest.name ?? connection.app} first.</span>
                      : address?.url ? <span>Address: <code>{address.url}</code></span> : address?.caveat ? <span className="catalog-row__dim">{address.caveat}</span> : null}
                    {connection.note && <span className="catalog-row__dim">{connection.note}</span>}
                  </span>
                </li>
              );
            })}
            {incoming.map((source) => {
              const connection = (source.manifest.connections ?? []).find((candidate) => candidate.app === manifest.id);
              if (!connection) return null;
              const address = addressOf(entry);
              return (
                <li key={`in-${source.manifest.id}`} className="catalog-row">
                  <span className="catalog-row__main">
                    <span><strong>{source.manifest.name}</strong> connects here as its {connection.role}, set up in {source.manifest.name} under {connection.where}.</span>
                    {address.url && <span>This app's address there: <code>{address.url}</code></span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}
