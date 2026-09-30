import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { inspectOperation } from "../../operations";
import { Button, Checkbox, Field, KeyValue, Notice, Panel, SecretInput, Select, riskOf, type Status } from "../../ui";

/*
 * Settings, Notifications, Heartbeat (M39.3, ADR-008). Nothing on a server that is off can say so,
 * and on 2026-09-29 the owner's notifier was on the server that went down. So this server can send a
 * bare request every few minutes to a dead man's switch the owner chose, which alerts their phone
 * when the requests stop. Off until turned on; owner-only; the address is a credential, never shown
 * again, only the host it goes to.
 */

interface HeartbeatState {
  configured: boolean;
  host: string | null;
  installed: boolean;
  enabled: boolean;
  intervalMinutes: number | null;
  last: { at: string; ok: boolean; status: number | null; ms: number | null; error: string | null } | null;
  intervals: number[];
}

const defaultIntervals = [1, 2, 5, 10, 15, 30, 60];
const minutesWords = (minutes: number) => (minutes === 60 ? "hour" : minutes === 1 ? "minute" : `${minutes} minutes`);

/** What the server checks too (server/heartbeat.mjs), said before staging rather than after. */
export function addressProblem(url: string): string | undefined {
  if (!url) return undefined;
  if (!URL.canParse(url)) return "Paste the whole address, starting https://";
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) return "It must start with https:// or http://";
  if (parsed.username || parsed.password) return "An address with a user name or password in it cannot be used";
  return undefined;
}

/** A switch on this very server goes down with it, which is the one thing it must not do. */
export function onThisServer(url: string, own: string[]): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(host) || host.startsWith("127.") || own.includes(host);
}

export default function HeartbeatPanel({ csrfToken, now = Date.now }: { csrfToken: string; now?: () => number }) {
  const [state, setState] = useState<HeartbeatState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [every, setEvery] = useState(5);
  const [forget, setForget] = useState(false);
  const [own, setOwn] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { result } = await inspectOperation<HeartbeatState>("heartbeat.inspect");
      setState(result);
      setError(null);
      if (result.intervalMinutes) setEvery(result.intervalMinutes);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The heartbeat could not be read");
    }
  }, []);
  useEffect(() => {
    void refresh();
    // This server's own names and addresses, to warn about a switch that would go down with it.
    fetch("/api/v1/network/topology").then((response) => (response.ok ? response.json() : null)).then((topology: { addresses?: Array<{ address: string }>; tailscale?: { dnsName?: string | null } } | null) => {
      const dnsName = topology?.tailscale?.dnsName?.toLowerCase() ?? null;
      setOwn([...(topology?.addresses ?? []).map((entry) => entry.address), ...(dnsName ? [dnsName, dnsName.split(".")[0]] : [])]);
    }).catch(() => {});
  }, [refresh]);
  const { start, dialog } = useOperation(csrfToken, () => { setEditing(false); setUrl(""); setForget(false); void refresh(); });

  const problem = addressProblem(url);
  const local = Boolean(url && !problem && onThisServer(url, own));
  const host = url && !problem ? new URL(url).host : state?.host ?? null;
  const intervals = (state?.intervals?.length ? state.intervals : defaultIntervals).map((minutes) => ({ value: String(minutes), label: `every ${minutesWords(minutes)}` }));
  const on = Boolean(state?.enabled);
  const form = Boolean(state) && (!on || editing);
  const canSave = !problem && (url ? true : Boolean(state?.configured && on));

  const save = () => start({
    operationId: "heartbeat.set",
    title: on ? "Change the heartbeat" : "Turn the heartbeat on",
    parameters: { enabled: true, intervalMinutes: every, ...(url ? { url } : {}) },
    preview: <span>{url ? "Saves the address as a root-only credential, and " : ""}has this server send a bare request to <code>{host ?? "the saved address"}</code> every {minutesWords(every)}, the first one now. Nothing about this server goes with it. Set the check&apos;s period there to {minutesWords(every)}, and its grace time to at least as long again.</span>,
  });
  const test = () => start({ operationId: "heartbeat.test", title: "Send a test heartbeat", parameters: {}, preview: <span>Sends one heartbeat to <code>{state?.host ?? "the saved address"}</code> now, from the same unit the timer runs. It should show on your dead man&apos;s switch within a minute.</span> });
  const turnOff = () => start({
    operationId: "heartbeat.set", title: "Turn the heartbeat off", parameters: { enabled: false, ...(forget ? { forget: true } : {}) },
    preview: <span>Stops the timer{forget ? " and forgets the address" : ""}. Your dead man&apos;s switch will alert you once its period runs out, so pause or delete the check there as well.</span>,
  });

  const last = state?.last ?? null;
  const lastStatus: Status = !last ? "unknown" : last.ok ? "good" : "danger";
  const count = !state ? undefined : on ? { status: (last && !last.ok ? "warning" : "good") as Status, label: last && !last.ok ? "on, failing" : "on" } : { status: "neutral" as Status, label: "off" };

  return (
    <Panel
      title="Heartbeat"
      count={count}
      meta={on && state?.intervalMinutes ? <>every <b>{state.intervalMinutes}</b> min</> : undefined}
      padded
      className="settings-panel"
      footer="One bare request with no body and nothing about this server: the service sees the time and the address it came from, as it would for any request. Tailscale's admin console shows when this server was last seen, but it does not alert when a device goes offline."
    >
      {dialog}
      {error && <Notice tone="danger" live title="The heartbeat could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
      {!state && !error && <p className="settings-quiet">Reading…</p>}
      {state && !state.installed && <Notice tone="warning" title="Not installed on this server yet">The heartbeat&apos;s timer arrives with the next BoxPilot upgrade.</Notice>}
      {state && on && (
        <>
          <KeyValue layout="rows" items={[
            { id: "host", label: "Pings", value: state.host ?? "the saved address", mono: true },
            { id: "every", label: "Every", value: state.intervalMinutes ? minutesWords(state.intervalMinutes) : "the timer's own interval" },
            { id: "last", label: "Last ping", status: lastStatus, value: !last ? "none yet" : last.ok ? `taken ${relativeTime(last.at, now()) ?? last.at}` : `not taken ${relativeTime(last.at, now()) ?? ""}`.trim(), hint: last ? (last.ok ? `HTTP ${last.status ?? "?"} in ${last.ms ?? "?"} ms` : last.error ?? undefined) : undefined },
          ]} />
          {!editing && (
            <div className="settings-actions">
              <Button risk={riskOf("heartbeat.test")} onClick={test}>Send a test ping</Button>
              <Button variant="ghost" onClick={() => setEditing(true)}>Change</Button>
            </div>
          )}
        </>
      )}
      {state && !on && !editing && (
        <p className="settings-quiet">While this server is off, nothing on it can tell you. A dead man&apos;s switch elsewhere can: this server pings it every few minutes, and it alerts your phone when the pings stop. healthchecks.io&apos;s free plan works (make a check, add your phone, for instance ntfy, as its alert, paste its ping address here), as does Healthchecks or an Uptime Kuma push monitor on another machine.</p>
      )}
      {state && form && (
        <form className="settings-form" aria-label="Heartbeat" onSubmit={(event) => { event.preventDefault(); if (canSave) save(); }}>
          <div className="settings-grid-form">
            <Field label="Ping address" hint={state.configured ? `Leave empty to keep the saved one (${state.host ?? "saved"}).` : "The check's ping URL, such as https://hc-ping.com/…"} error={problem}>
              <SecretInput value={url} onValueChange={(value) => setUrl(value.trim())} />
            </Field>
            <Field label="How often">
              <Select options={intervals} value={String(every)} onValueChange={(value) => setEvery(Number(value))} />
            </Field>
          </div>
          {local && <Notice tone="warning" title="That address is this server">A dead man&apos;s switch here goes down with the server it is meant to watch. Use one on another machine, or healthchecks.io.</Notice>}
          <div className="settings-actions">
            <Button type="submit" variant="primary" risk={riskOf("heartbeat.set")} disabled={!canSave}>{on ? "Save" : "Turn on"}</Button>
            {editing && <Button variant="ghost" onClick={() => { setEditing(false); setUrl(""); }}>Cancel</Button>}
          </div>
        </form>
      )}
      {state && on && editing && (
        <div className="settings-sub">
          <Checkbox label="Also forget the saved address" checked={forget} onChange={setForget} />
          <div className="settings-actions"><Button risk={riskOf("heartbeat.set")} onClick={turnOff}>Turn off</Button></div>
        </div>
      )}
    </Panel>
  );
}
