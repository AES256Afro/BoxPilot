import { useCallback, useEffect, useState } from "react";
import { readJson } from "./http";

/**
 * Reconnecting a drive automatically (M26.5), armed where the owner already sees the drive: its row
 * on Storage, and the Repair notice that says it dropped. Arming creates the drive's automation, so
 * it also shows on Automations, where it can be paused or removed like any other.
 */
export interface AutoReconnectDrive {
  flowId: string; flowName: string; enabled: boolean;
  held: boolean; heldSince: string | null; heldBecause: string | null;
  attempts: number; lastAttemptAt: string | null; lastOutcome: string | null; lastCheckFoundErrors: boolean;
}
export interface AutoReconnectLimits { cooldownMinutes: number; maxAttempts: number; windowHours: number }
export interface AutoReconnectStatus { limits: AutoReconnectLimits; drives: Record<string, AutoReconnectDrive> }

/** Every guardrail, in one plain sentence, from the server's own numbers. */
export function autoReconnectRule(limits: AutoReconnectLimits): string {
  const perDay = limits.windowHours === 24 ? "a day" : `${limits.windowHours} hours`;
  return `When an armed drive drops or goes read-only, BoxPilot reconnects it, restarts the apps using it and tells you, at most ${limits.maxAttempts} times ${perDay} and ${limits.cooldownMinutes} minutes apart, never while the drive is being checked or after a check found errors, and not again after a failed try until you reconnect it yourself.`;
}

export interface AutoReconnectControl {
  status: AutoReconnectStatus | null;
  pending: string | null;
  error: { drive: string; message: string } | null;
  arm: (drive: string) => Promise<void>;
  disarm: (drive: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/** One read per page; a page that cannot read it shows no control rather than a wrong one. */
export function useAutoReconnect(csrfToken: string): AutoReconnectControl {
  const [status, setStatus] = useState<AutoReconnectStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ drive: string; message: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await readJson<AutoReconnectStatus>(await fetch("/api/v1/drives/auto-reconnect"));
      setStatus(body && body.limits && typeof body.drives === "object" && body.drives !== null ? body : null);
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const change = async (drive: string, method: "POST" | "DELETE") => {
    setPending(drive);
    setError(null);
    try {
      const response = await fetch(`/api/v1/drives/${encodeURIComponent(drive)}/auto-reconnect`, { method, headers: { "X-BoxPilot-CSRF": csrfToken } });
      if (response.status !== 204) await readJson(response);
      await refresh();
    } catch (changeError) {
      setError({ drive, message: changeError instanceof Error ? changeError.message : "That did not work" });
    } finally {
      setPending(null);
    }
  };

  return { status, pending, error, arm: (drive) => change(drive, "POST"), disarm: (drive) => change(drive, "DELETE"), refresh };
}

/**
 * Arm or disarm one drive. `compact` is for a table row: the button and what is waiting, with the
 * rule stated once for the table. Otherwise the rule sits under the button, for a Repair notice.
 */
export function AutoReconnectToggle({ drive, control, compact = false }: { drive: string; control: AutoReconnectControl; compact?: boolean }) {
  const { status, pending, error } = control;
  if (!status) return null;
  const armed = status.drives[drive] ?? null;
  const mountpoint = `/mnt/${drive}`;
  const waiting = armed && !armed.enabled
    ? "Paused on Automations."
    : armed?.held ? `Waiting for you: ${armed.heldBecause ?? "the last automatic reconnect did not work"}. Reconnect it by hand to start again.`
      : armed?.lastCheckFoundErrors ? "Waiting for you: its last check found errors." : null;
  return (
    <div className="auto-reconnect">
      {armed
        ? <button className="text-button" type="button" disabled={pending === drive} onClick={() => void control.disarm(drive)} aria-label={`Stop reconnecting ${mountpoint} automatically`}>Stop reconnecting automatically</button>
        : <button className={compact ? "text-button" : "secondary-button"} type="button" disabled={pending === drive} onClick={() => void control.arm(drive)} aria-label={`Reconnect ${mountpoint} automatically`}>{compact ? "Reconnect automatically" : "Reconnect it automatically next time"}</button>}
      {armed && <span className="muted">{`Reconnects automatically${armed.attempts ? `; ${armed.attempts} of ${status.limits.maxAttempts} used in the last ${status.limits.windowHours === 24 ? "day" : `${status.limits.windowHours} hours`}` : ""}.`}</span>}
      {waiting && <span className="auto-reconnect-waiting">{waiting}</span>}
      {!compact && <p className="muted">{autoReconnectRule(status.limits)}</p>}
      {error?.drive === drive && <span className="auth-error" role="alert">{error.message}</span>}
    </div>
  );
}
