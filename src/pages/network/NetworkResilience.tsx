import { useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, KeyValue, Notice, Panel, Sheet, StatusChip, Table, mayStart, riskOf, type KeyValueItem, type NoticeTone, type Status, type TableColumn } from "../../ui";
import { RouterSteps } from "./RouterSteps";
import type { Resilience, ResilienceServer } from "./types";

/*
 * The Names & DNS tab's first panel (M39.2, ADR-008): whether the house keeps its DNS while this
 * server is off. What the router hands out, each server asked directly, the verdict in one line, the
 * steps for the router in a sheet, and the rehearsal that proves a router's fallback. After a power
 * cut, what the DNS app and this server's own lookups said once it was back.
 */

const verdictWords: Record<Resilience["state"], { status: Status; label: string; tone: NoticeTone }> = {
  "single-point": { status: "danger", label: "goes down with it", tone: "danger" },
  unproven: { status: "warning", label: "not proven", tone: "warning" },
  resilient: { status: "good", label: "keeps working", tone: "success" },
  independent: { status: "neutral", label: "does not lean on it", tone: "info" },
  unknown: { status: "unknown", label: "not known", tone: "info" },
};

const serverVerdict: Record<ResilienceServer["verdict"], { status: Status; label: string }> = {
  depends: { status: "danger", label: "goes with it" },
  independent: { status: "good", label: "keeps answering" },
  unknown: { status: "warning", label: "not known" },
  broken: { status: "danger", label: "not answering" },
  skipped: { status: "neutral", label: "not counted" },
};

function fromHere(server: ResilienceServer) {
  if (server.answering === null) return <span className="network-dim">not asked</span>;
  if (!server.answering) return <StatusChip status="warning">no answer</StatusChip>;
  if (!server.resolving) return <StatusChip status="warning">cannot resolve</StatusChip>;
  return <StatusChip status="good">{server.blocking ? "answers, blocks" : "answers"}</StatusChip>;
}

const seconds = (ms: number | null | undefined) => (typeof ms === "number" ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : null);

export interface NetworkResilienceProps {
  resilience: Resilience | null;
  checking: boolean;
  error: string | null;
  onCheck: () => void;
  role: string;
  start: (operation: PendingOperation) => void;
  /** The DNS app running here, which the rehearsal stops and starts again. */
  dnsApp: { id: string; name: string } | null;
  /** BoxPilot's app names end in .lan, which a router answers itself. */
  lanNames: boolean;
  now: number;
}

export function NetworkResilience({ resilience, checking, error, onCheck, role, start, dnsApp, lanNames, now }: NetworkResilienceProps) {
  const [steps, setSteps] = useState(false);
  const verdict = resilience ? verdictWords[resilience.state] : null;
  const routerServer = resilience?.servers.find((server) => server.role === "router" && server.leansHere) ?? null;
  const canRehearse = Boolean(resilience && routerServer && resilience.lanAddress && dnsApp && mayStart(role, "dns.fallback.rehearse"));
  const rehearsal = resilience?.rehearsal ?? null;

  const rehearse = () => {
    if (!resilience || !routerServer || !resilience.lanAddress || !dnsApp) return;
    start({
      operationId: "dns.fallback.rehearse",
      title: `Rehearse this server going down, for DNS`,
      parameters: { router: routerServer.address, lanAddress: resilience.lanAddress, app: dnsApp.id },
      preview: <span>Stops {dnsApp.name} for about half a minute and asks your router at <code>{routerServer.address}</code> for three names it cannot have cached. If the router has a fallback, devices notice a slower lookup at most; if it has none, nothing on your network can look names up until {dnsApp.name} is back, up to a minute. {dnsApp.name} is started again and BoxPilot waits until it answers; a safety timer starts it within three minutes if the job is cut off.</span>,
    });
  };

  const columns: Array<TableColumn<ResilienceServer>> = [
    { id: "address", header: "DNS server", sortValue: (server) => server.address, cell: (server) => <code className="network-strong">{server.address}</code> },
    { id: "who", header: "Is", cell: (server) => server.label },
    { id: "here", header: "Asked from here", hideOnPhone: true, cell: fromHere },
    {
      id: "off", header: "With this server off", cell: (server) => (
        <span className="network-two">
          <StatusChip status={serverVerdict[server.verdict].status}>{serverVerdict[server.verdict].label}</StatusChip>
          <span className="network-dim">{server.note}</span>
        </span>
      ),
    },
  ];

  const facts: KeyValueItem[] = [];
  if (rehearsal) {
    const when = relativeTime(rehearsal.at, now) ?? rehearsal.at;
    facts.push({
      id: "rehearsal", label: "Last rehearsal",
      status: rehearsal.passed === true ? "good" : rehearsal.passed === false ? "danger" : "unknown",
      value: rehearsal.passed === null ? "proved nothing" : `${rehearsal.answered ?? 0} of ${rehearsal.total ?? 0} answered with ${rehearsal.appName ?? "the DNS app"} stopped`,
      hint: <>{when} via <code>{rehearsal.router}</code>{rehearsal.slowestMs ? `, slowest ${seconds(rehearsal.slowestMs)}` : ""}{resilience?.rehearsalStale ? "; older than ninety days, so rehearse again" : ""}</>,
    });
  }
  const outage = resilience?.afterOutage ?? null;
  if (outage) {
    for (const check of outage.checks) facts.push({ id: `outage-${check.id}`, label: "After the outage", status: check.ok ? "good" : "danger", value: check.label, hint: <>{check.detail} Checked {relativeTime(outage.at, now) ?? outage.at}.</> });
  }

  return (
    <>
      <Panel
        className="network-resilience"
        title="If this server is off"
        count={verdict ? { status: verdict.status, label: verdict.label } : undefined}
        meta={resilience ? <>devices get <b>{resilience.servers.length}</b> {resilience.servers.length === 1 ? "server" : "servers"}</> : undefined}
        actions={<>
          <Button variant="ghost" onClick={onCheck} busy={checking}>Check again</Button>
          <Button onClick={() => setSteps(true)}>Router steps…</Button>
          {canRehearse && <Button risk={riskOf("dns.fallback.rehearse")} onClick={rehearse}>Rehearse</Button>}
        </>}
        footer={resilience ? <>{resilience.source === "dhcp" ? <>Read from this server&apos;s DHCP lease ({resilience.via ?? "its network manager"})</>
          : resilience.source === "pihole-log" && resilience.askers ? <>This server&apos;s address is set by hand, so read from Pi-hole&apos;s query log: {resilience.askers.lanClients > 0 ? `${resilience.askers.lanClients} ${resilience.askers.lanClients === 1 ? "device" : "devices"} asked it directly` : "only the router asked it"} in the last {resilience.askers.window}</>
            : "No DHCP lease to read"} · checked {relativeTime(resilience.checkedAt, now) ?? "just now"}. To hear when this server goes down, turn on the heartbeat in Settings, Notifications.</> : undefined}
      >
        {error && <div className="network-pad"><Notice tone="danger" live title="The DNS check could not run" action={<Button onClick={onCheck}>Try again</Button>}>{error}</Notice></div>}
        {!resilience ? (
          !error && <EmptyState title={checking ? "Checking…" : "Not checked yet"}>Reads what your router hands out and asks each DNS server directly. Nothing is changed.</EmptyState>
        ) : (
          <>
            <div className="network-pad">
              <Notice tone={verdict?.tone ?? "info"} title={resilience.headline}
                action={resilience.state === "single-point" || resilience.state === "unknown" ? <Button variant={resilience.state === "single-point" ? "primary" : "secondary"} onClick={() => setSteps(true)}>See the router steps</Button> : undefined}>
                {resilience.detail}
              </Notice>
            </div>
            <Table caption="DNS servers your devices are given" columns={columns} rows={resilience.servers} rowKey={(server) => server.address}
              empty={<EmptyState title="No DNS servers to show">{resilience.source === "none" ? "This server has no DHCP lease to read them from." : "The lease names none."}</EmptyState>} />
            {facts.length > 0 && <div className="network-pad"><KeyValue items={facts} /></div>}
          </>
        )}
      </Panel>

      {steps && (
        <Sheet
          kicker="Router"
          title="Keep DNS working when this server is off"
          size="lg"
          onClose={() => setSteps(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setSteps(false)}>Close</Button>
            <Button variant="primary" busy={checking} onClick={() => { setSteps(false); onCheck(); }}>Check again</Button>
          </>}
        >
          <RouterSteps server={resilience?.lanAddress ?? null} router={resilience?.gateway ?? null} lanNames={lanNames} />
        </Sheet>
      )}
    </>
  );
}
