import { useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { countOf } from "../../data";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, TextInput, mayStart, riskOf, type Status } from "../../ui";
import type { Fail2banState } from "./types";

/*
 * Brute-force protection for SSH (fail2ban), the Firewall page's third tab (M33.10). Facts first:
 * whether it is on, how many addresses are banned now and since it started, the thresholds and
 * what is never banned. Those facts are every account's to see (ADR-003 addendum, 2026-09-28);
 * only changing them needs a role that may.
 */

export function fail2banVerdict(state: Fail2banState | null): { status: Status; label: string } {
  if (!state) return { status: "unknown", label: "not read" };
  if (!state.installed) return { status: "neutral", label: "not installed" };
  if (state.running && state.configured) return { status: "good", label: "on" };
  if (state.running) return { status: "warning", label: "running, not BoxPilot's" };
  return { status: "neutral", label: "off" };
}

export interface FirewallBruteForceProps {
  state: Fail2banState | null;
  error: string | null;
  role: string;
  start: (operation: PendingOperation) => void;
  onRetry: () => void;
}

const whole = (value: string, min: number, max: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
};

export function FirewallBruteForce({ state, error, role, start, onRetry }: FirewallBruteForceProps) {
  // What the owner has typed, over the thresholds in force (or fail2ban's usual ones when BoxPilot
  // does not manage the jail); when what is in force changes, it starts over from that. Another read
  // that says the same keeps what was typed: a refresh landing after an edit used to wipe it.
  const [draft, setDraft] = useState<{ maxRetry?: string; findTime?: string; banTime?: string; ignoreLan?: boolean }>({});
  const inForce = JSON.stringify(state?.config ?? null);
  useEffect(() => { setDraft({}); }, [inForce]);
  const managed = state?.config.managed ? state.config : null;
  const maxRetry = draft.maxRetry ?? String(managed?.maxRetry ?? 5);
  const findTime = draft.findTime ?? String(managed?.findTimeMinutes ?? 10);
  const banTime = draft.banTime ?? String(managed?.banTimeMinutes ?? 60);
  const ignoreLan = draft.ignoreLan ?? (managed ? managed.ignoreLan : true);
  const setMaxRetry = (value: string) => setDraft((current) => ({ ...current, maxRetry: value }));
  const setFindTime = (value: string) => setDraft((current) => ({ ...current, findTime: value }));
  const setBanTime = (value: string) => setDraft((current) => ({ ...current, banTime: value }));
  const setIgnoreLan = (value: boolean) => setDraft((current) => ({ ...current, ignoreLan: value }));

  if (!state) {
    return error
      ? <Notice tone="danger" title="Brute-force protection could not be read" action={<Button onClick={onRetry}>Try again</Button>}>{error}</Notice>
      : <Panel title="Brute-force protection"><p className="firewall-quiet">Reading fail2ban…</p></Panel>;
  }

  if (!state.installed) {
    return (
      <Panel title="Brute-force protection" count={{ status: "neutral", label: "not installed" }}>
        <EmptyState
          title="fail2ban is not installed"
          action={mayStart(role, "apt.install") ? <Button risk={riskOf("apt.install")} onClick={() => start({ operationId: "apt.install", title: "Install fail2ban", parameters: { packages: ["fail2ban"] }, preview: <span><code>apt-get install --no-install-recommends fail2ban</code>. Nothing is enforced until you turn it on here.</span> })}>Install fail2ban</Button> : undefined}
        >
          It bans addresses that keep failing SSH logins for a while. It matters most when SSH is reachable from outside your tailnet.
        </EmptyState>
      </Panel>
    );
  }

  const verdict = fail2banVerdict(state);
  const active = Boolean(state.running && state.configured);
  const config = state.config;
  const retries = whole(maxRetry, 1, 50);
  const find = whole(findTime, 1, 1440);
  const ban = whole(banTime, 1, 43200);
  const ready = retries !== null && find !== null && ban !== null;
  const canApply = mayStart(role, "fail2ban.apply");

  const apply = (enabled: boolean) => start({
    operationId: "fail2ban.apply",
    title: enabled ? `${active ? "Update" : "Turn on"} brute-force protection for SSH` : "Turn off brute-force protection",
    parameters: enabled ? { enabled: true, maxRetry: retries, findTimeMinutes: find, banTimeMinutes: ban, ignoreLan } : { enabled: false },
    preview: enabled
      ? <span>Bans an address for <strong>{ban} min</strong> after <strong>{retries}</strong> failed SSH logins within <strong>{find} min</strong>. Never bans this machine, your tailnet{ignoreLan ? ", or your LAN" : ""}, so a typo at home cannot lock you out. Writes <code>/etc/fail2ban/jail.d/boxpilot.local</code>, tests it, and starts fail2ban.</span>
      : <span>Stops and disables fail2ban and removes the managed jail file. Existing bans are lifted.</span>,
  });

  const never = config.ignore.length ? config.ignore : ["this machine", "your tailnet"];
  return (
    <>
      {error && <Notice tone="danger" title="Brute-force protection could not be read again" action={<Button onClick={onRetry}>Try again</Button>}>{error}</Notice>}
      <Panel
        padded
        className="firewall-bans"
        title="Brute-force protection"
        count={verdict}
        meta={state.currentlyBanned !== null ? <><b>{state.currentlyBanned}</b> banned now</> : undefined}
      >
        <KeyValue
          layout="columns"
          items={[
            { id: "state", label: "State", value: active ? "On" : state.running ? "Running, not configured by BoxPilot" : "Off", status: verdict.status },
            { id: "now", label: "Banned now", value: state.currentlyBanned ?? "—", mono: true, status: state.currentlyBanned ? "warning" : undefined },
            { id: "total", label: "Bans since start", value: state.totalBanned ?? "—", mono: true },
            { id: "jail", label: "SSH jail", value: config.sshd ? "On" : "Off", mono: true },
            { id: "threshold", label: "Bans after", value: config.managed && config.maxRetry !== null ? `${countOf(config.maxRetry, "failure")} in ${config.findTimeMinutes ?? "?"} min` : "—", mono: true },
            { id: "length", label: "Ban length", value: config.managed && config.banTimeMinutes !== null ? `${config.banTimeMinutes} min` : "—", mono: true },
            { id: "never", label: "Never banned", value: <span className="firewall-list">{never.map((entry) => <code key={entry}>{entry}</code>)}</span> },
          ]}
        />
      </Panel>

      {canApply && (
        <Panel padded className="firewall-thresholds" title="Thresholds" meta={active ? "in force" : "not in force"}>
          <form className="firewall-thresholds__form" onSubmit={(event) => { event.preventDefault(); if (ready) apply(true); }}>
            <Field label="Failed logins before a ban" error={retries === null ? "A whole number from 1 to 50." : undefined}>
              <TextInput mono type="number" inputMode="numeric" min={1} max={50} value={maxRetry} onValueChange={setMaxRetry} />
            </Field>
            <Field label="Within (minutes)" error={find === null ? "A whole number from 1 to 1440." : undefined}>
              <TextInput mono type="number" inputMode="numeric" min={1} max={1440} value={findTime} onValueChange={setFindTime} />
            </Field>
            <Field label="Ban for (minutes)" error={ban === null ? "A whole number from 1 to 43200." : undefined}>
              <TextInput mono type="number" inputMode="numeric" min={1} max={43200} value={banTime} onValueChange={setBanTime} />
            </Field>
            <Checkbox className="firewall-thresholds__lan" label="Never ban my LAN" description="This machine and your tailnet are never banned either way." checked={ignoreLan} onChange={setIgnoreLan} />
            <div className="firewall-thresholds__actions">
              <Button type="submit" variant="primary" risk={riskOf("fail2ban.apply")} disabled={!ready}>{active ? "Apply changes" : "Turn on protection"}</Button>
              {active && <Button risk={riskOf("fail2ban.apply")} onClick={() => apply(false)}>Turn off protection</Button>}
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}
