import type { ReactNode } from "react";
import type { AutoReconnectControl } from "../../AutoReconnect";
import { mountpointFor } from "../../mountpoints";
import { CopyButton, Switch } from "../../ui";
import type { Status } from "../../ui";
import { gib, percentUsed, type DiagnosticCheck } from "./types";

/*
 * Pieces only the Storage page draws (M33.9), built on the kit. Candidates for src/ui once a second
 * page needs them: UsageMeter (how full a filesystem is), CopyLines (an address to type on each kind
 * of machine, with Copy), and CheckList (a diagnosis, one marked line per check).
 */

/** How full a filesystem is: a bar, the figures in mono, and "nearly full" in words from 90%. */
export function UsageMeter({ used, size, label }: { used: number | null; size: number | null; label: string }) {
  const percent = percentUsed(used, size);
  if (percent === null) return <span className="storage-dim">—</span>;
  const status: Status | undefined = percent >= 90 ? "danger" : percent >= 80 ? "warning" : undefined;
  return (
    <span className="storage-usage ui-marked" data-status={status}>
      <span className="storage-usage__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${label}: ${percent}% used`}>
        <i style={{ width: `${percent}%` }} />
      </span>
      <span className="storage-usage__text">
        {gib(used)} of {gib(size)} <b>{status && <span className="ui-mark" aria-hidden="true" />}{percent}%</b>{status === "danger" ? " nearly full" : ""}
      </span>
    </span>
  );
}

/** What to type on each kind of machine, each line with its own Copy. */
export function CopyLines({ lines, subject }: { lines: Array<{ os: string; path: string; hint?: string }>; subject: string }) {
  return (
    <ul className="storage-copy">
      {lines.map((line) => (
        <li key={`${line.os}:${line.path}`}>
          <span className="storage-copy__os">{line.os}</span>
          <code className="storage-copy__path">{line.path}</code>
          <CopyButton value={line.path} name={`the ${line.os} form for ${subject}`} className="storage-copy__button" />
          {line.hint && <span className="storage-copy__hint">{line.hint}</span>}
        </li>
      ))}
    </ul>
  );
}

const checkStatus: Record<DiagnosticCheck["state"], { status: Status; word: string }> = {
  ok: { status: "good", word: "OK" },
  problem: { status: "danger", word: "Problem" },
  warn: { status: "warning", word: "Check" },
  info: { status: "neutral", word: "Note" },
};

/** A diagnosis: each check its mark and its word, what was found, and what to do about it. */
export function CheckList({ checks, empty }: { checks: DiagnosticCheck[]; empty: ReactNode }) {
  if (checks.length === 0) return <p className="storage-dim">{empty}</p>;
  return (
    <ul className="storage-checks">
      {checks.map((check) => (
        <li key={check.id} className="storage-checks__item ui-marked" data-status={checkStatus[check.state]?.status ?? "neutral"}>
          <span className="storage-checks__word"><span className="ui-mark" aria-hidden="true" />{checkStatus[check.state]?.word ?? check.state}</span>
          <span className="storage-checks__body">
            <strong>{check.title}</strong>
            <span>{check.detail}{check.hint ? ` ${check.hint}` : ""}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Reconnecting a drive BoxPilot mounted when it drops (M26.5), on the drive's own row: a switch that
 * arms or disarms the drive's automation, how many tries are used, and what is waiting for a person.
 * Repair has the same control in its finding (src/repair/DriveAutoReconnect.tsx); the rule itself is
 * stated once, under the table.
 */
export function ReconnectSwitch({ drive, control, canChange }: { drive: string; control: AutoReconnectControl; canChange: boolean }) {
  const { status, pending, error } = control;
  if (!status) return null;
  const armed = status.drives[drive] ?? null;
  const mountpoint = mountpointFor(drive);
  const period = status.limits.windowHours === 24 ? "day" : `${status.limits.windowHours} hours`;
  // Where "by hand" is: this row has no Reconnect button; Repair's finding does.
  const waiting = armed && !armed.enabled
    ? "Paused on Automations."
    : armed?.held ? `Waiting for you: ${armed.heldBecause ?? "the last automatic reconnect did not work"}. Reconnect it from Repair Center to start again.`
      : armed?.lastCheckFoundErrors ? "Waiting for you: its last check found errors." : null;
  return (
    <div className="storage-reconnect">
      <Switch
        checked={Boolean(armed)}
        busy={pending === drive}
        disabled={!canChange}
        onChange={(on) => void (on ? control.arm(drive) : control.disarm(drive))}
        label={<>Reconnect if it drops<span className="ui-visually-hidden">{`: ${mountpoint}`}</span></>}
        description={armed ? `Reconnects automatically${armed.attempts ? `; ${armed.attempts} of ${status.limits.maxAttempts} used in the last ${period}` : ""}.` : undefined}
      />
      {waiting && <p className="storage-reconnect__waiting ui-marked" data-status="warning"><span className="ui-mark" aria-hidden="true" />{waiting}</p>}
      {error?.drive === drive && <p className="storage-reconnect__error" role="alert">{error.message}</p>}
    </div>
  );
}
