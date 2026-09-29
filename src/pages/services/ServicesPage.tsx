import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { readJson } from "../../http";
import { inspectOperation } from "../../operations";
import { Button, CodeBlock, EmptyState, Notice, PageHeader, Panel, Segmented, Sheet, StatusChip, Table, Tag, Toolbar, mayStart, riskOf, type Status, type TableColumn } from "../../ui";
import "./services.css";

/*
 * Services (M33.8), the reference page for wave 2: rebuilt on the kit in the console's look, with
 * every feature the Classic page had. Facts first: the verdict and the counts in the header, then
 * the units, filtered by scope or by name, each with its state, what it does at boot, and its
 * actions, each carrying its tier. A unit's journal opens in a sheet beside the list. What the page
 * is for is behind the header's info toggle, not above the facts. docs/UI-PAGES.md walks through it.
 */

interface Unit { unit: string; description: string; load: string; active: string; sub: string; enabled: string; critical: boolean; guarded?: string | null }
interface ServiceList { units: Unit[]; counts: { total: number; active: number; failed: number } }
type Scope = "common" | "active" | "failed" | "all";
type Action = "start" | "stop" | "restart" | "reload" | "enable" | "disable";

/** The units most people come here for: the ones BoxPilot and the apps depend on, and timers that keep the box tidy. */
const interesting = /^(docker|containerd|libvirtd|virtqemud|tailscaled|ssh|cron|nginx|caddy|apache2|smbd|nmbd|nfs-server|cockpit|unattended-upgrades|fail2ban|ufw|boxpilot|restic|smartmontools|smartd|nut-|upsd|postgresql|mariadb|mysql|redis|pihole|adguard|jellyfin|plex|homeassistant|zfs|snapd|fwupd|apt-daily|dpkg-db-backup|logrotate|man-db|e2scrub|fstrim|motd-news|systemd-tmpfiles-clean|update-notifier)/;

const scopeWords: Record<Scope, string> = { common: "Common", active: "Active", failed: "Failed", all: "All" };

function stateOf(unit: Unit): { status: Status; label: string } {
  if (unit.active === "active") return { status: "good", label: unit.sub || "active" };
  if (unit.active === "failed") return { status: "danger", label: "failed" };
  if (unit.active === "activating" || unit.active === "deactivating" || unit.active === "reloading") return { status: "warning", label: unit.active };
  return { status: "neutral", label: unit.sub || unit.active || "unknown" };
}

function inScope(unit: Unit, scope: Scope): boolean {
  if (scope === "failed") return unit.active === "failed";
  if (scope === "active") return unit.active === "active";
  if (scope === "common") return interesting.test(unit.unit) || unit.active === "failed";
  return true;
}

export interface ServicesPageProps {
  csrfToken: string;
  /** Who is signed in: a viewer sees the units and no actions; the journal needs an operator. */
  role?: string;
}

export default function ServicesPage({ csrfToken, role = "owner" }: ServicesPageProps) {
  const [data, setData] = useState<ServiceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<Scope>("common");
  const [journal, setJournal] = useState<{ unit: string; lines: string[] | null; error: string | null } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { result } = await inspectOperation<ServiceList>("service.list");
      setData(result);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The service list could not be read");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });
  const canAct = mayStart(role, "service.action");
  const canRead = role === "owner" || role === "operator";

  const readJournal = useCallback(async (unit: string) => {
    setJournal({ unit, lines: null, error: null });
    try {
      const response = await fetch("/api/v1/operations/service.journal/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { unit, lines: 200 } }) });
      const body = await readJson<{ result?: { lines: string[] } }>(response);
      setJournal({ unit, lines: body.result?.lines ?? [], error: null });
    } catch (requestError) {
      setJournal({ unit, lines: null, error: requestError instanceof Error ? requestError.message : "The journal could not be read" });
    }
  }, [csrfToken]);

  const units = useMemo(() => data?.units ?? [], [data]);
  const needle = filter.trim().toLowerCase();
  // A search looks through every unit; without one, the scope decides.
  const visible = useMemo(() => units.filter((unit) => (needle ? unit.unit.toLowerCase().includes(needle) || unit.description.toLowerCase().includes(needle) : inScope(unit, scope))), [units, needle, scope]);
  const counts: Record<Scope, number> = { common: units.filter((unit) => inScope(unit, "common")).length, active: units.filter((unit) => unit.active === "active").length, failed: units.filter((unit) => unit.active === "failed").length, all: units.length };
  const timers = units.filter((unit) => unit.unit.endsWith(".timer")).length;
  const protectedUnits = units.filter((unit) => unit.critical).length;
  const failed = data?.counts.failed ?? 0;

  const act = (unit: Unit, action: Action) => start({
    operationId: "service.action",
    title: `${action[0].toUpperCase()}${action.slice(1)} ${unit.unit}`,
    parameters: { unit: unit.unit, action },
    preview: <span><code>systemctl {action} {unit.unit}</code>{unit.description ? `, ${unit.description}` : ""}</span>,
  });

  const risk = riskOf("service.action");
  const columns: Array<TableColumn<Unit>> = [
    {
      id: "unit", header: "Unit", sortValue: (unit) => unit.unit, cell: (unit) => (
        <span className="services-unit">
          <span className="services-unit__name">
            <code>{unit.unit}</code>
            {unit.critical && <Tag title="BoxPilot keeps this running: it cannot be stopped or disabled here">protected</Tag>}
          </span>
          {unit.description && <span className="services-unit__description">{unit.description}</span>}
        </span>
      ),
    },
    { id: "state", header: "State", sortValue: (unit) => (unit.active === "failed" ? 0 : unit.active === "active" ? 2 : 1), cell: (unit) => { const state = stateOf(unit); return <StatusChip status={state.status}>{state.label}</StatusChip>; } },
    { id: "boot", header: "On boot", sortValue: (unit) => unit.enabled, hideOnPhone: false, cell: (unit) => <span className="services-boot">{unit.enabled || "—"}</span> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "services-actions-cell", cell: (unit) => (
        <span className="services-actions">
          {canAct && (unit.active === "active" ? (
            <>
              <Button risk={risk} onClick={() => act(unit, "restart")} aria-label={`Restart ${unit.unit}`}>Restart</Button>
              {!unit.critical && !unit.guarded && <Button risk={risk} onClick={() => act(unit, "stop")} aria-label={`Stop ${unit.unit}`}>Stop</Button>}
            </>
          ) : <Button risk={risk} onClick={() => act(unit, "start")} aria-label={`Start ${unit.unit}`}>Start</Button>)}
          {canAct && unit.enabled === "enabled" && !unit.critical && !unit.guarded && <Button risk={risk} onClick={() => act(unit, "disable")} aria-label={`Disable ${unit.unit}`}>Disable</Button>}
          {canAct && unit.enabled === "disabled" && <Button risk={risk} onClick={() => act(unit, "enable")} aria-label={`Enable ${unit.unit}`}>Enable</Button>}
          {unit.guarded && <span className="services-guarded" title={unit.guarded}>on Firewall</span>}
          {canRead && <Button variant="ghost" onClick={() => void readJournal(unit.unit)} aria-label={`Journal of ${unit.unit}`}>Journal</Button>}
        </span>
      ),
    },
  ];

  const verdict = error && !data ? { status: "unknown" as const, label: "Not read" }
    : !data ? { status: "unknown" as const, label: "Reading…" }
      : failed ? { status: "danger" as const, label: `${failed} failed` } : { status: "good" as const, label: "None failed" };

  return (
    <div className="services-page">
      {dialog}
      <PageHeader
        title="Services"
        status={verdict}
        meta={data ? <><b>{data.counts.total}</b> {data.counts.total === 1 ? "unit" : "units"} · <b>{data.counts.active}</b> active · <b>{failed}</b> failed · <b>{timers}</b> {timers === 1 ? "timer" : "timers"} · <b>{protectedUnits}</b> protected</> : undefined}
        actions={<Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(data)}>Read again</Button>}
        about={<>
          <p>The system services and timers systemd knows about: start, stop, restart, enable or disable them, and read each one's journal.</p>
          <p>BoxPilot, SSH, systemd and Tailscale are protected: they cannot be stopped or disabled from here, so this page cannot cut off the way back in. A unit the firewall manages is changed on the Firewall page.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The service list could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      <Panel
        className="services-units"
        title="Units"
        count={data ? visible.length : undefined}
        meta={data ? (needle ? `matching “${filter.trim()}” in all ${units.length}` : `${scopeWords[scope].toLowerCase()} · of ${units.length}`) : undefined}
      >
        <Toolbar
          label="Units"
          className="services-toolbar"
          search={{ value: filter, onValueChange: setFilter, label: "Filter units", placeholder: "Filter by name or description…" }}
          filters={<Segmented<Scope> label="Which units" value={needle ? null : scope} onChange={(next) => { setScope(next); setFilter(""); }}
            options={(["common", "active", "failed", "all"] as const).map((key) => ({ value: key, label: scopeWords[key], count: data ? counts[key] : undefined }))} />}
        />
        <Table
          caption="System services and timers"
          columns={columns}
          rows={visible}
          rowKey={(unit) => unit.unit}
          rowStatus={(unit) => (unit.active === "failed" ? "danger" : undefined)}
          defaultSort={{ column: "state", direction: "ascending" }}
          empty={!data
            ? (loading ? "Reading systemd…" : "The units could not be read.")
            : <EmptyState title={needle ? "No units match" : scope === "failed" ? "No unit has failed" : "No units here"}>{needle ? "Search looks through every unit's name and description." : "Choose All to see every unit."}</EmptyState>}
        />
      </Panel>

      {journal && (
        <Sheet
          kicker="Journal"
          title={journal.unit}
          size="lg"
          onClose={() => setJournal(null)}
          footer={<Button onClick={() => void readJournal(journal.unit)} busy={journal.lines === null && !journal.error}>Read again</Button>}
        >
          {journal.error
            ? <Notice tone="danger" live title="The journal could not be read">{journal.error}</Notice>
            : <CodeBlock label={`Journal for ${journal.unit}`} meta={journal.lines ? `last ${journal.lines.length} lines` : undefined} follow empty={journal.lines === null ? "Reading the journal…" : "No entries."} maxHeight="calc(100vh - 220px)">
                {(journal.lines ?? []).join("\n")}
              </CodeBlock>}
        </Sheet>
      )}
    </div>
  );
}
