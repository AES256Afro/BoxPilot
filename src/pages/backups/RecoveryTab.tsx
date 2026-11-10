import type { ReactNode } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { Button, EmptyState, KeyValue, Notice, Panel, RelativeTime, Table, mayStart, riskOf, type TableColumn } from "../../ui";
import { depthWords, type Recovery, type RecoveryRow, type ServerFact } from "./recovery";
import { when } from "./types";

/*
 * What you'd get back: the Backups page's first tab. One row for each installed app that holds
 * data, worst first: how many of three protections it has (a copy on this server, a copy off it, a
 * restore proven), when each was last true, and the verdict in one sentence: what a dead disk would
 * leave of that app tonight. Each row offers the one thing that would improve it most, through the
 * approval dialog. Under the apps, the server itself. src/pages/backups/recovery.ts works all of it
 * out from what the page already reads, and says where each column comes from.
 */

export interface SendOff { operationId: "backup.sync" | "backup.remote.sync" | "backup.cloud.sync"; title: string; preview: ReactNode }

export interface RecoveryTabProps {
  csrfToken: string;
  role: string;
  /** null while it is read. `read: false` when the apps could not be read. */
  recovery: Recovery | null;
  protectionError: string | null;
  /** The apps were read but the folder their backups are kept in was not. */
  folderUnread: boolean;
  /** The clock the page read at, for every "ago" on the tab. */
  now: number;
  /** The sync a row's "Send off this server" starts, or null when no destination is ready for one. */
  sendOff: SendOff | null;
  /** A destination is saved, whether or not it is ready. */
  hasDestination: boolean;
  scheduling: { busy: boolean; message: string; failed: boolean } | null;
  onSchedule: (appId: string) => void;
  facts: ServerFact[];
  onChanged: () => void;
  onOpenOffBox: () => void;
}

/** Three segments, filled for what it has, in the same order as the three columns after it. */
function Depth({ row }: { row: RecoveryRow }) {
  const segments = [row.local.state === "kept", row.off.state === "copied", row.proof.state === "passed"];
  return (
    <span className="backups-depth">
      <span className="backups-depth__bar" role="img" aria-label={depthWords(row)}>
        {segments.map((on, index) => <span key={index} className="backups-depth__segment" data-on={on || undefined} />)}
      </span>
      <span className="backups-mono" aria-hidden="true">{row.depth}/3</span>
    </span>
  );
}

export default function RecoveryTab({ csrfToken, role, recovery, protectionError, folderUnread, now, sendOff, hasDestination, scheduling, onSchedule, facts, onChanged, onOpenOffBox }: RecoveryTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const canBackUp = mayStart(role, "app.backup");
  const rows = recovery?.rows ?? [];
  const counts = recovery?.counts;

  const step = (row: RecoveryRow): ReactNode => {
    if (row.next === "back-up") {
      return canBackUp && (
        <Button risk={riskOf("app.backup")} aria-label={`Back up now: ${row.name}`}
          onClick={() => start({ operationId: "app.backup", title: `Back up ${row.name}`, parameters: { id: row.id }, preview: <span>Stops {row.name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.</span> })}>Back up now</Button>
      );
    }
    if (row.next === "send-off") {
      return sendOff
        ? <Button risk={riskOf(sendOff.operationId)} aria-label={`Send off this server: ${row.name}`} onClick={() => start({ operationId: sendOff.operationId, title: sendOff.title, parameters: {}, preview: sendOff.preview })}>Send off this server</Button>
        : <Button variant="ghost" aria-label={`${hasDestination ? "Open Off this server" : "Set up a copy elsewhere"}: ${row.name}`} onClick={onOpenOffBox}>{hasDestination ? "Open Off this server" : "Set up a copy elsewhere"}</Button>;
    }
    if (row.next === "schedule") {
      return canBackUp && <Button disabled={scheduling?.busy} aria-label={`Back up nightly: ${row.name}`} onClick={() => onSchedule(row.id)}>Back up nightly</Button>;
    }
    // The rehearsal the app's own sheet offers (app.backup.verify), on its newest backup: the one
    // thing that turns "if the copy restores" into "restore proven".
    if (row.next === "rehearse") {
      return mayStart(role, "app.backup.verify")
        ? <Button risk={riskOf("app.backup.verify")} aria-label={`Rehearse a restore: ${row.name}`}
            onClick={() => start({ operationId: "app.backup.verify", title: `Rehearse restoring ${row.name}`, parameters: { id: row.id }, preview: <span>Checks {row.name}'s newest backup against its checksum, unpacks it into scratch space, confirms it is whole, and deletes the scratch copy. {row.name} keeps running and nothing it holds is touched.</span> })}>Rehearse a restore</Button>
        : <span className="backups-dim">a rehearsal would prove it</span>;
    }
    return <span className="backups-dim">{row.grade === "full" ? "nothing to do" : "nothing until it is read"}</span>;
  };

  const columns: Array<TableColumn<RecoveryRow>> = [
    { id: "app", header: "App", cell: (row) => <strong className="backups-name">{row.name}</strong> },
    // The sentence that matters comes straight after the name; the three facts it is worked out from follow it.
    { id: "outcome", header: "If the disk died tonight", cell: (row) => <span className="backups-outcome">{row.outcome}</span> },
    { id: "depth", header: "Depth", cell: (row) => <Depth row={row} /> },
    {
      id: "local", header: "On this server", cell: (row) => (row.local.state === "never" ? <span className="backups-mono">never</span>
        : <RelativeTime className="backups-mono" at={row.local.at} now={now} fallback="kept, date not read" />),
    },
    {
      id: "off", header: "Off this server", cell: (row) => {
        const off = row.off;
        if (off.state === "copied") return <span className="backups-mono" title={`The copy made ${when(off.copyAt)} was in the sync that finished ${when(off.syncedAt)}`}><RelativeTime at={off.syncedAt} now={now} /></span>;
        if (off.state === "uncertain") return <span className="backups-mono" title={`The sync that finished ${when(off.syncedAt)} left ${off.leftOut} out`}><RelativeTime at={off.syncedAt} now={now} />, {off.leftOut} left out</span>;
        return <span className="backups-mono" title={off.state === "waiting" ? `Made after the last sync, which finished ${when(off.syncedAt)}` : undefined}>{off.state === "waiting" ? "newest not sent" : off.state === "unread" ? "not read" : "none"}</span>;
      },
    },
    {
      id: "proof", header: "Restore proven", cell: (row) => {
        const proof = row.proof;
        if (proof.state === "passed" || proof.state === "failed") {
          return <span className="backups-mono" title={proof.state === "failed" ? proof.reason ?? undefined : undefined}>{proof.state} <RelativeTime at={proof.at} now={now} fallback="(date not recorded)" /></span>;
        }
        return <span className="backups-mono">{proof.state === "never" ? "never tried" : "not read"}</span>;
      },
    },
    { id: "next", header: "Next step", className: "backups-actions-cell", cell: (row) => <span className="backups-actions">{step(row)}</span> },
  ];

  return (
    <>
      {dialog}
      {scheduling && <Notice tone={scheduling.busy ? "info" : scheduling.failed ? "warning" : "success"} live title={scheduling.message} />}
      {protectionError && <Notice tone="danger" live title="App protection could not be read" action={<Button onClick={onChanged}>Try again</Button>}>{protectionError}</Notice>}

      <Panel
        title="Apps' data"
        count={recovery?.read ? rows.length : undefined}
        meta={recovery?.read && counts ? <><b>{counts.full}</b> fully recoverable · <b>{counts.partly}</b> partly · <b>{counts.none}</b> not at all{counts.unknown ? <> · <b>{counts.unknown}</b> not known</> : null}</> : undefined}
        footer={<span className="backups-foot">
          Off this server is worked out from when each destination last finished a sync: one that finished after an app's newest backup was made carried it. A restore is proven by a rehearsal of the app's backup. Folders you pointed an app at yourself (a photo or media library) are not in these copies, and an app that keeps only caches or models it can download again is not listed.
        </span>}
      >
        {folderUnread
          ? <Notice tone="warning" className="backups-inset" title="The backup folder could not be read">So what each app would get back is not known. Nothing is assumed either way.</Notice>
          : (
            <Table
              caption="What each app would get back if this server's disk died tonight"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              rowStatus={(row) => (row.status === "good" ? undefined : row.status)}
              empty={!recovery
                ? "Reading what each app would get back…"
                : !recovery.read ? "What each app would get back could not be read."
                  : <EmptyState title="No installed app holds data that needs backing up yet" />}
            />
          )}
      </Panel>

      <Panel title="The server itself" padded>
        <KeyValue items={facts.map((fact) => ({
          id: fact.id,
          label: fact.label,
          mono: true,
          status: fact.status,
          value: <>{fact.value}{fact.value && fact.at ? " " : ""}{fact.at && <RelativeTime at={fact.at} now={now} />}</>,
        }))} />
      </Panel>
    </>
  );
}
