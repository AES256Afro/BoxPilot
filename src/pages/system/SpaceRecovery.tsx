import { useState } from "react";
import { formatBytes } from "../../formatBytes";
import { runReadOperation } from "../../operations";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, Segmented, StatusChip, Table, TextInput, mayStart, riskOf } from "../../ui";
import type { SpaceCategory, SpaceCleanupId, SpaceCleanupParameters, SpacePlan, SpaceReport, StartOperation } from "./systemTypes";

/*
 * Low-space recovery (M30.8): where the bytes and inodes went (space.inspect), exactly what a
 * cleanup with the chosen bounds removes (space.cleanup.preview), and that cleanup, staged with
 * the parameters the preview was made for (space.cleanup). Measuring walks the disk as root, so it
 * runs when asked, never because the tab was opened.
 */

const MiB = 1024 ** 2;
/** The bounds server/space-recovery.mjs accepts (cleanupBounds), in the units the form asks in. */
const limits = { journalDays: [1, 3650], journalMiB: [64, 1024 * 1024], jobLogDays: [1, 365] } as const satisfies Record<string, readonly [number, number]>;
const cleanupIds: SpaceCleanupId[] = ["journal", "job-logs", "apt-cache", "docker-dangling"];
const cleanupTitles: Record<SpaceCleanupId, string> = { journal: "System journal", "job-logs": "BoxPilot job logs", "apt-cache": "APT download cache", "docker-dangling": "Dangling Docker images" };

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const whole = (text: string, [low, high]: readonly [number, number]) => {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && value >= low && value <= high ? value : null;
};
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "unknown");

/** What is inside a category, in a few words, from the detail its reader returned. */
function categoryWords(category: SpaceCategory): string {
  if (!category.available) return category.unavailable;
  switch (category.id) {
    case "journal": {
      const { archivedFiles, archivedBytes, activeFiles, journaldReportedBytes } = category.detail;
      return `${plural(archivedFiles, "archived file")} (${formatBytes(archivedBytes)}), ${plural(activeFiles, "active file")}${journaldReportedBytes !== null ? `; journald says ${formatBytes(journaldReportedBytes)}` : ""}`;
    }
    case "job-logs": {
      const detail = category.detail;
      return `${plural(detail["past-retention"].count, "completed job's log", "completed jobs' logs")} older than ${plural(detail.retentionDays, "day")} (${formatBytes(detail["past-retention"].bytes)}), ${plural(detail.failed.count, "failed job's log", "failed jobs' logs")}, ${plural(detail.active.count, "active log")}`;
    }
    case "apt-cache":
      return `apt-get clean removes ${plural(category.detail.cleanableFiles, "file")} (${formatBytes(category.detail.cleanableBytes)}), ${plural(category.detail.packages, "package")}`;
    case "docker": {
      const dangling = category.detail.danglingImages;
      const volumes = category.detail.rows.find((row) => /volume/i.test(row.type));
      return [dangling ? `${plural(dangling.count, "dangling image")} no container uses (${formatBytes(dangling.bytes)})` : "dangling images not read", volumes ? `volumes ${formatBytes(volumes.bytes)}, never cleaned` : null].filter(Boolean).join(", ");
    }
    case "backups":
      return `${plural(category.detail.roots.length, "folder")}, each with its own retention, never cleaned here`;
    default:
      return "";
  }
}

export function SpaceRecovery({ csrfToken, role, report, measuring, problem, onMeasure, start }: {
  csrfToken: string;
  role: string;
  report: SpaceReport | null;
  measuring: boolean;
  problem: string | null;
  onMeasure: () => void;
  start: StartOperation;
}) {
  const [chosen, setChosen] = useState<Set<SpaceCleanupId>>(new Set(["journal", "job-logs", "apt-cache"]));
  const [journalBy, setJournalBy] = useState<"age" | "size">("age");
  const [journalDaysText, setJournalDaysText] = useState("30");
  const [journalMiBText, setJournalMiBText] = useState("1024");
  const [jobLogDaysText, setJobLogDaysText] = useState("14");
  const [plan, setPlan] = useState<{ key: string; parameters: SpaceCleanupParameters; result: SpacePlan } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  // New figures answer a new question: a preview made against the old ones goes with them.
  const [measuredAt, setMeasuredAt] = useState(report?.generatedAt ?? null);
  if ((report?.generatedAt ?? null) !== measuredAt) { setMeasuredAt(report?.generatedAt ?? null); setPlan(null); }

  const mayClean = mayStart(role, "space.cleanup");
  const journalDays = whole(journalDaysText, limits.journalDays);
  const journalMiB = whole(journalMiBText, limits.journalMiB);
  const jobLogDays = whole(jobLogDaysText, limits.jobLogDays);
  const journalBound = journalBy === "age" ? journalDays : journalMiB;
  const valid = chosen.size > 0 && (!chosen.has("journal") || journalBound !== null) && (!chosen.has("job-logs") || jobLogDays !== null);
  const parameters: SpaceCleanupParameters | null = valid ? {
    categories: cleanupIds.filter((id) => chosen.has(id)),
    ...(chosen.has("journal") ? (journalBy === "age" ? { journalMaxAgeDays: journalDays! } : { journalMaxBytes: journalMiB! * MiB }) : {}),
    ...(chosen.has("job-logs") ? { jobLogRetentionDays: jobLogDays! } : {}),
  } : null;
  const key = parameters ? JSON.stringify(parameters) : "";
  const current = plan !== null && plan.key === key;
  const unreadable = current ? plan.result.categories.filter((category) => !category.available) : [];

  const toggle = (id: SpaceCleanupId, on: boolean) => setChosen((was) => { const next = new Set(was); if (on) next.add(id); else next.delete(id); return next; });

  const preview = async () => {
    if (!parameters) return;
    setPreviewing(true);
    try {
      const { result } = await runReadOperation<SpacePlan>("space.cleanup.preview", parameters as unknown as Record<string, unknown>, csrfToken);
      if (!Array.isArray(result?.categories)) throw new Error("The preview arrived in a shape this page cannot read");
      setPlan({ key, parameters, result });
      setPreviewProblem(null);
    } catch (error) {
      setPreviewProblem(error instanceof Error ? error.message : "The preview could not be made");
    } finally {
      setPreviewing(false);
    }
  };

  const clean = () => {
    if (!current || unreadable.length > 0) return;
    const result = plan.result;
    start({
      operationId: "space.cleanup",
      title: `Free ${result.totalHumanBytes}`,
      parameters: plan.parameters as unknown as Record<string, unknown>,
      preview: (
        <div className="system-preview">
          <p>Removes what the preview listed, about {result.totalHumanBytes}:</p>
          <ul>
            {result.categories.map((category) => (
              <li key={category.id}><strong>{category.title}</strong>: {category.items.length + category.more > 0 ? `${plural(category.items.length + category.more, "item")}, ${category.humanBytes}` : "nothing past the bound"}. <span className="system-sub">{category.bound}</span></li>
            ))}
          </ul>
          <p>It works the list out again when it runs and measures the space freed before and after.</p>
        </div>
      ),
    });
  };

  const categories = report?.categories ?? [];
  const titleOf = (id: string) => categories.find((category) => category.id === id)?.title ?? id;

  return (
    <Panel className="system-space" title="Logs and caches"
      meta={report ? "journal, job logs, APT, Docker and backups" : undefined}
      footer={report ? `Measured ${when(report.generatedAt)}` : undefined}
      actions={<Button variant="ghost" busy={measuring} onClick={onMeasure}>{report ? "Measure again" : "Measure"}</Button>}>
      {problem && <Notice tone="danger" live title="The disk could not be measured" action={<Button onClick={onMeasure}>Try again</Button>}>{problem}</Notice>}
      {!report ? (
        <EmptyState title={measuring ? "Measuring…" : "Not measured"} action={measuring ? undefined : <Button onClick={onMeasure}>Measure</Button>}>
          {measuring ? "This can take a few minutes." : "Measures the system journal, BoxPilot's job logs, APT's download cache, Docker and the local backups, and the free space where they are."}
        </EmptyState>
      ) : (
        <>
          <Table<SpaceCategory>
            caption="Where the disk space went"
            rows={categories}
            rowKey={(category) => category.id}
            rowStatus={(category) => (category.available ? undefined : "unknown")}
            empty="Nothing was measured."
            columns={[
              { id: "category", header: "Category", cell: (category) => <span className="system-cell"><strong>{category.title}</strong>{category.available && category.path && <code className="system-sub">{category.path}</code>}</span> },
              { id: "size", header: "Size", numeric: true, cell: (category) => (category.available ? formatBytes(category.bytes) : <StatusChip status="unknown">Unavailable</StatusChip>) },
              { id: "inodes", header: "Inodes", numeric: true, hideOnPhone: true, cell: (category) => (category.available && category.inodes !== null ? category.inodes.toLocaleString() : "—") },
              { id: "inside", header: "In it", cell: (category) => (
                <span className="system-cell">
                  <span>{categoryWords(category)}</span>
                  {category.available && category.id === "backups" && (
                    <details className="system-details">
                      <summary>Each folder</summary>
                      <ul>{category.detail.roots.map((root) => <li key={root.id}>{root.title}: {root.unavailable ?? formatBytes(root.bytes)}. <span className="system-sub">{root.retention}</span></li>)}</ul>
                    </details>
                  )}
                </span>
              ) },
            ]}
          />
          {report.filesystems.length > 0 && (
            <div className="system-pad">
              <KeyValue items={report.filesystems.map((filesystem) => ({
                id: filesystem.key,
                label: <code>{filesystem.path}</code>,
                value: `${formatBytes(filesystem.freeBytes)} free of ${formatBytes(filesystem.totalBytes)}`,
                status: filesystem.totalBytes > 0 && filesystem.freeBytes / filesystem.totalBytes < 0.1 ? "warning" : "neutral",
                hint: `${filesystem.freeInodes.toLocaleString()} inodes free · ${filesystem.categories.map(titleOf).join(", ")}`,
              }))} />
            </div>
          )}
        </>
      )}

      {mayClean && report && (
        <>
          <fieldset className="system-rule system-space__rule">
            <legend>Clean up</legend>
            <div className="system-space__choices">
              {cleanupIds.map((id) => <Checkbox key={id} label={cleanupTitles[id]} checked={chosen.has(id)} onChange={(on) => toggle(id, on)} />)}
            </div>
            {chosen.has("journal") && (
              <>
                <Segmented<"age" | "size"> label="Keep the journal by" value={journalBy} onChange={setJournalBy} options={[{ value: "age", label: "Age" }, { value: "size", label: "Size" }]} />
                {journalBy === "age" ? (
                  <Field label="Journal: keep the last (days)" error={journalDays === null ? `${limits.journalDays[0]} to ${limits.journalDays[1]} days` : undefined}>
                    <TextInput mono inputMode="numeric" type="number" min={limits.journalDays[0]} max={limits.journalDays[1]} value={journalDaysText} onValueChange={setJournalDaysText} />
                  </Field>
                ) : (
                  <Field label="Journal: keep at most (MiB)" error={journalMiB === null ? `${limits.journalMiB[0]} to ${limits.journalMiB[1]} MiB` : undefined}>
                    <TextInput mono inputMode="numeric" type="number" min={limits.journalMiB[0]} max={limits.journalMiB[1]} value={journalMiBText} onValueChange={setJournalMiBText} />
                  </Field>
                )}
              </>
            )}
            {chosen.has("job-logs") && (
              <Field label="Job logs: keep the last (days)" error={jobLogDays === null ? `${limits.jobLogDays[0]} to ${limits.jobLogDays[1]} days` : undefined}>
                <TextInput mono inputMode="numeric" type="number" min={limits.jobLogDays[0]} max={limits.jobLogDays[1]} value={jobLogDaysText} onValueChange={setJobLogDaysText} />
              </Field>
            )}
            <Button busy={previewing} disabled={!valid} onClick={() => void preview()}>Preview</Button>
            <Button risk={riskOf("space.cleanup")} variant="primary" disabled={!current || previewing || unreadable.length > 0 || plan.result.totalBytes === 0} onClick={clean}>
              {current && plan.result.totalBytes > 0 ? `Free ${plan.result.totalHumanBytes}` : "Free space"}
            </Button>
            <span className="system-rule__answer" role="status">
              {!valid ? "Choose at least one, with bounds inside the limits." : previewing ? "Working out what goes…" : !plan ? "Preview to see exactly what goes." : !current ? "The choices changed. Preview again." : unreadable.length > 0 ? `Untick what could not be read: ${unreadable.map((category) => category.title).join(", ")}.` : `${plural(plan.result.totalInodes, "item")}, ${plan.result.totalHumanBytes}.`}
            </span>
          </fieldset>
          {previewProblem && <div className="system-pad"><Notice tone="danger" live title="The preview could not be made">{previewProblem}</Notice></div>}
          {current && (
            <ul className="system-clean" aria-label="What the cleanup removes">
              {plan.result.categories.map((category) => (
                <li key={category.id} className="system-clean__row" data-empty={category.available && category.bytes > 0 ? undefined : "true"}>
                  <span className="system-cell">
                    <strong>{category.title}</strong>
                    <span className="system-sub">{category.available ? category.bound : category.unavailable}</span>
                  </span>
                  <div className="system-clean__facts">
                    <span className="system-clean__size">
                      {!category.available ? <StatusChip status="unknown">Unavailable</StatusChip> : category.bytes > 0 ? category.humanBytes : "nothing past the bound"}
                      {category.available && category.items.length + category.more > 0 ? ` · ${plural(category.items.length + category.more, "item")}` : ""}
                    </span>
                    {category.keeping.length > 0 && <span className="system-sub">Keeping: {category.keeping.join("; ")}.</span>}
                    {category.items.length > 0 && (
                      <details className="system-details">
                        <summary>What exactly</summary>
                        <ul>
                          {category.items.map((item) => <li key={item.what}><code>{item.what}</code> <span className="system-sub">{formatBytes(item.bytes)}{item.detail ? ` · ${item.detail}` : ""}</span></li>)}
                          {category.more > 0 && <li>and {category.more.toLocaleString()} more</li>}
                        </ul>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
