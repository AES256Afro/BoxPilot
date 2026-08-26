import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";
import { countOf } from "./data";

/**
 * The half of a restore that is deliberately not applied, made visible.
 *
 * Restoring reinstalls apps and brings their data back, and it stages the rest — network config,
 * firewall rules, fstab, VM definitions, the old database — because applying an old machine's
 * network settings blind can take the new machine off the very network it was rescued onto. That
 * caution was right; hiding its output was not. The staged copies sat in a root-only directory
 * nothing displayed, so "staged for review" meant knowing the path and having a root shell.
 */
interface StagedFile { path: string; area: string; sizeBytes: number; content: string | null }
interface RestoreReview { name: string; stagedAt: string; files: StagedFile[] }

/** What each area is, and what to actually do with it. Advice, because a file alone is a puzzle. */
const areaGuidance: Record<string, { label: string; guidance: string }> = {
  system: {
    label: "System configuration",
    guidance: "The old machine's network addresses, firewall rules, and mount table. None of it is applied automatically: a wrong network write takes this box offline. Use these as the reference: set addresses by hand if this box takes over the old ones, apply a firewall profile from the Firewall page, and mount drives from the Storage page.",
  },
  vms: {
    label: "Virtual machine definitions",
    guidance: "Each VM's definition, not its disks. Disks come from the encrypted VM repository on the Virtual Machines page; the definition tells you what the machine was.",
  },
  controller: {
    label: "The old BoxPilot database",
    guidance: "A verified copy of the previous server's BoxPilot database, with its accounts, schedules, settings, and history. Restoring it replaces this server's own records; the controller recovery runbook covers when that is the right call.",
  },
};

const formatWhen = (name: string): string => {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return name;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toLocaleString();
};

const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`);

export default function RestoreReviewPanel({ start }: { start: (operation: PendingOperation) => void }) {
  const [restores, setRestores] = useState<RestoreReview[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { result } = await inspectOperation<{ restores: RestoreReview[] }>("host.snapshot.restores");
      setRestores(result.restores);
    } catch {
      setRestores(null); // unreadable is not "nothing staged"; say nothing rather than invent an all-clear
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (!restores || restores.length === 0) return null;

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <strong>What a restore left for you to review</strong>
          <span>Apps and their data were restored directly. These are the parts a restore stages instead of applying, because writing an old machine's network settings blind can take this one offline.</span>
        </div>
      </header>
      {restores.map((restore) => {
        const areas = [...new Set(restore.files.map((file) => file.area))].filter((area) => area in areaGuidance);
        return (
          <div className="restore-review" key={restore.name}>
            <div className="restore-review-head">
              <strong>Restored {formatWhen(restore.name)}</strong>
              <button
                className="text-button"
                type="button"
                onClick={() => start({
                  operationId: "host.snapshot.restores.discard",
                  title: "Discard these review files",
                  parameters: { name: restore.name },
                  preview: <span>Removes the staged review copies from this restore ({countOf(restore.files.length, "file")}). The restored apps and their data are untouched.</span>,
                })}
              >Discard</button>
            </div>
            {areas.map((area) => (
              <div key={area} className="restore-review-area">
                <strong>{areaGuidance[area].label}</strong>
                <p className="muted">{areaGuidance[area].guidance}</p>
                {restore.files.filter((file) => file.area === area).map((file) => (
                  <details key={file.path}>
                    <summary><code>{file.path}</code> <span className="muted">{formatSize(file.sizeBytes)}</span></summary>
                    {file.content !== null
                      ? <pre className="log-view">{file.content}</pre>
                      : <p className="muted">Not shown here ({formatSize(file.sizeBytes)}, not plain text). It is on this server at <code>{restore.stagedAt}/{file.path}</code>.</p>}
                  </details>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
