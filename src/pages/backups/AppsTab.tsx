import { useOperation } from "../../shell/ApproveDialog";
import type { ProtectionVerdict, ScheduleLike } from "../../backupProtection";
import type { ViewName } from "../../data";
import { Button, EmptyState, Notice, Panel, StatusChip, Table, mayStart, riskOf, type TableColumn } from "../../ui";

/*
 * Apps (M33.9): what each app's data is protected by. A backup that exists is not the same as one
 * that keeps being made, so each app says both: when it was last backed up, and whether a nightly
 * backup keeps happening. An app is backed up from its own row, through the approval dialog.
 */

export interface AppsTabProps {
  csrfToken: string;
  role: string;
  /** null while it is read; `available: false` when the backup folder could not be read. */
  protection: { available: boolean; verdicts: ProtectionVerdict[] } | null;
  protectionError: string | null;
  /** Backup schedules that have slipped a whole cycle. */
  behind: ScheduleLike[];
  /** What scheduling nightly backups did, while and after it runs. */
  scheduling: { busy: boolean; message: string; failed: boolean } | null;
  onSchedule: (targets: ProtectionVerdict[]) => void;
  onChanged: () => void;
  onNavigate?: (view: ViewName) => void;
}

export default function AppsTab({ csrfToken, role, protection, protectionError, behind, scheduling, onSchedule, onChanged, onNavigate }: AppsTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const canBackUp = mayStart(role, "app.backup");
  const verdicts = [...(protection?.verdicts ?? [])].sort((left, right) => Number(left.state === "ok") - Number(right.state === "ok") || left.name.localeCompare(right.name));
  const unscheduled = verdicts.filter((verdict) => !verdict.scheduled);

  const columns: Array<TableColumn<ProtectionVerdict>> = [
    { id: "app", header: "App", sortValue: (verdict) => verdict.name, cell: (verdict) => <strong className="backups-name">{verdict.name}</strong> },
    {
      id: "last", header: "Last backup", sortValue: (verdict) => verdict.ageDays ?? Number.MAX_SAFE_INTEGER, cell: (verdict) => (verdict.state === "never"
        ? <StatusChip status="warning">never</StatusChip>
        : <StatusChip status={verdict.state === "ok" ? "good" : "warning"}>{verdict.ageDays === 0 ? "today" : `${verdict.ageDays}d ago`}</StatusChip>),
    },
    { id: "backups", header: "Kept", numeric: true, hideOnPhone: true, sortValue: (verdict) => verdict.backups, cell: (verdict) => verdict.backups },
    {
      id: "keeps", header: "Keeps happening", sortValue: (verdict) => Number(verdict.scheduled), cell: (verdict) => (verdict.scheduled
        ? <span className="backups-mono">nightly</span>
        : canBackUp ? <Button variant="ghost" disabled={scheduling?.busy} aria-label={`Back up ${verdict.name} nightly`} onClick={() => onSchedule([verdict])}>Schedule it</Button> : <span className="backups-dim">not scheduled</span>),
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Back up now</span>, label: "Back up now", className: "backups-actions-cell", cell: (verdict) => (
        <span className="backups-actions">
          {canBackUp && (
            <Button risk={riskOf("app.backup")} variant={verdict.state === "ok" ? "ghost" : "secondary"} aria-label={`Back up ${verdict.name} now`}
              onClick={() => start({ operationId: "app.backup", title: `Back up ${verdict.name}`, parameters: { id: verdict.id }, preview: <span>Stops {verdict.name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.</span> })}>Back up now</Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      {dialog}
      {behind.length > 0 && (
        <Notice tone="danger" title="A scheduled backup has stopped running" action={onNavigate ? <Button onClick={() => onNavigate("automations")}>Open Automations</Button> : undefined}>
          {behind.map((schedule) => schedule.title ?? schedule.operationId).join(", ")} {behind.length === 1 ? "is" : "are"} overdue by more than a full cycle: the server may have been off, or the task may be failing every time.
        </Notice>
      )}
      {scheduling && <Notice tone={scheduling.busy ? "info" : scheduling.failed ? "warning" : "success"} live title={scheduling.message} />}
      {protectionError && <Notice tone="danger" live title="App protection could not be read" action={<Button onClick={onChanged}>Try again</Button>}>{protectionError}</Notice>}

      <Panel
        title="Apps' data"
        count={protection?.available ? verdicts.length : undefined}
        meta={protection?.available ? <><b>{verdicts.filter((verdict) => verdict.state === "never").length}</b> never · <b>{verdicts.filter((verdict) => verdict.state === "stale").length}</b> not recent · <b>{verdicts.filter((verdict) => verdict.scheduled).length}</b> nightly</> : undefined}
        actions={canBackUp && protection?.available && unscheduled.length > 0
          ? <Button variant="primary" disabled={scheduling?.busy} onClick={() => onSchedule(unscheduled)}>Back up everything nightly</Button>
          : undefined}
        footer={<span className="backups-foot backups-foot--row">
          <span className="backups-foot__text">Caches and re-downloadable models are left out. Each app also backs up from its card in the App catalog; VMs are protected on Virtual Machines.</span>
          {onNavigate && <span className="backups-links">
            <Button variant="ghost" className="backups-inline" onClick={() => onNavigate("catalog")}>App catalog</Button>
            <Button variant="ghost" className="backups-inline" onClick={() => onNavigate("virtualization")}>Virtual Machines</Button>
          </span>}
        </span>}
      >
        {protection && !protection.available
          ? <Notice tone="warning" className="backups-inset" title="The backup folder could not be read">So whether each app is protected is not known. Nothing is assumed either way.</Notice>
          : (
            <Table
              caption="What each app's data is protected by"
              columns={columns}
              rows={verdicts}
              rowKey={(verdict) => verdict.id}
              rowStatus={(verdict) => (verdict.state === "ok" ? undefined : "warning")}
              empty={!protection
                ? "Reading what protects each app…"
                : <EmptyState title="No installed app holds data that needs backing up yet" />}
            />
          )}
      </Panel>
    </>
  );
}
