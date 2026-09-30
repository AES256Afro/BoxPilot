import { useEffect, useState } from "react";
import { Button, Field, KeyValue, Notice, Panel, SecretInput, Select, StatusChip, TextInput } from "../../ui";
import HeartbeatPanel from "./HeartbeatPanel";

interface NotificationState { configured: boolean; kind: "ntfy" | "gotify" | "webhook" | null; url: string | null; topic: string | null; hasToken: boolean }
interface WatchCondition { key: string; label: string; active: boolean; details: Array<{ title: string; since: string | null }> }
interface WatchStatus { targetConfigured: boolean; activeCount: number; conditions: WatchCondition[] }
interface WeeklyReportStatus { enabled: boolean; cadence: string; nextDueAt: string | null; lastSentAt: string | null; lastResult: "sent" | "not-announced" | "missed" | null; targetConfigured: boolean }

const services = [{ value: "ntfy", label: "ntfy" }, { value: "gotify", label: "Gotify" }, { value: "webhook", label: "Webhook" }];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

/**
 * The weekly self-report (M30.4): on or off, when it goes, a preview of what it would say now, and
 * a way to send it at once. Sending now goes straight to the target, so a failure shows here.
 */
function WeeklyReport({ csrfToken, targetConfigured }: { csrfToken: string; targetConfigured: boolean }) {
  const [status, setStatus] = useState<WeeklyReportStatus | null>(null);
  const [preview, setPreview] = useState<{ title: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/settings/weekly-report").then((response) => (response.ok ? response.json() : null)).then((body: WeeklyReportStatus | null) => setStatus(body)).catch(() => {});
  }, []);

  const call = async <T,>(url: string, init: RequestInit, done: (body: T) => void, failure: string) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch(url, init);
      const body = (await response.json().catch(() => ({}))) as T & { error?: string };
      if (!response.ok) throw new Error(body.error ?? failure);
      done(body);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : failure);
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => call("/api/v1/settings/weekly-report", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ enabled: !status?.enabled }) }, (body: WeeklyReportStatus) => setStatus(body), "Could not change the weekly report");
  const show = () => call("/api/v1/settings/weekly-report/preview", {}, (body: { title: string; message: string }) => setPreview(body), "Could not put the report together");
  const send = () => call("/api/v1/settings/weekly-report/send", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }, (body: { title: string; message: string }) => { setPreview(body); setMessage("Sent. Check your device."); }, "The report could not be sent");

  if (!status) return null;
  return (
    <Panel
      title="Weekly report"
      count={{ status: status.enabled ? "good" : "neutral", label: status.enabled ? "on" : "off" }}
      meta={status.lastResult === "sent" && status.lastSentAt ? <>last sent <b>{when(status.lastSentAt)}</b></> : undefined}
      padded
      className="settings-panel"
    >
      <p className="settings-quiet">
        {status.enabled ? `${status.cadence}, server time${status.nextDueAt ? `; next ${when(status.nextDueAt)}` : ""}.` : "Off."}
        {status.lastResult === "sent" && status.lastSentAt ? ` Last sent ${when(status.lastSentAt)}.` : ""}
        {status.lastResult === "not-announced" ? " The last one reached no one; Home and Ops list it." : ""}
      </p>
      <p className="settings-quiet">One push a week: what ran, what failed, what did not run and why, and what is not covered yet.</p>
      <div className="settings-actions">
        <Button disabled={busy} onClick={() => void show()}>Preview the report</Button>
        <Button disabled={busy || !targetConfigured} onClick={() => void send()}>Send the report now</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void toggle()}>{status.enabled ? "Turn off the weekly report" : "Turn on the weekly report"}</Button>
      </div>
      {/* Not a greyed button with no reason: say what sending needs. */}
      {!targetConfigured && <p className="settings-quiet">Sending needs a notification target: set one above.</p>}
      {preview && (
        <div className="settings-report" aria-label="Weekly report preview">
          <strong>{preview.title}</strong>
          {preview.message.split("\n").map((line, index) => <span key={index}>{line}</span>)}
        </div>
      )}
      {message && <Notice tone="success" live>{message}</Notice>}
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Panel>
  );
}

/**
 * Settings → Notifications: where alerts and the weekly report go (ntfy, Gotify or a webhook; ntfy
 * and Gotify are both in the app catalog, so the target can live on this very server), what BoxPilot
 * watches for, and the weekly report. Owner-only (ADR-003): the target and its token are the box's.
 */
export default function NotificationsPanel({ csrfToken, onChange }: { csrfToken: string; /** The target changed: the page reads its facts again. */ onChange?: () => void }) {
  const [current, setCurrent] = useState<NotificationState | null>(null);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<"ntfy" | "gotify" | "webhook">("ntfy");
  const [url, setUrl] = useState("");
  const [topic, setTopic] = useState("boxpilot");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [watch, setWatch] = useState<WatchStatus | null>(null);
  // A notification server the owner already installed on this box. BoxPilot can send to it over
  // loopback without anything being exposed, so the target is one click of prefill plus a password.
  const [localServer, setLocalServer] = useState<{ kind: "ntfy" | "gotify"; name: string; sendUrl: string; reachAddress: string | null } | null>(null);
  const refresh = () => fetch("/api/v1/settings/notifications").then((response) => response.json()).then((body: NotificationState) => setCurrent(body)).catch(() => setError("Could not read the notification settings"));
  useEffect(() => {
    void refresh();
    fetch("/api/v1/settings/watch").then((response) => (response.ok ? response.json() : null)).then((body: WatchStatus | null) => setWatch(body && Array.isArray(body.conditions) ? body : null)).catch(() => {});
    // ntfy and Gotify are both in the catalog and both can be the target; if one is installed and
    // running, offer to point BoxPilot straight at it rather than making the owner type its address.
    fetch("/api/v1/catalog?view=summary").then((response) => (response.ok ? response.json() : null)).then((data: { applications?: Array<{ manifest: { id: string; name: string }; live: { installed: boolean; container: { running: boolean }; urls: Array<{ host: number }> } | null }>; host?: { lanAddress: string | null; tailscaleDnsName: string | null } } | null) => {
      if (!data?.applications) return;
      for (const wanted of ["ntfy", "gotify"] as const) {
        const entry = data.applications.find((app) => app.manifest.id === wanted && app.live?.installed && app.live.container.running);
        const port = entry?.live?.urls?.[0]?.host;
        if (entry && port) {
          setLocalServer({ kind: wanted, name: entry.manifest.name, sendUrl: `http://127.0.0.1:${port}`, reachAddress: data.host?.tailscaleDnsName ?? data.host?.lanAddress ?? null });
          break;
        }
      }
    }).catch(() => {});
  }, []);

  const useLocalServer = () => {
    if (!localServer) return;
    setEditing(true);
    setKind(localServer.kind);
    setUrl(localServer.sendUrl);
    if (localServer.kind === "ntfy") setTopic("boxpilot");
    setMessage(null); setError(null);
  };

  const save = async (target: { kind: string; url: string; topic?: string; token?: string } | null) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/v1/settings/notifications", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ target, password }) });
      const body = (await response.json()) as NotificationState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save the notification target");
      setCurrent(body); setEditing(false); setPassword(""); setToken("");
      setMessage(target ? "Saved. Send a test to make sure it arrives." : "Notifications are off.");
      onChange?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save the notification target");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/v1/settings/notifications/test", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The test notification failed");
      setMessage("Test sent. Check your device.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The test notification failed");
    } finally {
      setBusy(false);
    }
  };

  const configured = current?.configured === true;
  const form = !configured || editing;
  const offerLocal = Boolean(localServer && form && url !== localServer.sendUrl);

  return (
    <>
      <div className="settings-column">
        <Panel
          title="Where alerts go"
          count={current ? { status: configured ? "good" : "neutral", label: configured ? `${current.kind} configured` : "Off" } : undefined}
          padded
          className="settings-panel"
          footer="A push for a failed job, a new BoxPilot release, a sign-in from a new address, a watched condition turning bad and clearing, and the weekly report."
        >
          {configured && !editing && current && (
            <>
              <KeyValue layout="rows" items={[
                { id: "kind", label: "Service", value: current.kind ?? "", mono: true },
                { id: "url", label: "Sends to", value: current.url ?? "", mono: true },
                ...(current.kind === "ntfy" && current.topic ? [{ id: "topic", label: "Topic", value: current.topic, mono: true }] : []),
                { id: "token", label: "Token", value: current.hasToken ? "kept on this server" : "none" },
              ]} />
              <div className="settings-actions">
                <Button disabled={busy} onClick={() => void test()}>Send a test</Button>
                <Button variant="ghost" onClick={() => { setEditing(true); setKind(current.kind ?? "ntfy"); setUrl(current.url ?? ""); setTopic(current.topic ?? "boxpilot"); }}>Change</Button>
              </div>
            </>
          )}
          {!current && !error && <p className="settings-quiet">Reading…</p>}
          {offerLocal && localServer && (
            <Notice tone="info" title={`${localServer.name} is running on this server`} action={<Button onClick={useLocalServer}>Use the {localServer.name} on this server</Button>}>
              Point BoxPilot at it in one step.
            </Notice>
          )}
          {localServer && url === localServer.sendUrl && (
            <p className="settings-quiet">Alerts will be sent to the {localServer.name} on this server. To get them on your phone, open the {localServer.name} app and subscribe to {kind === "ntfy" ? <>topic <code>{topic || "boxpilot"}</code></> : "this server"}{localServer.reachAddress ? <> at <code>{localServer.reachAddress}</code></> : ""}. If the app is only reachable from this server, publish it on your tailnet first from its catalog card.</p>
          )}
          {form && current && (
            <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (password.length >= 12 && url) void save({ kind, url, ...(kind === "ntfy" ? { topic } : {}), ...(token ? { token } : {}) }); }}>
              <div className="settings-grid-form">
                <Field label="Notification service">
                  <Select options={services} value={kind} onValueChange={(value) => setKind(value as typeof kind)} />
                </Field>
                <Field label="Server URL">
                  <TextInput mono placeholder={kind === "webhook" ? "https://example.net/hook" : "http://127.0.0.1:8093"} value={url} onValueChange={(value) => setUrl(value.trim())} autoComplete="off" spellCheck={false} />
                </Field>
                {kind === "ntfy" && (
                  <Field label="Topic">
                    <TextInput mono placeholder="topic" value={topic} onValueChange={(value) => setTopic(value.trim())} autoComplete="off" spellCheck={false} />
                  </Field>
                )}
                <Field label="Token" optional hint={kind === "gotify" ? "The application token." : kind === "ntfy" ? "An access token, if the topic needs one." : "A bearer token, if the webhook needs one."}>
                  <SecretInput value={token} onValueChange={setToken} />
                </Field>
              </div>
              <p className="settings-quiet">The address and any token are kept on this server so alerts can be sent while you are away, and they are included in BoxPilot's own database backups. Use a token scoped to sending notifications rather than one that can do more.</p>
              <div className="settings-form settings-form--row">
                <Field label="Owner password" hint="Changing where alerts go asks for it.">
                  <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} />
                </Field>
                <div className="settings-actions">
                  <Button variant="primary" type="submit" disabled={busy || password.length < 12 || !url}>{busy ? "Saving..." : "Save"}</Button>
                  {configured && <Button disabled={busy || password.length < 12} onClick={() => void save(null)}>Turn off</Button>}
                  {editing && <Button variant="ghost" onClick={() => { setEditing(false); setPassword(""); }}>Cancel</Button>}
                </div>
              </div>
            </form>
          )}
          {message && <Notice tone="success" live>{message}</Notice>}
          {error && <Notice tone="danger" live>{error}</Notice>}
        </Panel>
        <WeeklyReport csrfToken={csrfToken} targetConfigured={configured} />
      </div>

      <div className="settings-column">
      {/* M39.3: something outside this server that notices when it goes quiet. */}
      <HeartbeatPanel csrfToken={csrfToken} />
      {watch && (
        <Panel
          title="What BoxPilot watches"
          count={{ status: watch.activeCount ? "warning" : "good", label: watch.activeCount ? `${watch.activeCount} needs attention` : "All clear" }}
          meta={watch.targetConfigured ? "checked every 15 minutes" : "no target: these cannot reach you"}
          className="settings-panel"
          footer="A push when one turns bad, and again when it clears. A scheduled task or automation that keeps failing is one push until it works again; anything that could not be sent is listed on Home and Ops."
        >
          <ul className="settings-watch" aria-label="Conditions BoxPilot watches for">
            {watch.conditions.map((condition) => (
              <li key={condition.key} className="settings-watch__item" title={condition.active ? condition.details.map((detail) => detail.title).join("; ") : "Clear"}>
                <span>{condition.label}{condition.active && condition.details.length > 1 ? ` (${condition.details.length})` : ""}</span>
                <StatusChip status={condition.active ? "warning" : "good"}>{condition.active ? "needs a look" : "clear"}</StatusChip>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      </div>
    </>
  );
}
