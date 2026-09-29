import { autoReconnectRule, type AutoReconnectControl } from "../AutoReconnect";
import { mountpointFor } from "../mountpoints";
import { Button } from "../ui";

/**
 * Reconnecting a dropped drive automatically (M26.5), inside the finding that says it dropped: the
 * same control Storage has (src/AutoReconnect.tsx), drawn in the console. Arming creates the drive's
 * automation, so it shows on Automations too, where it can be paused or removed.
 */
export function DriveAutoReconnect({ drive, control }: { drive: string; control: AutoReconnectControl }) {
  const { status, pending, error } = control;
  if (!status) return null;
  const armed = status.drives[drive] ?? null;
  const mountpoint = mountpointFor(drive);
  const waiting = armed && !armed.enabled
    ? "Paused on Automations."
    : armed?.held ? `Waiting for you: ${armed.heldBecause ?? "the last automatic reconnect did not work"}. Reconnecting it here by hand starts it again.`
      : armed?.lastCheckFoundErrors ? "Waiting for you: its last check found errors." : null;
  const period = status.limits.windowHours === 24 ? "day" : `${status.limits.windowHours} hours`;
  return (
    <div className="rp-auto">
      <div className="rp-auto__line">
        {armed
          ? <Button variant="ghost" disabled={pending === drive} onClick={() => void control.disarm(drive)} aria-label={`Stop reconnecting automatically: ${mountpoint}`}>Stop reconnecting automatically</Button>
          : <Button disabled={pending === drive} onClick={() => void control.arm(drive)} aria-label={`Reconnect it automatically next time: ${mountpoint}`}>Reconnect it automatically next time</Button>}
        {armed && <span>{`Reconnects automatically${armed.attempts ? `; ${armed.attempts} of ${status.limits.maxAttempts} used in the last ${period}` : ""}.`}</span>}
        {waiting && <span className="rp-auto__waiting">{waiting}</span>}
      </div>
      <p className="rp-auto__rule">{autoReconnectRule(status.limits)}</p>
      {error?.drive === drive && <p className="rp-note" data-tone="danger" role="alert">{error.message}</p>}
    </div>
  );
}
