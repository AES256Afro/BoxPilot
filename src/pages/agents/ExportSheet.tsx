import { useState } from "react";
import { Button, Notice, Sheet } from "../../ui";
import { agentsApi, type Examples } from "./api";
import { bytes, errorText } from "./format";

/*
 * The owner's export of an agent's book as training data (M46.3), in one place (M48.7). Three
 * buttons in a panel header used to each send the browser to the file's address, so an error - a
 * session that had ended, a book another account may not read - replaced the page with a line of
 * JSON. Each file is fetched here and saved from the page; what went wrong stays in this dialog.
 */

interface Choice { id: "book" | "acting" | "pairs"; title: string; words: string; count: number; unit: [string, string]; url: string }

export function ExportSheet({ agent, counts, onClose }: { agent: { id: string; name: string }; counts: Examples["counts"]; onClose: () => void }) {
  const [busy, setBusy] = useState<Choice["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const choices: Choice[] = [
    { id: "book", title: "The example book", count: counts.total, unit: ["example", "examples"], words: "Each request with the plan a person approved, and the template's own, for training a planner.", url: agentsApi.examplesExportUrl(agent.id) },
    { id: "acting", title: "Answers with their tool output", count: counts.acting ?? 0, unit: ["answer", "answers"], words: "Runs a person said were right, with what the tools gave back, for training the model that acts.", url: agentsApi.examplesExportUrl(agent.id, { acting: true }) },
    { id: "pairs", title: "Preference pairs", count: counts.pairs ?? 0, unit: ["pair", "pairs"], words: "A better and a worse answer to the same request, from people's verdicts, for preference training.", url: agentsApi.examplesExportUrl(agent.id, { pairs: true }) },
  ];
  const download = async (choice: Choice) => {
    setBusy(choice.id);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(choice.url);
      if (!response.ok) {
        let message = `The export failed (${response.status})`;
        try { const body = await response.json(); if (body && typeof body.error === "string") message = body.error; } catch { /* not JSON: the status says enough */ }
        throw new Error(message);
      }
      const blob = await response.blob();
      const named = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
      const filename = named?.[1] ?? `${agent.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "agent"}-${choice.id}.jsonl`;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
      setSaved(`Saved ${filename} (${bytes(blob.size)}).`);
    } catch (requestError) {
      setError(errorText(requestError, "The export failed"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet kicker={agent.name} title="Export training data" onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Done</Button>}>
      <p className="agents-dim">Each file is JSON Lines with this house's names replaced by stand-ins: hosts, addresses, accounts and local domains. Nothing leaves this server except as the file you save.</p>
      <ul className="agents-export">
        {choices.map((choice) => (
          <li key={choice.id} className="agents-export__row">
            <span className="agents-name">
              <span>{choice.title} · {choice.count} {choice.count === 1 ? choice.unit[0] : choice.unit[1]}</span>
              <span className="agents-name__purpose">{choice.words}</span>
            </span>
            <Button variant={choice.id === "book" ? "primary" : "secondary"} busy={busy === choice.id} disabled={!choice.count || (busy !== null && busy !== choice.id)} onClick={() => void download(choice)} aria-label={`Download ${choice.title.toLowerCase()}`}>Download</Button>
          </li>
        ))}
      </ul>
      {saved && <Notice tone="success" live>{saved}</Notice>}
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Sheet>
  );
}
