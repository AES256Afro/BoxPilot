import { useCallback, useEffect, useState } from "react";
import { Button, CodeBlock, EmptyState, Notice, Segmented } from "../../ui";
import { runRead } from "./appState";
import type { CatalogContext, Entry } from "./types";

/** An app's newest log lines, from its own container or, for an app with helpers, from one of theirs. */
export function LogsTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { manifest } = entry;
  const helpers = manifest.sidecars ?? [];
  const [container, setContainer] = useState<string>(manifest.id);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const read = useCallback(async (which: string) => {
    setReading(true);
    setError(null);
    try {
      const { response, body } = await runRead<{ lines?: string[] }>(ctx.csrfToken, "app.logs", { id: manifest.id, lines: 200, ...(which !== manifest.id ? { container: which } : {}) });
      if (!response.ok) throw new Error(body.error ?? "Could not read logs");
      setLines(body.result?.lines ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read logs");
    } finally {
      setReading(false);
    }
  }, [ctx.csrfToken, manifest.id]);
  // An app whose container is gone (the nightly clean-up removes stopped ones) has no logs to read:
  // asking only failed with Docker's "No such container", and Read again failed the same way.
  const noContainer = container === manifest.id && entry.live?.container?.exists === false;
  useEffect(() => { if (!noContainer) void read(container); }, [read, container, noContainer]);

  const label = container === manifest.id ? `Logs for ${manifest.name}` : `Logs for ${manifest.name}'s ${container}`;
  return (
    <div className="catalog-tab">
      <div className="catalog-inline catalog-logs__bar">
        {helpers.length > 0 && (
          <Segmented label="Container" value={container} onChange={setContainer} options={[{ value: manifest.id, label: manifest.id }, ...helpers.map((helper) => ({ value: helper.id, label: helper.id }))]} />
        )}
        {!noContainer && <Button onClick={() => void read(container)} busy={reading}>Read again</Button>}
      </div>
      {error && !noContainer && <Notice tone="danger" live title="The logs could not be read">{error}</Notice>}
      {noContainer
        ? <EmptyState title={`${manifest.name} has no container right now`}>So there are no logs to read. Starting it from Overview builds the container again, and Repair puts back one the clean-up removed in one click; its logs are here once it runs.</EmptyState>
        : (
          <CodeBlock label={label} meta={lines ? `last ${lines.length} lines` : undefined} follow empty={lines === null ? "Reading…" : "(no output)"} maxHeight="calc(100vh - 360px)">
            {(lines ?? []).join("\n")}
          </CodeBlock>
        )}
    </div>
  );
}
