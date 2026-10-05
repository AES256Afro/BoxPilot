import { useState } from "react";
import { Button, Checkbox, EmptyState, Notice, Panel, Table, mayStart, riskOf } from "../../ui";
import { DatabaseCopies } from "./DatabaseCopies";
import { bytesWords, type DockerDisk, type Housekeeping, type StartOperation } from "./systemTypes";

type DockerRow = DockerDisk["rows"][number];

/**
 * What is taking up room that nothing needs any more (M33.12): the categories housekeeping found,
 * each chosen by hand and reclaimed in one approved job; how Docker accounts for its own space and
 * whether its logs are capped; and the database copies updates took (M36).
 */
export function SystemHousekeeping({ csrfToken, role, housekeeping, scanning, onRescan, dockerDisk, start }: {
  csrfToken: string;
  role: string;
  housekeeping: Housekeeping | null;
  scanning: boolean;
  onRescan: () => void;
  dockerDisk: DockerDisk | null;
  start: StartOperation;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // A new scan answers a different question: what was ticked against the old figures goes.
  const [scannedAt, setScannedAt] = useState(housekeeping?.generatedAt ?? null);
  if ((housekeeping?.generatedAt ?? null) !== scannedAt) { setScannedAt(housekeeping?.generatedAt ?? null); setChosen(new Set()); }
  const canRead = role === "owner" || role === "operator";
  const categories = housekeeping?.categories ?? [];
  const chosenBytes = categories.filter((category) => chosen.has(category.id)).reduce((sum, category) => sum + category.bytes, 0);
  const chosenWords = bytesWords(chosenBytes);

  const toggle = (id: string, on: boolean) => setChosen((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const reclaim = () => start({
    operationId: "housekeeping.reclaim",
    title: `Reclaim ${chosenWords}`,
    parameters: { targets: [...chosen] },
    preview: (
      <span>
        Removes {[...chosen].map((id) => categories.find((category) => category.id === id)?.title.toLowerCase()).filter(Boolean).join(", ")}, about {chosenWords}.
        Images a container or an installed app needs, the most recent version you could put back by hand, and the newest backups of each app are not touched.
      </span>
    ),
  });
  // A machine snapshot that cannot be read keeps every app's older backups (R4B3-5); the owner removes
  // one by name, and the job removes it only if it still cannot be read then.
  const mayRemoveSnapshot = mayStart(role, "housekeeping.unreadable-snapshot.remove");
  const removeSnapshot = (name: string) => start({
    operationId: "housekeeping.unreadable-snapshot.remove",
    title: "Remove an unreadable machine snapshot",
    parameters: { name },
    preview: (
      <span>
        Deletes <code>{name}</code> and its description from the machine snapshot folder, if it still cannot be read when the job runs. Nothing can be restored from a damaged snapshot, and while it is there no app's older backups are removed. It cannot be brought back.
      </span>
    ),
  });
  const capLogs = () => start({
    operationId: "docker.logging.set",
    title: "Apply Docker log rotation defaults",
    parameters: {},
    preview: <span>Sets the daemon default to 3 × 10 MB per container, for containers created from now on, not existing ones, and turns on live-restore, then restarts dockerd. Running containers restart briefly this one time; future daemon restarts leave them running.</span>,
  });

  return (
    <>
      {!canRead && <Notice tone="info" title="Housekeeping is for an operator">Listing what can go reads other people's files and backups, so an owner or operator does it.</Notice>}
      {canRead && (
        <Panel title="Reclaimable space" count={housekeeping ? housekeeping.totalHumanBytes : undefined}
          meta={housekeeping ? "shared image layers can make the space recovered smaller" : undefined}
          footer={housekeeping && Number.isFinite(Date.parse(housekeeping.generatedAt)) ? `Scanned ${new Date(housekeeping.generatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : undefined}
          actions={<>
            <Button variant="ghost" busy={scanning} onClick={onRescan}>Rescan</Button>
            {mayStart(role, "housekeeping.reclaim") && <Button variant="primary" risk={riskOf("housekeeping.reclaim")} disabled={chosen.size === 0} onClick={reclaim}>Reclaim {chosen.size > 0 ? chosenWords : "space"}</Button>}
          </>}>
          {!housekeeping ? (
            <EmptyState title={scanning ? "Working out what can go…" : "Not scanned"} action={scanning ? undefined : <Button onClick={onRescan}>Rescan</Button>}>{scanning ? undefined : "The scan could not be read. Rescan to look again."}</EmptyState>
          ) : categories.length === 0 ? (
            <EmptyState title="Nothing to clean up">Nothing on this server is taking room that nothing needs.</EmptyState>
          ) : (
            <ul className="system-clean">
              {categories.map((category) => (
                <li key={category.id} className="system-clean__row" data-empty={category.bytes > 0 ? undefined : "true"}>
                  <Checkbox
                    label={category.title}
                    description={category.summary}
                    checked={chosen.has(category.id)}
                    disabled={category.bytes === 0 || !category.safe || !mayStart(role, "housekeeping.reclaim")}
                    onChange={(on) => toggle(category.id, on)}
                  />
                  <div className="system-clean__facts">
                    <span className="system-clean__size" data-review={category.safe ? undefined : "true"}>
                      {!category.safe ? "Review needed" : category.bytes > 0 ? category.humanBytes : "nothing to clear"}
                      {category.items !== null && category.items > 0 ? ` · ${category.items} item${category.items === 1 ? "" : "s"}` : ""}
                    </span>
                    {category.unavailable && <span className="system-sub">{category.unavailable}</span>}
                    {category.keeping.length > 0 && <span className="system-sub">Keeping: {category.keeping.join(", ")}.</span>}
                    {category.id === "unreadable-snapshots" && mayRemoveSnapshot && category.detail.length > 0 && (
                      <ul className="system-clean__remove">
                        {category.detail.map((name) => (
                          <li key={name}>
                            <code>{name}</code>
                            <Button risk={riskOf("housekeeping.unreadable-snapshot.remove")} aria-label={`Remove ${name}`} onClick={() => removeSnapshot(name)}>Remove</Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {category.detail.length > 0 && (
                      <details className="system-details">
                        <summary>What exactly</summary>
                        <ul>{category.detail.map((line) => <li key={line}><code>{line}</code></li>)}</ul>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {dockerDisk?.available && (
        <Panel title="Docker disk use" meta="shared layers make reclaimable smaller than the sizes' sum"
          footer={dockerDisk.logging?.configured ? `Log rotation: ${dockerDisk.logging.maxSize} per file${dockerDisk.logging.liveRestore ? " · live-restore on" : ""}. It applies to containers created after it was set.` : undefined}>
          <Table<DockerRow>
            caption="Docker's own disk accounting"
            columns={[
              { id: "type", header: "Type", cell: (row) => <strong>{row.type}</strong> },
              { id: "total", header: "Total", numeric: true, cell: (row) => row.total ?? "—" },
              { id: "active", header: "Active", numeric: true, cell: (row) => row.active ?? "—" },
              { id: "size", header: "Size", numeric: true, cell: (row) => row.size ?? "—" },
              { id: "reclaimable", header: "Reclaimable", numeric: true, cell: (row) => row.reclaimable ?? "—" },
            ]}
            rows={dockerDisk.rows}
            rowKey={(row) => row.type}
          />
          {dockerDisk.logging && !dockerDisk.logging.configured && (
            <div className="system-pad">
              <Notice tone="warning" title="Container logs are unlimited" action={mayStart(role, "docker.logging.set") ? <Button risk={riskOf("docker.logging.set")} onClick={capLogs}>Apply log rotation defaults</Button> : undefined}>
                A chatty container can fill the disk.
              </Notice>
            </div>
          )}
        </Panel>
      )}

      {/* Listing them reads the state directory as root, which is an operator's (ADR-003). */}
      {canRead && <DatabaseCopies csrfToken={csrfToken} role={role} />}
    </>
  );
}
