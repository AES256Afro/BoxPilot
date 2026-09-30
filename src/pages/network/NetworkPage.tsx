import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { readJson } from "../../http";
import { Button, KeyValue, Notice, PageHeader, Tabs, useUrlParam, type Status } from "../../ui";
import { NetworkDns } from "./NetworkDns";
import { NetworkOverview } from "./NetworkOverview";
import { NetworkRouter } from "./NetworkRouter";
import { NetworkTailnet } from "./NetworkTailnet";
import { NetworkVpn } from "./NetworkVpn";
import { isResilience, isTopology, type NetworkCapability, type Reachability, type Resilience, type Tailnet, type TlsCapability, type Topology } from "./types";
import "./network.css";

/*
 * Network and DNS (M33.10), rebuilt on the kit with every feature the Classic page and its panels
 * had. Facts first: whether this server has a way out and a tailnet, then its gateway, address,
 * resolvers and Tailscale in a strip, then one tab per job: reaching BoxPilot and the LAN, the
 * tailnet, names and DNS, the router, and the VPN profile. Long forms (the DNS assessment, the
 * router's password, the VPN profile) open in sheets. Nothing on this page writes to the router.
 */

type Tab = "overview" | "tailnet" | "dns" | "router" | "vpn";
const tabIds: readonly Tab[] = ["overview", "tailnet", "dns", "router", "vpn"];

/** The strip's words for whether the house keeps its DNS with this server off. */
const survivalWords: Record<Resilience["state"], { value: string; status: Status }> = {
  "single-point": { value: "Goes down with it", status: "danger" },
  unproven: { value: "Not proven", status: "warning" },
  resilient: { value: "Keeps working", status: "good" },
  independent: { value: "Does not lean on it", status: "neutral" },
  unknown: { value: "Not known", status: "unknown" },
};

export interface NetworkPageProps {
  csrfToken: string;
  /** Who is signed in: the facts are everyone's, the buttons only for a role that may start them. */
  role?: string;
  /** The clock, for "last seen 3 hours ago"; a test holds it still. */
  now?: () => number;
}

/** Reads a JSON route the page can live without: its absence is said where it would have been. */
async function readOptional<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export default function NetworkPage({ csrfToken, role = "owner", now = Date.now }: NetworkPageProps) {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [networkCap, setNetworkCap] = useState<NetworkCapability | null>(null);
  const [tlsCap, setTlsCap] = useState<TlsCapability | null>(null);
  const [reach, setReach] = useState<Reachability | null>(null);
  const [tailnet, setTailnet] = useState<Tailnet | null>(null);
  const [tailnetError, setTailnetError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useUrlParam<Tab>("tab", tabIds, "overview");
  // Whether the house keeps its DNS while this server is off (M39.2): read with the page, said at
  // its top when the whole house goes down with this server, and in full on Names & DNS.
  const [resilience, setResilience] = useState<Resilience | null>(null);
  const [resilienceError, setResilienceError] = useState<string | null>(null);
  const [checkingDns, setCheckingDns] = useState(false);
  const readResilience = useCallback(async (fresh = false) => {
    setCheckingDns(true);
    try {
      const response = await fetch(`/api/v1/network/dns-resilience${fresh ? "?fresh=1" : ""}`);
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok || !isResilience(body)) throw new Error((body as { error?: string } | null)?.error ?? "The DNS check could not run");
      setResilience(body);
      setResilienceError(null);
    } catch (caught) {
      setResilienceError(caught instanceof Error ? caught.message : "The DNS check could not run");
    } finally {
      setCheckingDns(false);
    }
  }, []);
  useEffect(() => { void readResilience(); }, [readResilience]);

  const readAround = useCallback(async () => {
    const [capabilities, reachability, nodes] = await Promise.all([
      readOptional<{ network?: NetworkCapability; tls?: TlsCapability }>("/api/v1/capabilities"),
      readOptional<Reachability>("/api/v1/network/reachability"),
      readOptional<Tailnet>("/api/v1/network/tailnet"),
    ]);
    setNetworkCap(capabilities?.network && typeof capabilities.network.port === "number" ? capabilities.network : null);
    setTlsCap(capabilities?.tls && typeof capabilities.tls.provisioned === "boolean" ? capabilities.tls : null);
    setReach(reachability && Array.isArray(reachability.ways) ? reachability : null);
    const tailnetRead = nodes && typeof nodes.available === "boolean" && Array.isArray(nodes.peers ?? []) ? { ...nodes, peers: nodes.peers ?? [] } : null;
    setTailnet(tailnetRead);
    setTailnetError(!tailnetRead);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    void readAround();
    try {
      const next = await readJson<Topology>(await fetch("/api/v1/network/topology"));
      if (!isTopology(next)) throw new Error("The network came back in a shape this page cannot read.");
      setTopology(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The network could not be read");
    } finally {
      setLoading(false);
    }
  }, [readAround]);
  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { setRefreshKey((key) => key + 1); void readAround(); void refresh(); void readResilience(true); });

  const clock = now();
  const gateway = topology?.defaultRoutes[0] ?? null;
  const lan = topology?.eligibleLanAddresses[0] ?? null;
  const collectorsRead = topology ? Object.values(topology.collectors).filter(Boolean).length : 0;
  const collectorsTotal = topology ? Object.keys(topology.collectors).length : 0;
  const unread = collectorsTotal - collectorsRead;
  const tailscale = topology?.tailscale ?? null;
  const nodes = tailnet?.available ? [...(tailnet.self ? [tailnet.self] : []), ...tailnet.peers] : [];
  const online = nodes.filter((node) => node.online).length;

  const verdict: { status: Status; label: string } = error && !topology ? { status: "unknown", label: "Not read" }
    : !topology ? { status: "unknown", label: "Reading…" }
      : !gateway ? { status: "danger", label: "No default route" }
        : !lan ? { status: "warning", label: "No LAN address" }
          : unread > 0 ? { status: "warning", label: `${unread} not read` }
            : { status: "good", label: tailscale?.connected ? "LAN and tailnet" : "LAN only" };

  return (
    <div className="network-page">
      {dialog}
      <PageHeader
        title="Network and DNS"
        status={verdict}
        meta={topology ? <>
          <b>{collectorsRead}</b> of <b>{collectorsTotal}</b> read · <b>{topology.devices?.length ?? 0}</b> on the LAN
          {tailnet?.available ? <> · <b>{online}</b> of <b>{nodes.length}</b> on the tailnet</> : null}
        </> : undefined}
        actions={<Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(topology)}>Read again</Button>}
        about={<>
          <p>Gateway, DNS, devices on your LAN, and Tailscale.</p>
          <p>The network as this server sees it: its way out, its resolvers, the devices around it on the LAN and the tailnet, and every way to reach BoxPilot. The router tab reads your router and the DNS change is an assessment: nothing here writes to the router.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The network could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
      {resilience?.state === "single-point" && tab !== "dns" && (
        <Notice tone="danger" title={resilience.headline} action={<Button onClick={() => setTab("dns")}>See what to do</Button>}>{resilience.detail}</Notice>
      )}

      {topology && (
        <KeyValue
          layout="strip"
          className="network-strip"
          items={[
            { id: "gateway", label: "Gateway", value: gateway?.gateway ?? "None", mono: true, status: gateway ? undefined : "danger", hint: gateway ? `on ${gateway.interface}` : "no default route" },
            { id: "lan", label: "Server LAN", value: lan?.address ?? "None", mono: true, status: lan ? undefined : "warning", hint: lan?.cidr ?? lan?.interface ?? "no eligible address" },
            { id: "dns", label: "Resolvers", value: topology.defaultResolvers.join(" + ") || "None", mono: true, hint: "in use now" },
            { id: "tailscale", label: "Tailscale", value: tailscale?.connected ? "Connected" : "Not connected", status: tailscale?.connected ? "good" : "neutral", hint: tailscale?.dnsName ?? undefined },
            { id: "tsdns", label: "Tailnet DNS", value: !tailscale?.connected ? "—" : tailscale.defaultDnsObserved ? "Default resolver" : "Split only", hint: !tailscale?.connected ? undefined : tailscale.defaultDnsObserved ? "Tailscale's resolver is the default" : "for tailnet names only" },
            ...(resilience ? [{ id: "survives", label: "House DNS", ...survivalWords[resilience.state], hint: "if this server is off" }] : []),
          ]}
        />
      )}

      <Tabs<Tab>
        label="Network"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview", count: topology?.devices?.length },
          { id: "tailnet", label: "Tailnet", count: tailnet?.available ? `${online}/${nodes.length}` : undefined },
          { id: "dns", label: "Names & DNS" },
          { id: "router", label: "Router" },
          { id: "vpn", label: "VPN" },
        ]}
      >
        {(open) => (
          open === "tailnet" ? <NetworkTailnet tailscale={tailscale} tailnet={tailnet} tailnetError={tailnetError} role={role} start={start} now={clock} />
            : open === "dns" ? <NetworkDns csrfToken={csrfToken} topology={topology} role={role} start={start} refreshKey={refreshKey} resilience={resilience} resilienceError={resilienceError} checkingDns={checkingDns} onCheckDns={() => void readResilience(true)} now={clock} />
              : open === "router" ? <NetworkRouter gateway={gateway?.gateway ?? null} role={role} start={start} refreshKey={refreshKey} />
                : open === "vpn" ? <NetworkVpn role={role} start={start} refreshKey={refreshKey} now={clock} />
                  : <NetworkOverview topology={topology} networkCap={networkCap} tlsCap={tlsCap} reach={reach} role={role} start={start} />
        )}
      </Tabs>
    </div>
  );
}
