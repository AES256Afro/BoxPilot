import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Field, Notice, Panel, Table, TextInput, mayStart, riskOf, type TableColumn } from "../../ui";
import { runRead } from "./appState";
import type { CatalogContext, Entry } from "./types";

/*
 * What a model runner has downloaded, and a way to add or remove one (M33.11). Kept out of install
 * on purpose: a large model is tens of gigabytes, and pulling one inside the install operation was
 * a silent wait that timed out before it finished. Here each download is its own job.
 */

interface Model { name: string; id: string; size: string; modified: string; bytes: number }

export function ModelsTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { manifest } = entry;
  const { act, role, csrfToken } = ctx;
  const [state, setState] = useState<{ loading: boolean; available: boolean; reason: string | null; rows: Model[] }>({ loading: true, available: false, reason: null, rows: [] });
  const [wanted, setWanted] = useState("");

  const read = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const { response, body } = await runRead<{ available: boolean; reason: string | null; models?: Model[] }>(csrfToken, "app.models.inspect", { id: manifest.id });
      if (!response.ok) throw new Error(body.error ?? "Could not read the model list");
      const result = body.result ?? { available: false, reason: "no answer", models: [] };
      setState({ loading: false, available: result.available, reason: result.reason, rows: result.models ?? [] });
    } catch (requestError) {
      setState({ loading: false, available: false, reason: requestError instanceof Error ? requestError.message : "Could not read the model list", rows: [] });
    }
  }, [csrfToken, manifest.id]);
  useEffect(() => { void read(); }, [read]);

  const total = state.rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
  const columns: Array<TableColumn<Model>> = [
    { id: "name", header: "Model", sortValue: (row) => row.name, cell: (row) => <code>{row.name}</code> },
    { id: "size", header: "Size", numeric: true, sortValue: (row) => row.bytes, cell: (row) => row.size },
    { id: "added", header: "Added", hideOnPhone: true, cell: (row) => row.modified },
    ...(mayStart(role, "app.model.remove") ? [{
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "catalog-actions-cell",
      cell: (row: Model) => <span className="catalog-actions"><Button risk={riskOf("app.model.remove")} aria-label={`Remove ${row.name}`} onClick={() => act({ operationId: "app.model.remove", title: `Remove ${row.name}`, parameters: { id: manifest.id, model: row.name }, preview: <span>Deletes <code>{row.name}</code> and frees {row.size}. It can be downloaded again at any time.</span> })}>Remove</Button></span>,
    }] : []),
  ];
  const pull = () => {
    const model = wanted.trim();
    if (!model) return;
    act({ operationId: "app.model.pull", title: `Download ${model}`, parameters: { id: manifest.id, model }, preview: <span>Downloads <code>{model}</code> into {manifest.name}. Large models are tens of gigabytes and can take an hour or more; progress appears in Activity as it goes, and the app keeps working throughout.</span> });
  };

  return (
    <div className="catalog-tab">
      {!state.loading && !state.available && <Notice tone="warning" title="The model runner is not answering">{state.reason ?? "It has not answered yet."} Models can only be listed while the app is running.</Notice>}
      <Panel level={3} title="Models" count={state.available ? state.rows.length : undefined} meta={state.available && state.rows.length ? `${total >= 1e9 ? `${(total / 1e9).toFixed(1)} GB` : `${Math.round(total / 1e6)} MB`} of disk` : undefined} className="catalog-models">
        {state.available && state.rows.length === 0
          ? <EmptyState title="Nothing downloaded yet"><code>llama3.2:3b</code> is a good first choice at about 2 GB.</EmptyState>
          : <Table caption={`${manifest.name}'s models`} columns={columns} rows={state.rows} rowKey={(row) => row.name} empty={state.loading ? `Asking ${manifest.name} what it has…` : "No models could be listed."} />}
      </Panel>
      {state.available && mayStart(role, "app.model.pull") && (
        <form className="catalog-inline catalog-models__pull" onSubmit={(event) => { event.preventDefault(); pull(); }}>
          <Field label="Model to download" hint={<>Names come from <a href="https://ollama.com/library" target="_blank" rel="noreferrer">the Ollama library</a>, such as <code>hermes3:8b</code>.</>}>
            <TextInput mono value={wanted} onValueChange={setWanted} placeholder="hermes3:8b" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Button variant="primary" type="submit" risk={riskOf("app.model.pull")} disabled={!wanted.trim()}>Download</Button>
        </form>
      )}
      <p className="catalog-quiet">Disk is rarely the limit; memory is: a model needs roughly its own size free in RAM to answer, so a 19 GB model wants about that much spare. Check the Performance page before pulling a large one. Without a graphics card, 3 to 8 B models answer at reading speed; <code>qwen3:30b-a3b</code> is the exception worth its size.</p>
    </div>
  );
}
