import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countOf } from "../../data";
import { readJson } from "../../http";
import { inspectOperation } from "../../operations";
import { Button, CodeBlock, Notice, PageHeader, Panel, Segmented, Select, SearchField, Switch, TextInput, Toolbar } from "../../ui";
import "./logs.css";

/*
 * Logs (M33.8), the second reference page: any journal group, systemd unit or container, with a
 * line count, a time window, a filter, following, and downloads of what is shown or of the whole
 * support bundle. Facts first: what is being shown and how much is the header's meta; the source
 * is chosen in one panel and the lines read in the next. Rebuilt on the kit with every feature the
 * Classic page had.
 */

interface Sources { groups: Array<{ id: string; label: string }>; units: Array<{ unit: string; description: string; active: string }>; containers: Array<{ name: string; state: string; image: string }>; dockerAvailable: boolean }
type Kind = "group" | "unit" | "container";

const lineChoices = [100, 300, 1000, 2000];
const sinceChoices = [
  { value: "", label: "Any time" },
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "1d", label: "Last day" },
  { value: "7d", label: "Last 7 days" },
];
const kindWords: Record<Kind, string> = { group: "journal group", unit: "unit", container: "container" };

/** Save text as a file the browser downloads. */
function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoking in the same tick can cancel the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface LogsPageProps {
  csrfToken?: string;
  /** Reading logs needs an operator (ADR-003); a viewer is told so instead of being refused. */
  role?: string;
}

export default function LogsPage({ csrfToken = "", role = "owner" }: LogsPageProps) {
  const canRead = role === "owner" || role === "operator";
  const [sources, setSources] = useState<Sources | null>(null);
  const [kind, setKind] = useState<Kind>("group");
  const [target, setTarget] = useState("boxpilot");
  const [lines, setLines] = useState(300);
  const [since, setSince] = useState("");
  const [filter, setFilter] = useState("");
  // One journalctl run per keystroke would hammer the host; read after typing pauses.
  const [appliedFilter, setAppliedFilter] = useState("");
  const [follow, setFollow] = useState(false);
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundling, setBundling] = useState(false);
  const [pick, setPick] = useState("");
  const readSequence = useRef(0);
  /** Newest log timestamp on screen, so following asks only for what came after it. */
  const lastTimestamp = useRef<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedFilter(filter), 300);
    return () => window.clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    if (!canRead) return;
    inspectOperation<Sources>("logs.sources").then(({ result }) => setSources(result)).catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "The log sources could not be listed"));
  }, [canRead]);

  /**
   * `follow` asks only for what has arrived since the newest line already on screen, instead of
   * re-fetching the whole window every five seconds. On the server that is the difference between
   * journalctl scanning back for N matching lines each tick and reading the tail of the journal.
   */
  const read = useCallback(async (mode: "replace" | "append" = "replace") => {
    if (!target || !canRead) return;
    const sequence = (readSequence.current += 1);
    setLoading(true);
    try {
      const parameters: Record<string, unknown> = { kind, target, lines };
      const newest = mode === "append" ? lastTimestamp.current : null;
      if (newest) parameters.since = newest;
      else if (since.trim()) parameters.since = since.trim();
      if (appliedFilter.trim()) parameters.filter = appliedFilter.trim();
      const response = await fetch("/api/v1/operations/logs.read/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters }) });
      const body = await readJson<{ result?: { lines: string[] } }>(response);
      if (sequence !== readSequence.current) return; // a newer read already answered
      const received = body.result?.lines ?? [];
      setEntries((current) => {
        if (mode === "replace") return received;
        // Overlap is expected: --since is inclusive to the second, so drop what we already hold.
        const held = new Set(current.slice(-400));
        const fresh = received.filter((line) => !held.has(line));
        return fresh.length ? [...current, ...fresh].slice(-2000) : current;
      });
      const newestLine = received.at(-1) ?? null;
      // Keep the zone: container lines are UTC ("...Z") and journal lines carry their offset; a bare
      // time would be read as host-local and skip or repeat hours on a non-UTC host.
      const match = newestLine ? /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(newestLine) : null;
      if (match) lastTimestamp.current = `${match[1]}T${match[2]}${match[3] ?? ""}`;
      setError(null);
    } catch (requestError) {
      if (sequence === readSequence.current) setError(requestError instanceof Error ? requestError.message : "The logs could not be read");
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [csrfToken, kind, target, lines, since, appliedFilter, canRead]);

  // Any change of source, filter or window starts a fresh read; following only asks for the rest.
  useEffect(() => { lastTimestamp.current = null; void read("replace"); }, [read]);
  useEffect(() => {
    if (!follow) return undefined;
    const timer = window.setInterval(() => { void read(lastTimestamp.current ? "append" : "replace"); }, 5000);
    return () => window.clearInterval(timer);
  }, [follow, read]);

  const unitOptions = useMemo(() => (sources?.units ?? []).filter((unit) => !pick || unit.unit.toLowerCase().includes(pick.toLowerCase())).slice(0, 200), [sources, pick]);
  const select = (nextKind: Kind, nextTarget: string) => { setKind(nextKind); setTarget(nextTarget); };
  // What Open unit (and Enter) opens: the unit named exactly, or else the first whose name has what
  // was typed. The button used to stay disabled until the name matched exactly, with no reason
  // given, while Enter opened the first match anyway.
  const chosenUnit = pick.trim() ? unitOptions.find((unit) => unit.unit === pick.trim()) ?? unitOptions[0] ?? null : null;
  const groups = sources?.groups ?? [{ id: "boxpilot", label: "BoxPilot" }];
  const shownName = kind === "group" ? (groups.find((group) => group.id === target)?.label ?? target) : target;
  const sinceWords = sinceChoices.find((choice) => choice.value === since)?.label.toLowerCase() ?? since;

  const download = () => saveFile(`${target.replace(/[^A-Za-z0-9._-]/g, "_")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`, `${entries.join("\n")}\n`, "text/plain");

  const downloadBundle = async () => {
    setBundleError(null);
    setBundling(true);
    try {
      const response = await fetch("/api/v1/support-bundle");
      // A crashed service or a proxy answers with HTML; say what to do rather than showing a parser error.
      const bundle = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(bundle.error ?? "BoxPilot could not build the support bundle. Check the BoxPilot service on the Services page, then try again.");
      saveFile("boxpilot-support-bundle.json", JSON.stringify(bundle, null, 2), "application/json");
    } catch (bundleProblem) {
      setBundleError(bundleProblem instanceof Error ? bundleProblem.message : "The support bundle is unavailable");
    } finally {
      setBundling(false);
    }
  };

  const verdict = !canRead ? { status: "neutral" as const, label: "Operators only" }
    : error ? { status: "danger" as const, label: "Not read" }
      : loading && entries.length === 0 ? { status: "unknown" as const, label: "Reading…" }
        : follow ? { status: "good" as const, label: "Following" } : { status: "neutral" as const, label: countOf(entries.length, "line") };

  return (
    <div className="logs-page">
      <PageHeader
        title="Logs"
        status={verdict}
        meta={canRead ? <>{kindWords[kind]} <b>{shownName}</b> · last <b>{lines}</b> lines · {sinceWords}{appliedFilter.trim() ? <> · matching <b>{appliedFilter.trim()}</b></> : null}</> : undefined}
        actions={canRead ? <Button onClick={() => void downloadBundle()} busy={bundling}>Download support bundle</Button> : undefined}
        about={<>
          <p>Any journal group, systemd unit or container: the newest lines, a time window, a filter, and following as new lines arrive. Download saves what is shown.</p>
          <p>The support bundle is BoxPilot's own state with secrets removed, for when someone is helping you.</p>
        </>}
      />

      {bundleError && <Notice tone="danger" live title="The support bundle could not be built" onDismiss={() => setBundleError(null)}>{bundleError}</Notice>}
      {!canRead && <Notice tone="info" title="Reading logs needs an operator">Logs can hold what other people did on this server, so an owner or operator reads them.</Notice>}

      {canRead && (
        <>
          <Panel padded className="logs-source" title="Source" meta={sources ? `${countOf(sources.units.length, "unit")} · ${sources.dockerAvailable ? countOf(sources.containers.length, "container") : "Docker not answering"}` : undefined}>
            <div className="logs-source__rows">
              <Segmented label="Journal group" value={kind === "group" ? target : null} onChange={(id) => select("group", id)} options={groups.map((group) => ({ value: group.id, label: group.label }))} />
              <form className="logs-source__unit" onSubmit={(event) => { event.preventDefault(); if (chosenUnit) select("unit", chosenUnit.unit); }}>
                <TextInput aria-label="Find a unit" placeholder="Find a unit…" mono value={pick} onValueChange={setPick} list="logs-units" aria-describedby={pick.trim() && !chosenUnit ? "logs-unit-none" : undefined} />
                <datalist id="logs-units">{unitOptions.map((unit) => <option key={unit.unit} value={unit.unit}>{unit.description}</option>)}</datalist>
                <Button type="submit" disabled={!chosenUnit}>{chosenUnit && chosenUnit.unit !== pick.trim() ? `Open ${chosenUnit.unit}` : "Open unit"}</Button>
              </form>
              {pick.trim() && !chosenUnit && <p id="logs-unit-none" className="logs-source__none" role="status">No unit has “{pick.trim()}” in its name.</p>}
              {sources?.dockerAvailable && (
                <Select aria-label="Container" mono className="logs-source__container" value={kind === "container" ? target : ""} placeholder="A container…"
                  onValueChange={(name) => { if (name) select("container", name); }}
                  options={sources.containers.map((container) => ({ value: container.name, label: `${container.name} (${container.state})` }))} />
              )}
            </div>
          </Panel>

          {error && <Notice tone="danger" live title="The logs could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>}

          <Panel className="logs-output" title="Output" count={entries.length} meta={follow ? "following, every 5 s" : undefined}>
            <Toolbar
              label="Log output"
              className="logs-toolbar"
              filters={<>
                <Select aria-label="Lines" value={String(lines)} onValueChange={(value) => setLines(Number.parseInt(value, 10))} options={lineChoices.map((count) => ({ value: String(count), label: `${count} lines` }))} />
                <Select aria-label="Since" value={since} onValueChange={setSince} options={sinceChoices} />
              </>}
              actions={<>
                <Switch label="Follow" checked={follow} onChange={setFollow} />
                <Button onClick={() => void read()} busy={loading}>Read again</Button>
                <Button onClick={download} disabled={entries.length === 0}>Download</Button>
              </>}
            >
              <SearchField className="logs-toolbar__filter" label="Filter" placeholder="Filter text…" value={filter} onValueChange={setFilter} />
            </Toolbar>
            <CodeBlock label="Log output" meta={countOf(entries.length, "line")} follow={follow} wrap empty={loading ? "Reading…" : "No log lines for this source in the chosen range."} className="logs-output__text">
              {entries.join("\n")}
            </CodeBlock>
          </Panel>
        </>
      )}
    </div>
  );
}
