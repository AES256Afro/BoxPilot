import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { formatBytes } from "../../formatBytes";
import { inspectOperation } from "../../operations";
import { Button, EmptyState, Notice, Panel, Table, mayStart, riskOf, type TableColumn } from "../../ui";
import { when } from "./types";

/*
 * Restore the database copy (M91): put back a verified backup of BoxPilot's own database, or the copy
 * a snapshot restore staged for review. Until this, either one could only be read from the browser,
 * and a rebuilt server came back without its schedules, destinations, accounts and notification
 * target unless the owner restored it at the console. The server checks the copy against its
 * recorded checksum and SQLite's integrity check, and refuses one a newer BoxPilot took (the release
 * its record names, or tables and columns this version does not have), before anything stops, and
 * puts the database it had back if BoxPilot does not answer on the copy.
 */

/** One copy the server can put back: a controller backup by its id, or a snapshot restore's copy by the restore's name. */
interface DatabaseCopySource { kind: "backup" | "snapshot"; id: string; createdAt: string | null; sizeBytes: number; checksumSha256: string }

/** When a snapshot restore ran, from its review folder's name (`20261125T100000Z`). */
function restoredOn(name: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  return match ? when(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : name;
}

const whatItIs = (copy: DatabaseCopySource) => (copy.kind === "backup" ? "Database backup" : `From the snapshot restored ${restoredOn(copy.id)}`);

export default function RestoreDatabase({ csrfToken, role, onChanged }: { csrfToken: string; role: string; onChanged?: () => void }) {
  const canRead = role === "owner" || role === "operator";
  const canRestore = mayStart(role, "host.database.restore");
  const [copies, setCopies] = useState<DatabaseCopySource[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      const { result } = await inspectOperation<{ copies?: DatabaseCopySource[] }>("host.database.sources");
      setCopies(Array.isArray(result?.copies) ? result.copies : []);
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The database backups could not be listed");
    }
  }, [canRead]);
  useEffect(() => { void load(); }, [load]);
  const { start, dialog } = useOperation(csrfToken, () => { void load(); onChanged?.(); });

  if (!canRead) return null;

  const restore = (copy: DatabaseCopySource) => start({
    operationId: "host.database.restore",
    title: `Restore the database copy of ${when(copy.createdAt)}`,
    parameters: { kind: copy.kind, id: copy.id },
    confirmText: copy.id,
    preview: (
      <div className="backups-preview">
        <p>Checks this copy against the checksum recorded when it was taken and SQLite's integrity check, and refuses one taken by a newer BoxPilot than this, then stops BoxPilot, saves the database as it is now as a copy of its own, puts this one in its place and starts BoxPilot again. If BoxPilot does not answer on it, the database it had is put back.</p>
        <p>Everything recorded since {when(copy.createdAt)} (jobs, settings, schedules, accounts) is not in it. Accounts, passwords and passkeys go back to what they were then. Everyone is signed out, you included; sign in again once BoxPilot is back. The System page says how it ended.</p>
      </div>
    ),
  });

  const columns: Array<TableColumn<DatabaseCopySource>> = [
    { id: "what", header: "Copy", cell: (copy) => whatItIs(copy) },
    { id: "taken", header: "Taken", sortValue: (copy) => copy.createdAt ?? "", cell: (copy) => when(copy.createdAt) },
    { id: "size", header: "Size", numeric: true, hideOnPhone: true, cell: (copy) => formatBytes(copy.sizeBytes) },
    ...(canRestore ? [{
      id: "actions", header: <span className="ui-visually-hidden">Restore</span>, label: "Restore", className: "backups-actions-cell",
      cell: (copy: DatabaseCopySource) => <Button variant="ghost" risk={riskOf("host.database.restore")} aria-label={`Restore the database copy of ${when(copy.createdAt)}`} onClick={() => restore(copy)}>Restore…</Button>,
    }] : []),
  ];

  return (
    <Panel title="Restore the database copy" count={copies ? copies.length : undefined} meta="verified backups of BoxPilot's database, and the copy a snapshot restore brought back">
      {dialog}
      {problem && <Notice tone="danger" live className="backups-inset" title="The database backups could not be listed" action={<Button onClick={() => void load()}>Try again</Button>}>{problem}</Notice>}
      <Table
        caption="Database copies that can be put back"
        columns={columns}
        rows={copies ?? []}
        rowKey={(copy) => `${copy.kind}:${copy.id}`}
        defaultSort={{ column: "taken", direction: "descending" }}
        empty={!copies && !problem ? "Reading the database backups…" : <EmptyState title="No database copy to put back">A verified backup of the database, or a snapshot restore, puts one here.</EmptyState>}
      />
    </Panel>
  );
}
