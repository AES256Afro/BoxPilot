import type { ReactNode } from "react";
import { Notice, StatusChip } from "../../ui";

/*
 * Sweep 4: what a backup's compose file would hand its containers if a restore starts it exactly as
 * it was archived - a file edited by hand, or one whose saved settings are missing or no longer fit
 * the catalog. The server reviews the archive (app.backup.review, and per app in
 * host.snapshot.describe) and refuses such a restore unless the request allows that very file by its
 * sha256; these show the owner what they would be allowing. The restore dialogs of an app's Backups
 * tab and of the machine snapshot sheet both use them.
 */

/** One setting that gives the app more than the catalog does (server/catalog/compose-review.mjs). */
export interface ComposeFinding { service: string | null; setting: string; value: string | null; detail: string; system?: boolean; variable?: boolean }

/** The server's review of one archive (app-helper reviewSummary). */
export interface ComposeReview {
  verbatim: boolean;
  reason: "edited" | "no-settings" | "unfit" | null;
  findings: ComposeFinding[];
  /** Why it cannot be restored at all: data folders an install would refuse, a file BoxPilot cannot read whole. */
  refusals: string[];
  sha256: string | null;
  sameAsRunning: boolean;
  /** Restoring it needs `allowCompose` set to `sha256`, which stages it with a typed confirmation. */
  needsAllow: boolean;
  /** The archive could not be read; the restore itself still checks what it unpacks. */
  error?: string;
}

const why: Record<string, string> = {
  edited: "it was edited by hand",
  "no-settings": "the backup has no saved settings to write it again from",
  unfit: "its saved settings no longer fit the catalog",
};

/** The settings, one line each, with the ones that hand over the server marked. */
export function ComposeFindings({ findings }: { findings: ComposeFinding[] }) {
  return (
    <ul aria-label="Settings beyond what the catalog gives the app">
      {findings.map((finding, index) => (
        <li key={`${finding.service ?? ""}-${finding.setting}-${index}`}>
          {finding.system ? <><StatusChip status="danger">reaches the server</StatusChip>{" "}</> : null}
          {finding.service ? <code>{finding.service}</code> : "The file"} {finding.detail}
        </li>
      ))}
    </ul>
  );
}

/** Why an archive cannot be restored, one reason a line. */
export function ComposeRefusal({ title, review }: { title: ReactNode; review: ComposeReview }) {
  return (
    <Notice tone="danger" title={title}>
      <ul>{review.refusals.map((refusal) => <li key={refusal}>{refusal}</li>)}</ul>
    </Notice>
  );
}

/** What the owner allows by restoring an archive whose compose file starts as it was backed up. */
export function ComposeAllowance({ name, review, children }: { name: string; review: ComposeReview; children?: ReactNode }) {
  return (
    <Notice tone="warning" title={`${name}'s compose file would start exactly as it was backed up`}>
      <p>Since {why[review.reason ?? ""] ?? "it cannot be written again from the catalog"}, BoxPilot does not write it again, and it gives {name} more than the catalog does:</p>
      <ComposeFindings findings={review.findings} />
      <p>Restoring it allows exactly this file{review.sha256 ? <> (<code>{review.sha256.slice(0, 12)}</code>)</> : null}, with a typed confirmation. If you did not make these settings yourself, restore an older backup instead.</p>
      {children}
    </Notice>
  );
}
