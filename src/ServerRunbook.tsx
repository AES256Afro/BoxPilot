import { useCallback, useEffect, useState } from "react";
import { readJson } from "./http";

/** Whether the copy the owner downloaded still describes this server (M34.4). From BoxPilot's own records only. */
interface RunbookStatus {
  audience: "owner" | "operator";
  canDownload: boolean;
  version: string;
  checkedAt: string;
  lastDownload: { at: string; version: string | null; fingerprint?: string | null } | null;
  outOfDate: { since: string | null; change: string; more: number } | null;
  changes: number;
}

interface RunbookPreview {
  audience: "owner" | "operator";
  version: string;
  generatedAt: string;
  fingerprint: string;
  markdown: string;
  comparison: { downloadedAt: string; matches: boolean; changedSections: string[] } | null;
}

const isStatus = (value: unknown): value is RunbookStatus => {
  const body = value as Partial<RunbookStatus> | null;
  return Boolean(body) && typeof body!.canDownload === "boolean" && (body!.lastDownload === null || typeof body!.lastDownload?.at === "string") && body!.outOfDate !== undefined;
};
const isPreview = (value: unknown): value is RunbookPreview => {
  const body = value as Partial<RunbookPreview> | null;
  return Boolean(body) && typeof body!.markdown === "string" && typeof body!.generatedAt === "string";
};
const when = (iso: string) => new Date(iso).toLocaleString();

function statusLine(status: RunbookStatus): string {
  if (!status.lastDownload) return status.canDownload ? "Not downloaded yet. Download it, keep it somewhere other than this server, and download it again after changing the server." : "The owner has not downloaded it yet.";
  const downloaded = `Downloaded ${when(status.lastDownload.at)}${status.lastDownload.version ? ` from BoxPilot ${status.lastDownload.version}` : ""}.`;
  const change = status.outOfDate;
  if (!change) return `${downloaded} Nothing that changes it has happened since.`;
  const more = change.more ? `, and ${change.more} more change${change.more === 1 ? "" : "s"}` : "";
  return `${downloaded} Out of date since: ${change.change}${change.since ? ` (${when(change.since)})` : ""}${more}.`;
}

function previewLine(preview: RunbookPreview): string {
  const made = `Generated ${when(preview.generatedAt)} by BoxPilot ${preview.version}, fingerprint ${preview.fingerprint}.`;
  const comparison = preview.comparison;
  if (!comparison) return made;
  if (comparison.matches) return `${made} It matches the copy downloaded ${when(comparison.downloadedAt)}.`;
  return `${made} It differs from the copy downloaded ${when(comparison.downloadedAt)}${comparison.changedSections.length ? ` in: ${comparison.changedSections.join(", ")}` : ""}.`;
}

/**
 * "Document this server": a runbook built from what BoxPilot knows, to keep off the server. Anyone
 * who can operate the server may preview it; the owner downloads the full copy, which also says
 * where the second copies of the backups are kept.
 */
export default function ServerRunbook() {
  const [status, setStatus] = useState<RunbookStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [preview, setPreview] = useState<RunbookPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/runbook/status");
      if (response.status === 403) { setForbidden(true); setStatus(null); return; }
      const body = await readJson<unknown>(response);
      if (!isStatus(body)) throw new Error("incomplete");
      setStatus(body);
      setStatusError(null);
    } catch {
      setStatus(null);
      setStatusError("Whether the downloaded runbook is still up to date could not be checked.");
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  async function showPreview() {
    setBusy("preview");
    setError(null);
    try {
      const body = await readJson<unknown>(await fetch("/api/v1/runbook"));
      if (!isPreview(body)) throw new Error("The runbook came back incomplete. Try again in a moment.");
      setPreview(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The runbook could not be put together");
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    setError(null);
    try {
      const response = await fetch("/api/v1/runbook/download");
      if (!response.ok) await readJson<unknown>(response);
      const markdown = await response.text();
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "boxpilot-runbook.md";
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      await loadStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The runbook could not be downloaded");
    } finally {
      setBusy(null);
    }
  }

  if (forbidden) {
    return (
      <section className="panel recovery-kit" aria-label="Document this server">
        <header className="panel-header"><div><strong>Document this server</strong><span>Writing a runbook of this server needs an operator: it lists private paths and addresses and where the backups are.</span></div></header>
      </section>
    );
  }

  const outdated = Boolean(status?.outOfDate);
  return (
    <section className="panel recovery-kit" aria-label="Document this server">
      <header className="panel-header">
        <div><strong>Document this server</strong><span>A runbook built from what BoxPilot knows: what is installed, where each app keeps its data, who can reach what, how backups run and where the copies are, and how to restore each thing. It holds no passwords.</span></div>
        {status && <span className={`status-pill status-${outdated ? "warning" : "neutral"}`}>{!status.lastDownload ? "not downloaded" : outdated ? "out of date" : "up to date"}</span>}
      </header>
      {statusError && <p className="muted" role="status">{statusError}</p>}
      {status && <p>{statusLine(status)}</p>}
      {error && <div className="notice warning-notice" role="alert"><strong>Runbook not ready</strong><span>{error}</span></div>}
      <footer className="recovery-actions">
        <button className="secondary-button" type="button" onClick={() => void showPreview()} disabled={busy !== null}>{busy === "preview" ? "Putting it together..." : "Preview runbook"}</button>
        {status?.canDownload && <button className="secondary-button" type="button" onClick={() => void download()} disabled={busy !== null}>{busy === "download" ? "Putting it together..." : "Download runbook (.md)"}</button>}
      </footer>
      {status && !status.canDownload && <p className="muted">Only the owner can download it: the owner's copy also says where the second copies of the backups are kept.</p>}
      {preview && (
        <div className="restore-review-area">
          <p>{previewLine(preview)}</p>
          <details open>
            <summary>{preview.audience === "operator" ? "Operator's copy" : "Full runbook"}</summary>
            <pre>{preview.markdown}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
