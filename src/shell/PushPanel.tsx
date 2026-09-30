import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../home/format";
import { pushApi, pushSupport, thisDeviceId, turnOffThisDevice, turnOnPush, type PushSettings, type PushStatus, type PushSupport } from "../pwa/push";
import { Button, Checkbox, Facts, Field, Notice, Select, StatusChip, Switch, TextInput } from "../ui";
import "./push.css";

/*
 * Approvals on your phone (M25.2), at the top of the notification centre: turn pushes on for this
 * device, see and remove this account's devices, send a test, and - the owner - choose which risk
 * tiers push, the quiet hours, and whether ntfy is used as well. A push opens BoxPilot at the
 * approval; the approval itself is always the ordinary dialog, at its tier, in the app.
 */

const supportWords: Record<Exclude<PushSupport, "supported">, { title: string; text: string }> = {
  "install-first": { title: "Add BoxPilot to your Home Screen first", text: "On an iPhone or iPad, pushes reach the installed app only (iOS 16.4 or later): tap Share, then Add to Home Screen, and open BoxPilot from there." },
  blocked: { title: "Notifications are blocked for BoxPilot here", text: "Allow them in this device's settings (on an iPhone or iPad: Settings, Notifications, BoxPilot), then come back and turn pushes on." },
  unsupported: { title: "This browser cannot receive pushes", text: "Open BoxPilot at its HTTPS address in a current browser, or install it on your phone. The notification target (ntfy) still tells you." },
};

export function PushPanel({ csrfToken, role, now = Date.now }: { csrfToken: string; role: string; now?: () => number }) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [draft, setDraft] = useState<Pick<PushSettings, "tiers" | "quietHours" | "ntfy"> | null>(null);
  const support = pushSupport();
  const mine = thisDeviceId();

  const load = useCallback(async () => {
    try {
      const body = await pushApi.status();
      setStatus(body);
      setDraft({ tiers: body.settings.tiers, quietHours: body.settings.quietHours, ntfy: body.settings.ntfy });
      setProblem(body.problem);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Pushes could not be read");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The worker is read before the button is pressed: Safari only asks for permission inside the tap.
  useEffect(() => {
    if (support !== "supported") return;
    void navigator.serviceWorker.getRegistration().then((found) => setRegistration(found ?? null)).catch(() => undefined);
  }, [support]);

  const act = async (work: () => Promise<string | null>) => {
    setBusy(true); setProblem(null); setSaid(null);
    try { setSaid(await work()); await load(); } catch (error) { setProblem(error instanceof Error ? error.message : "That did not work"); } finally { setBusy(false); }
  };
  const turnOn = () => act(async () => {
    if (!registration || !status?.publicKey) throw new Error("BoxPilot's app is not installed on this device yet; reload the page and try again");
    await turnOnPush(csrfToken, status.publicKey, registration);
    return "Pushes are on for this device.";
  });
  const turnOff = () => act(async () => { await turnOffThisDevice(csrfToken); return "Pushes are off for this device."; });
  const test = () => act(async () => { const result = await pushApi.test(csrfToken); return result.delivered ? `Sent to ${result.delivered} of ${result.devices} ${result.devices === 1 ? "device" : "devices"}.` : "No device took it; see each one below."; });
  const remove = (id: string) => act(async () => { if (id === mine) await turnOffThisDevice(csrfToken); else await pushApi.remove(csrfToken, id); return "Removed."; });
  const save = () => act(async () => { if (draft) await pushApi.saveSettings(csrfToken, draft); return "Saved."; });

  if (!status) return <section className="push-panel" aria-label="Approvals on your phone">{problem ? <Notice tone="danger" title="Pushes could not be read">{problem}</Notice> : <p className="push-quiet">Reading…</p>}</section>;
  if (!status.canSubscribe) return null; // a viewer approves nothing, so is pushed nothing

  const onHere = Boolean(mine && status.devices.some((device) => device.id === mine));
  const owner = role === "owner";
  const settings = status.settings;
  const changed = draft && JSON.stringify(draft) !== JSON.stringify({ tiers: settings.tiers, quietHours: settings.quietHours, ntfy: settings.ntfy });

  return (
    <section className="push-panel" aria-labelledby="push-title">
      <div className="push-head">
        <h3 id="push-title" className="push-title">Approvals on your phone</h3>
        <StatusChip status={onHere ? "good" : "neutral"}>{onHere ? "On for this device" : "Off for this device"}</StatusChip>
      </div>
      <p className="push-quiet">A job left waiting for your approval is pushed to your devices after two minutes. Tapping it opens BoxPilot at the approval, which asks what its tier always asks. Signing out on a device turns its pushes off.</p>
      {support !== "supported" && <Notice tone={support === "blocked" ? "warning" : "info"} title={supportWords[support].title}>{supportWords[support].text}</Notice>}
      {problem && <Notice tone="danger" live title="That did not work">{problem}</Notice>}
      {said && <p className="push-said" role="status">{said}</p>}
      <div className="push-actions">
        {support === "supported" && (onHere
          ? <Button onClick={() => void turnOff()} busy={busy}>Turn off for this device</Button>
          : <Button variant="primary" onClick={() => void turnOn()} busy={busy} disabled={!registration || !status.publicKey}>Turn on for this device</Button>)}
        {status.devices.length > 0 && <Button variant="ghost" onClick={() => void test()} disabled={busy}>Send a test</Button>}
      </div>
      {status.devices.length > 0 && (
        <ul className="push-devices" aria-label="Your devices with pushes on">
          {status.devices.map((device) => (
            <li key={device.id} className="push-device">
              <span className="push-device__name">{device.label}{device.id === mine ? " (this one)" : ""}</span>
              <Facts as="span">{device.service} · added {relativeTime(device.createdAt, now()) ?? ""}{device.lastSentAt ? <> · last push {relativeTime(device.lastSentAt, now())}</> : null}</Facts>
              {device.lastError && <span className="push-device__error">Last push refused: {device.lastError}</span>}
              <Button variant="ghost" className="push-device__remove" aria-label={`Remove ${device.label}`} onClick={() => void remove(device.id)} disabled={busy}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {owner && draft && (
        <details className="push-choices">
          <summary>Which approvals push, and when: {(["high", "medium", "low"] as const).filter((tier) => settings.tiers[tier]).join(", ") || "none"}{settings.quietHours.enabled ? `, quiet ${settings.quietHours.start}-${settings.quietHours.end}` : ""}</summary>
        <div className="push-settings">
          <fieldset className="push-tiers">
            <legend>Which approvals push</legend>
            {(["high", "medium", "low"] as const).map((tier) => (
              <Checkbox key={tier} label={`${tier[0].toUpperCase()}${tier.slice(1)} risk`} checked={draft.tiers[tier]} onChange={(checked) => setDraft({ ...draft, tiers: { ...draft.tiers, [tier]: checked } })} />
            ))}
          </fieldset>
          <Switch label="Quiet hours" description={`Nothing is pushed then; what still waits is said once, after. This server's clock${settings.timeZone ? ` (${settings.timeZone})` : ""}.`}
            checked={draft.quietHours.enabled} onChange={(enabled) => setDraft({ ...draft, quietHours: { ...draft.quietHours, enabled } })} />
          {draft.quietHours.enabled && (
            <div className="push-hours">
              <Field label="From"><TextInput type="time" value={draft.quietHours.start} onValueChange={(start) => setDraft({ ...draft, quietHours: { ...draft.quietHours, start } })} /></Field>
              <Field label="Until"><TextInput type="time" value={draft.quietHours.end} onValueChange={(end) => setDraft({ ...draft, quietHours: { ...draft.quietHours, end } })} /></Field>
            </div>
          )}
          <Field label="The notification target (ntfy)" hint={settings.openAt ? <>Its pushes open <code>{settings.openAt}</code>.</> : "Its pushes open BoxPilot once a device has turned pushes on here."}>
            <Select value={draft.ntfy} onValueChange={(ntfy) => setDraft({ ...draft, ntfy: ntfy as PushSettings["ntfy"] })} options={[
              { value: "fallback", label: "When no device of yours took the push" },
              { value: "always", label: "As well, every time" },
              { value: "never", label: "Never for approvals" },
            ]} />
          </Field>
          <div className="push-actions"><Button variant="primary" onClick={() => void save()} disabled={!changed || busy}>Save</Button></div>
        </div>
        </details>
      )}
    </section>
  );
}
