import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { countOf } from "../../data";
import { readJson } from "../../http";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, Select, Sheet, StatusChip, Table, Tag, TextInput, mayStart, riskOf, type KeyValueItem, type Status, type TableColumn } from "../../ui";
import { NetworkResilience } from "./NetworkResilience";
import type { Resilience, Topology } from "./types";

/** The DNS apps that can be the house's DNS, which the rehearsal can stop and start again (server/dns-resilience.mjs). */
const dnsAppIds = ["pi-hole", "adguard-home", "technitium-dns"];

/*
 * The Network page's Names & DNS tab (M33.10): whether the DNS blocker here actually works and is
 * used, the local names it serves for the apps, what listens on port 53, and an assessment of a
 * DNS change before making it. Nothing on this tab changes the router; the names are the one thing
 * it writes, into a file only BoxPilot manages.
 */

/**
 * Whether the DNS blocker is used, not merely installed. What goes wrong is everything after the
 * install: port 53 open to the network, the container answering on the LAN address, blocklists
 * loaded, forwarded lookups coming back. Any one left undone leaves a blocker that looks healthy on
 * its own page and blocks nothing, or worse, one that takes the house offline when the router
 * points at it.
 */
interface BlockerReport {
  address: string;
  answering: boolean;
  resolving: boolean;
  blocking: boolean;
  intercepted: boolean | null;
  interceptorBlocking: boolean | null;
  control: { domain: string; addresses: string[]; error: string | null };
  probe: { domain: string; addresses: string[]; error: string | null };
  reason: string | null;
}
interface BlockerClients { available: boolean; reason: string | null; platform: { id: string; label: string; running: boolean } | null; clients: Array<{ address: string; queries: number }>; self: number }

/**
 * Local names for the apps, served by the DNS server already here. A name resolves to an address
 * and every app shares this one, so the port is still part of the address unless a reverse proxy
 * does the routing; the page says so rather than implying jellyfin.lan just works.
 */
interface NamesReport {
  available: boolean;
  reason: string | null;
  platform: { id: string; label: string; running: boolean } | null;
  file?: string;
  records: Array<{ address: string; name: string }>;
  apps?: Array<{ id: string; name: string; port: number }>;
}

interface NetworkPlan {
  id: string;
  revision: string;
  output: {
    executable: boolean;
    readyForChangeWindow: boolean;
    topology: { summary: string; devices: string[] };
    dns: { role: string; primary: string; emergency: string };
    blockers: Array<{ id: string; summary: string }>;
    warnings: string[];
    changes: string[];
    recovery: string[];
    routerMutationSupported: boolean;
    dnsCutoverSupported: boolean;
  };
  expiresAt: string;
}

const domains = ["lan", "home.arpa", "internal"];
const topologyChoices = [
  { value: "edge-router-with-access-points", label: "One edge router, everything else as access points" },
  { value: "alternate-edge-router", label: "A different device at the edge" },
  { value: "single-router", label: "Single current router" },
  { value: "custom", label: "Custom, manually verified" },
];
const dnsRoleChoices = [
  { value: "current-external", label: "Keep current external resolvers" },
  { value: "router-hosted-resolver", label: "Resolver hosted on the edge router" },
  { value: "pihole-on-host", label: "Pi-hole on this server" },
  { value: "pihole-in-vm", label: "Pi-hole in a dedicated VM" },
  { value: "other", label: "Other resolver" },
];
const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

type Listener = Topology["dnsListeners"][number];

export interface NetworkDnsProps {
  csrfToken: string;
  topology: Topology | null;
  role: string;
  start: (operation: PendingOperation) => void;
  /** A finished operation bumps this, so the names are read again. */
  refreshKey: number;
  /** Whether the house keeps its DNS with this server off (M39.2), read by the page. */
  resilience?: Resilience | null;
  resilienceError?: string | null;
  checkingDns?: boolean;
  onCheckDns?: () => void;
  now?: number;
}

export function NetworkDns({ csrfToken, topology, role, start, refreshKey, resilience = null, resilienceError = null, checkingDns = false, onCheckDns = () => {}, now = Date.now() }: NetworkDnsProps) {
  const lanAddress = topology?.eligibleLanAddresses[0]?.address ?? null;
  const canPlan = role === "owner" || role === "operator";

  // The DNS app running here, for the rehearsal: the catalog's summary says which is installed and running.
  const [dnsApp, setDnsApp] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    fetch("/api/v1/catalog?view=summary").then((response) => (response.ok ? response.json() : null)).then((data: { applications?: Array<{ manifest: { id: string; name: string }; live: { installed: boolean; container: { running: boolean } } | null }> } | null) => {
      const found = (data?.applications ?? []).find((app) => dnsAppIds.includes(app.manifest.id) && app.live?.installed && app.live.container.running);
      setDnsApp(found ? { id: found.manifest.id, name: found.manifest.name } : null);
    }).catch(() => {});
  }, [refreshKey]);

  // The blocker check.
  const [report, setReport] = useState<BlockerReport | null>(null);
  const [users, setUsers] = useState<BlockerClients | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const check = async () => {
    if (!lanAddress) return;
    setChecking(true); setCheckError(null); setReport(null); setUsers(null);
    try {
      const response = await fetch("/api/v1/operations/dns.blocker.verify/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { address: lanAddress } }) });
      const body = (await response.json().catch(() => ({}))) as { result?: BlockerReport; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "The check could not run");
      setReport(body.result);
      // Who has asked it is a separate question from whether it works, and the more useful one: a
      // blocker can be healthy and answering and used by nobody, because the router hands out a
      // different address. Asked second, so a failure here cannot lose the check itself.
      try {
        const asked = await fetch("/api/v1/operations/dns.blocker.clients/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { selfAddress: lanAddress } }) });
        const found = (await asked.json().catch(() => ({}))) as { result?: BlockerClients };
        if (asked.ok && found.result) setUsers(found.result);
      } catch { /* the check above still stands on its own */ }
    } catch (requestError) {
      setCheckError(requestError instanceof Error ? requestError.message : "The check could not run");
    } finally {
      setChecking(false);
    }
  };

  // Local names.
  const [names, setNames] = useState<NamesReport | null>(null);
  const [namesError, setNamesError] = useState<string | null>(null);
  const [domain, setDomain] = useState("lan");
  const readNames = useCallback(async () => {
    try {
      const { result } = await inspectOperation<NamesReport>("dns.names.inspect");
      setNames(result);
      setNamesError(null);
    } catch (requestError) {
      setNamesError(requestError instanceof Error ? requestError.message : "The local names could not be read");
    }
  }, []);
  useEffect(() => { void readNames(); }, [readNames, refreshKey]);

  // The DNS change assessment.
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<NetworkPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedTopology, setSelectedTopology] = useState("edge-router-with-access-points");
  const [dnsRole, setDnsRole] = useState("current-external");
  const [routerBackupRecorded, setRouterBackupRecorded] = useState(false);
  const [emergencyResolverTested, setEmergencyResolverTested] = useState(false);
  const [secondDeviceReady, setSecondDeviceReady] = useState(false);
  // What the owner typed, over what this server reads. Every read of the network used to refill any
  // field left empty, so a deliberately cleared address came back after each Read again or job.
  const [draft, setDraft] = useState<{ gatewayAddress?: string; serverAddress?: string; dnsServiceAddress?: string; fallbackDnsAddress?: string; tailscaleDnsOverride?: boolean }>({});
  const gatewayAddress = draft.gatewayAddress ?? topology?.defaultRoutes[0]?.gateway ?? "";
  const serverAddress = draft.serverAddress ?? topology?.eligibleLanAddresses[0]?.address ?? "";
  const dnsServiceAddress = draft.dnsServiceAddress ?? topology?.defaultResolvers[0] ?? "";
  const fallbackDnsAddress = draft.fallbackDnsAddress ?? topology?.defaultResolvers[1] ?? "";
  const tailscaleDnsOverride = draft.tailscaleDnsOverride ?? Boolean(topology?.tailscale.defaultDnsObserved);
  const setGatewayAddress = (value: string) => setDraft((current) => ({ ...current, gatewayAddress: value }));
  const setServerAddress = (value: string) => setDraft((current) => ({ ...current, serverAddress: value }));
  const setDnsServiceAddress = (value: string) => setDraft((current) => ({ ...current, dnsServiceAddress: value }));
  const setFallbackDnsAddress = (value: string) => setDraft((current) => ({ ...current, fallbackDnsAddress: value }));

  const addressProblem = (value: string) => (value && !ipv4.test(value.trim()) ? "An IPv4 address, such as 192.168.1.1." : undefined);
  const planReady = [gatewayAddress, serverAddress, dnsServiceAddress, fallbackDnsAddress].every((value) => !addressProblem(value));

  const checkPlan = async () => {
    setSubmitting(true);
    setPlanError(null);
    try {
      const body = await readJson<{ plan: NetworkPlan }>(await fetch("/api/v1/network/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ topology: selectedTopology, dnsRole, gatewayAddress, serverAddress, dnsServiceAddress, fallbackDnsAddress, routerBackupRecorded, emergencyResolverTested, secondDeviceReady, tailscaleDnsOverride }),
      }));
      setPlan(body.plan);
      setPlanning(false);
    } catch (requestError) {
      setPlanError(requestError instanceof Error ? requestError.message : "The assessment could not be made");
    } finally {
      setSubmitting(false);
    }
  };

  // The blocker's verdict, in words and a status, for the panel's count.
  const blockerVerdict: { status: Status; label: string } | undefined = !report ? undefined
    : !report.reason ? { status: "good", label: "working" }
      : report.intercepted && report.interceptorBlocking ? { status: "neutral", label: "handled elsewhere" }
        : { status: "danger", label: "not working" };
  const blockerFacts: KeyValueItem[] = report ? [
    { id: "answering", label: "Answering", value: report.answering ? "answering" : "nothing answered", status: report.answering ? "good" : "warning", hint: "something is listening on port 53 at that address" },
    { id: "resolving", label: "Resolving", value: report.resolving ? "resolving" : "cannot resolve", status: report.resolving ? "good" : "warning", hint: <>it looked up <code>{report.control.domain}</code>{report.control.error ? <> and got <code>{report.control.error}</code></> : null}</> },
    { id: "blocking", label: "Blocking", value: report.blocking ? "blocking" : "not blocking", status: report.blocking ? "good" : "warning", hint: <>it refused <code>{report.probe.domain}</code>, which every mainstream blocklist carries</> },
    ...(report.intercepted ? [report.interceptorBlocking
      ? { id: "intercepted", label: "Upstream", value: "DNS is handled elsewhere", status: "neutral" as const, hint: "something upstream answers every query and blocks ads itself, so this blocker is idle" }
      : { id: "intercepted", label: "Upstream", value: "DNS is being intercepted", status: "warning" as const, hint: "something upstream answers queries sent to addresses that cannot run a resolver" }] : []),
    ...(users ? [!users.available
      ? { id: "users", label: "Used by", value: "not known", status: "unknown" as const, hint: users.reason ?? undefined }
      : users.clients.length === 0
        ? { id: "users", label: "Used by", value: "nothing is using it", status: "warning" as const, hint: <>no device on your network has asked it anything{users.self > 0 ? `, only this server's own checks (${users.self})` : ""}. Point your router&apos;s DHCP at <code>{report.address}</code>, then renew a device&apos;s lease.</> }
        : { id: "users", label: "Used by", value: `${users.clients.length} ${users.clients.length === 1 ? "device" : "devices"} using it`, status: "good" as const, hint: `${users.clients.slice(0, 6).map((client) => `${client.address} (${client.queries})`).join(", ")}${users.clients.length > 6 ? `, and ${users.clients.length - 6} more` : ""}` }] : []),
  ] : [];

  const inForce = new Set((names?.records ?? []).map((record) => record.name));
  const preview = (names?.apps ?? []).map((app) => ({ ...app, name: `${app.id}.${domain}` }));
  const namesColumns: Array<TableColumn<(typeof preview)[number]>> = [
    { id: "name", header: "Name", sortValue: (app) => app.name, cell: (app) => <code className="network-strong">{app.name}</code> },
    { id: "opens", header: "Opens", cell: (app) => <code className="network-dim">{app.name}:{app.port}</code> },
    { id: "live", header: "In DNS now", sortValue: (app) => (inForce.has(app.name) ? 0 : 1), cell: (app) => (inForce.has(app.name) ? <StatusChip status="good">yes</StatusChip> : <StatusChip status="neutral">not yet</StatusChip>) },
  ];
  const canNames = mayStart(role, "dns.names.apply");
  const canClear = mayStart(role, "dns.names.clear");

  const listenerColumns: Array<TableColumn<Listener>> = [
    { id: "address", header: "Address", sortValue: (listener) => listener.address, cell: (listener) => <code className="network-strong">{listener.address}:{listener.port}</code> },
    { id: "protocol", header: "Protocol", cell: (listener) => <Tag>{listener.protocol.toUpperCase()}</Tag> },
    { id: "scope", header: "Scope", sortValue: (listener) => listener.scope, cell: (listener) => <StatusChip status={listener.scope === "wildcard" || listener.scope === "host-address" ? "warning" : "neutral"}>{listener.scope}</StatusChip> },
    { id: "interface", header: "Interface", hideOnPhone: true, cell: (listener) => (listener.interface ? <code>{listener.interface}</code> : <span className="network-dim">no interface match</span>) },
  ];

  const roles = topology?.deviceRoles ?? [];
  const ready = plan?.output.readyForChangeWindow ?? false;

  return (
    <>
      <NetworkResilience resilience={resilience} checking={checkingDns} error={resilienceError} onCheck={onCheckDns} role={role} start={start} dnsApp={dnsApp}
        lanNames={(names?.records ?? []).some((record) => record.name.endsWith(".lan"))} now={now} />

      <Panel
        className="network-blocker"
        title="DNS blocker"
        count={blockerVerdict}
        meta={lanAddress ? <>asks <b>{lanAddress}</b></> : undefined}
        actions={report || checking ? <Button onClick={() => void check()} busy={checking} disabled={!lanAddress}>Check again</Button> : undefined}
      >
        {checkError && <div className="network-pad"><Notice tone="danger" live title="The check could not run">{checkError}</Notice></div>}
        {!report ? (
          <EmptyState
            title={!lanAddress ? "This server has no LAN address to be reached on" : checking ? "Checking…" : "Is your DNS blocker working?"}
            action={lanAddress ? <Button variant="primary" onClick={() => void check()} busy={checking}>Check</Button> : undefined}
          >
            {lanAddress ? <>Sends two ordinary lookups to <code>{lanAddress}</code>, the way a laptop on your network would. Worth running before pointing the router at it. Nothing is changed.</> : undefined}
          </EmptyState>
        ) : (
          <div className="network-pad network-stack">
            <KeyValue items={blockerFacts} />
            {!report.reason
              ? <Notice tone="success" title="Answering, resolving and blocking">Devices pointed at <code>{report.address}</code> will use it.</Notice>
              : report.intercepted && report.interceptorBlocking
                ? <Notice tone="info" title="Nothing to fix here">{report.reason}</Notice>
                : <Notice tone="danger" live title="It would not work for your devices">{report.reason}</Notice>}
          </div>
        )}
      </Panel>

      <Panel
        className="network-names"
        title="Local names"
        count={names?.available ? inForce.size : undefined}
        meta={names?.platform ? <>served by <b>{names.platform.label}</b></> : undefined}
        actions={names?.available && lanAddress ? <>
          <Select aria-label="Local domain" mono value={domain} onValueChange={setDomain} options={domains.map((option) => ({ value: option, label: `.${option}` }))} />
          {canNames && preview.length > 0 && (
            <Button risk={riskOf("dns.names.apply")} onClick={() => start({
              operationId: "dns.names.apply",
              title: `Name ${countOf(preview.length, "app")} under .${domain}`,
              parameters: { address: lanAddress, domain },
              preview: <span>Writes one record per installed app pointing at <code>{lanAddress}</code>, into a file only BoxPilot manages. Devices pick the names up as soon as they use this server for DNS.</span>,
            })}>{inForce.size ? "Update names" : "Give apps names"}</Button>
          )}
          {canClear && inForce.size > 0 && (
            <Button risk={riskOf("dns.names.clear")} onClick={() => start({
              operationId: "dns.names.clear", title: "Remove the local names", parameters: {},
              preview: <span>Deletes the {countOf(inForce.size, "name")} BoxPilot wrote. Anything you added by hand stays.</span>,
            })}>Remove them</Button>
          )}
        </> : undefined}
        footer={names?.available && lanAddress && preview.length > 0 ? <>A name points at this server, so the port stays: <code>{preview[0].name}:{preview[0].port}</code>. Only devices that use this server for DNS see them.</> : undefined}
      >
        {namesError && !names ? <EmptyState title="The local names could not be read">{namesError}</EmptyState>
          : !names ? <p className="network-dim network-pad">Reading…</p>
            : !names.available ? <EmptyState title="No DNS server to write names to">{names.reason}</EmptyState>
              : !lanAddress ? <EmptyState title="No LAN address">This server&apos;s LAN address could not be read, and a name has to point somewhere.</EmptyState>
                : (
                  <>
                    {names.platform && !names.platform.running && <div className="network-pad"><Notice tone="warning" title={`${names.platform.label} is not running`}>Its names are not being served until it runs again.</Notice></div>}
                    <Table caption="A name for each app" columns={namesColumns} rows={preview} rowKey={(app) => app.id} empty={<EmptyState title="No app to name">No installed app has a page to open yet.</EmptyState>} />
                  </>
                )}
      </Panel>

      <Panel className="network-listeners" title="Port 53 listeners" count={topology ? topology.dnsListeners.length : undefined} meta="addresses only">
        <Table caption="What listens for DNS on this server" columns={listenerColumns} rows={topology?.dnsListeners ?? []} rowKey={(listener) => `${listener.protocol}-${listener.address}-${listener.port}`}
          empty={topology ? "No TCP or UDP port 53 listeners were reported." : "Reading…"} />
      </Panel>

      <Panel
        className="network-plan"
        title="DNS change"
        count={plan ? { status: ready ? "good" : "warning", label: ready ? "prerequisites recorded" : "blocked" } : undefined}
        meta="an assessment; the router is never touched"
        actions={canPlan && topology ? <Button onClick={() => { setPlanError(null); setPlanning(true); }}>{plan ? "Check another plan…" : "Plan a DNS change…"}</Button> : undefined}
      >
        {!plan ? (
          <EmptyState title="No change checked">Describe the change you have in mind and BoxPilot checks it against the live network. Nothing on your network is changed.</EmptyState>
        ) : (
          <div className="network-pad network-stack">
            <Notice tone={ready ? "success" : "warning"} title={ready ? "Prerequisites recorded" : "Change window blocked"}>
              <span className="network-mono">revision {plan.revision.slice(0, 12)} · expires {new Date(plan.expiresAt).toLocaleTimeString()}</span>
            </Notice>
            <p className="network-plan__summary">{plan.output.topology.summary}</p>
            <KeyValue items={[
              { id: "roles", label: "Device roles", value: <ul className="network-bullets">{plan.output.topology.devices.map((item) => <li key={item}>{item}</li>)}</ul> },
              { id: "changes", label: "Assessment only", value: <ul className="network-bullets">{plan.output.changes.map((item) => <li key={item}>{item}</li>)}</ul> },
              { id: "recovery", label: "Recovery order", value: <ol className="network-bullets">{plan.output.recovery.map((item) => <li key={item}>{item}</li>)}</ol> },
              ...(plan.output.blockers.length ? [{ id: "blockers", label: "Blockers", status: "warning" as const, value: <ul className="network-bullets">{plan.output.blockers.map((item) => <li key={item.id}>{item.summary}</li>)}</ul> }] : []),
              ...(plan.output.warnings.length ? [{ id: "warnings", label: "Warnings", value: <ul className="network-bullets">{plan.output.warnings.map((item) => <li key={item}>{item}</li>)}</ul> }] : []),
            ]} />
            <p className="network-tags">
              <StatusChip status="warning">Router writes locked</StatusChip>
              <StatusChip status="warning">DNS cutover locked</StatusChip>
              <span className="network-dim">{ready && plan.output.dns.role === "pihole-on-host" ? `Assessment ${plan.id} is ready for the Applications staging gate.` : "This assessment never changes the network."}</span>
            </p>
          </div>
        )}
      </Panel>

      {roles.length > 0 && (
        <Panel padded className="network-roles" title="Device roles" count={roles.length} meta="plans go by role, not make or model">
          <KeyValue items={roles.map((entry) => ({ id: entry.id, label: entry.name, value: <span className="network-role">{entry.summary}</span> }))} />
        </Panel>
      )}

      {planning && (
        <Sheet
          kicker="DNS change"
          title="Check a DNS change"
          size="lg"
          onClose={() => setPlanning(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setPlanning(false)}>Cancel</Button>
            <Button variant="primary" busy={submitting} disabled={!planReady} onClick={() => void checkPlan()}>{submitting ? "Rechecking the live network…" : "Check this plan"}</Button>
          </>}
        >
          {planError && <Notice tone="danger" live title="The assessment could not be made">{planError}</Notice>}
          <div className="network-form">
            <Field label="Intended topology"><Select value={selectedTopology} onValueChange={setSelectedTopology} options={topologyChoices} /></Field>
            <Field label="DNS role"><Select value={dnsRole} onValueChange={setDnsRole} options={dnsRoleChoices} /></Field>
            <Field label="Live gateway" error={addressProblem(gatewayAddress)}><TextInput mono inputMode="decimal" value={gatewayAddress} onValueChange={setGatewayAddress} /></Field>
            <Field label="Server LAN address" error={addressProblem(serverAddress)}><TextInput mono inputMode="decimal" value={serverAddress} onValueChange={setServerAddress} /></Field>
            <Field label="Proposed primary DNS" error={addressProblem(dnsServiceAddress)}><TextInput mono inputMode="decimal" value={dnsServiceAddress} onValueChange={setDnsServiceAddress} /></Field>
            <Field label="Emergency DNS" error={addressProblem(fallbackDnsAddress)}><TextInput mono inputMode="decimal" value={fallbackDnsAddress} onValueChange={setFallbackDnsAddress} /></Field>
          </div>
          <div className="network-checks">
            <Checkbox label="Router configuration backup or checkpoint recorded" checked={routerBackupRecorded} onChange={setRouterBackupRecorded} />
            <Checkbox label="Emergency resolver tested independently" checked={emergencyResolverTested} onChange={setEmergencyResolverTested} />
            <Checkbox label="Second LAN device ready for DNS testing" checked={secondDeviceReady} onChange={setSecondDeviceReady} />
            <Checkbox label="Tailscale DNS override is enabled" checked={tailscaleDnsOverride} onChange={(checked) => setDraft((current) => ({ ...current, tailscaleDnsOverride: checked }))} />
          </div>
        </Sheet>
      )}
    </>
  );
}
