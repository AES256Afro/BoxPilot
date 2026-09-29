import { useCallback, useEffect, useRef, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { inspectOperation, runReadOperation } from "../../operations";
import { Button, Field, Notice, Panel, StatusChip, Table, TextInput, mayStart, riskOf, type Status } from "../../ui";

/*
 * The database copies updates take (M36). Every update copies BoxPilot's database before it swaps
 * the code in (scripts/boxpilot-upgrade.sh), so the old version can be put back with the data it
 * wrote. Nothing ever removes them on its own: the owner sets a rule - keep the newest few and any
 * younger than some days - reads exactly which copies it lets go of, and approves that list.
 */

interface DatabaseCopy {
  name: string;
  version: string;
  takenAt: string;
  bytes: number;
  humanBytes: string;
  heldSecrets: boolean;
  goes: boolean;
  keptBecause: "newest" | "recent" | null;
}

export interface DatabaseCopiesReport {
  directory: string;
  rule: { keep: number; keepDays: number };
  defaults: { keep: number; keepDays: number };
  limits: { keep: [number, number]; keepDays: [number, number] };
  secretScrubVersion: string;
  copies: DatabaseCopy[];
  goes: string[];
  goesHumanBytes: string;
  totalHumanBytes: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const whole = (text: string, [low, high]: [number, number]) => {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && value >= low && value <= high ? value : null;
};

function takenOn(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "unknown";
}

export function DatabaseCopies({ csrfToken, role }: { csrfToken: string; role: string }) {
  const [report, setReport] = useState<DatabaseCopiesReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [keepText, setKeepText] = useState("");
  const [daysText, setDaysText] = useState("");
  // The rule the list on screen answers, so the button never offers a list for a rule not yet read.
  const answered = useRef<string>("");

  const load = useCallback(async (rule: { keep: number; keepDays: number } | null) => {
    setReading(true);
    try {
      const { result } = rule
        ? await runReadOperation<DatabaseCopiesReport>("housekeeping.database-copies.inspect", rule, csrfToken)
        : await inspectOperation<DatabaseCopiesReport>("housekeeping.database-copies.inspect");
      if (!Array.isArray(result?.copies)) throw new Error("BoxPilot sent a list the page could not read");
      setReport(result);
      answered.current = `${result.rule.keep}/${result.rule.keepDays}`;
      if (!rule) { setKeepText(String(result.rule.keep)); setDaysText(String(result.rule.keepDays)); }
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The copies could not be listed");
    } finally {
      setReading(false);
    }
  }, [csrfToken]);
  useEffect(() => { void load(null); }, [load]);

  const keep = report ? whole(keepText, report.limits.keep) : null;
  const keepDays = report ? whole(daysText, report.limits.keepDays) : null;
  const ruleValid = keep !== null && keepDays !== null;
  const current = ruleValid && answered.current === `${keep}/${keepDays}`;

  // A changed rule is asked again after a pause in typing, so the list always matches the numbers.
  useEffect(() => {
    if (!report || !ruleValid || answered.current === `${keep}/${keepDays}`) return undefined;
    const timer = window.setTimeout(() => { void load({ keep: keep!, keepDays: keepDays! }); }, 400);
    return () => window.clearTimeout(timer);
  }, [report, ruleValid, keep, keepDays, load]);

  const { start, dialog } = useOperation(csrfToken, () => { void load(ruleValid ? { keep: keep!, keepDays: keepDays! } : null); });

  const copies = report?.copies ?? [];
  const going = copies.filter((copy) => copy.goes);
  const kept = copies.length - going.length;
  const oldSecrets = copies.filter((copy) => copy.heldSecrets).length;
  const verdict: { status: Status; label: string } = !report
    ? { status: "unknown", label: reading ? "reading" : "not read" }
    : copies.length === 0 ? { status: "good", label: "none yet" }
      : going.length === 0 ? { status: "good", label: plural(copies.length, "copy", "copies") }
        : { status: "neutral", label: `${going.length} can go` };

  const remove = () => {
    if (!report || !current || going.length === 0) return;
    start({
      operationId: "housekeeping.database-copies.remove",
      title: `Remove ${plural(going.length, "database copy", "database copies")}`,
      parameters: { keep: report.rule.keep, keepDays: report.rule.keepDays, names: going.map((copy) => copy.name) },
      preview: (
        <div className="system-preview">
          <p>Deletes exactly these {plural(going.length, "copy", "copies")} from <code>{report.directory}</code>, {report.goesHumanBytes} in all:</p>
          <ul>{going.map((copy) => <li key={copy.name}><code>{copy.name}</code> <span className="system-sub">{copy.humanBytes}</span></li>)}</ul>
          <p>Keeps {plural(kept, "copy", "copies")}: the newest {report.rule.keep} and any younger than {plural(report.rule.keepDays, "day", "days")}. A copy that becomes one of those before this runs is kept whatever this list says, and the live database is never touched. Deleted copies cannot be brought back.</p>
        </div>
      ),
    });
  };

  return (
    <Panel className="system-copies" title="Database copies from updates" count={verdict}
      meta={report ? <><b>{report.totalHumanBytes}</b> in <code>{report.directory}</code></> : undefined}
      actions={mayStart(role, "housekeeping.database-copies.remove") && report ? (
        <Button risk={riskOf("housekeeping.database-copies.remove")} disabled={!current || reading || going.length === 0} onClick={remove}>
          {going.length === 0 ? "Nothing to remove" : `Remove ${plural(going.length, "copy", "copies")} (${report.goesHumanBytes})`}
        </Button>
      ) : undefined}>
      {dialog}
      {problem && <Notice tone="danger" live title="The copies could not be listed" action={<Button onClick={() => void load(null)}>Try again</Button>}>{problem}</Notice>}
      {report && (
        <>
          <p className="system-note system-pad">Each update copies the database before it swaps the code in, so the old version can be put back with the data it wrote. They are never removed on their own.</p>
          <fieldset className="system-rule">
            <legend>Which copies to keep</legend>
            <Field label="Keep the newest" error={keep === null ? `${report.limits.keep[0]} to ${report.limits.keep[1]}` : undefined}>
              <TextInput mono inputMode="numeric" type="number" min={report.limits.keep[0]} max={report.limits.keep[1]} value={keepText} onValueChange={setKeepText} />
            </Field>
            <Field label="and any younger than (days)" error={keepDays === null ? `${report.limits.keepDays[0]} to ${report.limits.keepDays[1]} days` : undefined}>
              <TextInput mono inputMode="numeric" type="number" min={report.limits.keepDays[0]} max={report.limits.keepDays[1]} value={daysText} onValueChange={setDaysText} />
            </Field>
            <span className="system-rule__answer" role="status">{!ruleValid ? "Choose numbers inside the limits." : !current || reading ? "Working out which go…" : `${plural(going.length, "goes", "go")}, ${plural(kept, "stays", "stay")}.`}</span>
          </fieldset>
          {oldSecrets > 0 && (
            <p className="system-hint">{plural(oldSecrets, "copy was", "copies were")} taken from a version before {report.secretScrubVersion}, which stopped keeping passwords in the database, so {oldSecrets === 1 ? "it" : "they"} may still hold some.</p>
          )}
          <Table
            caption="Database copies, newest first"
            rows={copies}
            rowKey={(copy) => copy.name}
            rowStatus={(copy) => (copy.goes ? "neutral" : "good")}
            empty="No update has copied the database yet. The next one will."
            columns={[
              { id: "version", header: "Taken from", cell: (copy) => <span className="system-cell"><strong>{copy.version}</strong><code className="system-sub">{copy.name}</code></span> },
              { id: "taken", header: "When", hideOnPhone: true, cell: (copy) => takenOn(copy.takenAt) },
              { id: "size", header: "Size", numeric: true, cell: (copy) => copy.humanBytes },
              {
                id: "verdict", header: "This rule", cell: (copy) => (
                  <span className="system-cell">
                    <StatusChip status={copy.goes ? "neutral" : "good"}>{copy.goes ? "Goes" : copy.keptBecause === "newest" ? "Kept: newest" : "Kept: recent"}</StatusChip>
                    {copy.heldSecrets && <span className="system-sub">May hold old passwords</span>}
                  </span>
                ),
              },
            ]}
          />
        </>
      )}
    </Panel>
  );
}
