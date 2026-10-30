import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, Field, KeyValue, Notice, Panel, SecretInput, TextInput, mayStart, riskOf, type KeyValueItem, type Status } from "../../ui";
import { agentsApi, type CloudState } from "./api";
import { errorText } from "./format";

/*
 * Claude for the agents (M45.3, ADR-013). The owner's Anthropic key goes to the model gateway, the
 * one process that may use it; this page never holds it after the dialog sends it, and nothing reads
 * it back. The monthly cap is held twice, by BoxPilot and by the gateway's own count. Connecting is
 * high risk: the owner types the cap they agree to. No agent uses Claude until it is allowed to.
 */

export interface ClaudePanelProps {
  role: string;
  now: number;
  owner: boolean;
  onStart: (operation: PendingOperation) => void;
  /** Bumped by the page when a job it started has finished, so the panel reads again. */
  refreshKey: number;
}

const keyPattern = /^sk-ant-[A-Za-z0-9_-]{20,400}$/;
const modelNames: Record<string, string> = { "claude-opus-5-5": "Claude Opus 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-haiku-5-5": "Claude Haiku 5.5" };
const dollars = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** The cap as typed: whole dollars from 1 to 1000, or why not. */
function capOf(text: string): { value: number | null; problem: string | null } {
  if (!text.trim()) return { value: null, problem: null };
  const value = Number(text.trim().replace(/^\$/, ""));
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? { value, problem: null } : { value: null, problem: "Whole dollars from 1 to 1000" };
}

function verdict(state: CloudState): { status: Status; label: string } {
  if (state.connected && state.gateway === "answering") return { status: "good", label: "Connected" };
  if (state.connected) return { status: "warning", label: "Gateway not answering" };
  return { status: "unknown", label: "Not connected" };
}

export function ClaudePanel({ role, now, owner, onStart, refreshKey }: ClaudePanelProps) {
  const [state, setState] = useState<CloudState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [capText, setCapText] = useState("20");
  const [newCap, setNewCap] = useState("");

  const read = useCallback(async () => {
    try { setState(await agentsApi.cloud()); setError(null); } catch (requestError) { setError(errorText(requestError, "Claude's state could not be read")); }
  }, []);
  useEffect(() => { void read(); }, [read, refreshKey]);
  // The key leaves this page's memory once the dialog has it.
  useEffect(() => { if (state?.connected) setKey(""); }, [state?.connected]);

  if (!state) {
    return error
      ? <Notice tone="danger" live title="Claude's state could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>
      : <Panel title="Claude" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const shown = verdict(state);
  const cap = capOf(capText);
  const changed = capOf(newCap);
  const keyProblem = key && !keyPattern.test(key) ? "An Anthropic API key starts sk-ant- and comes from the Anthropic Console" : null;

  const connect = () => {
    if (!cap.value || !keyPattern.test(key)) return;
    onStart({
      operationId: "agents.cloud.connect",
      title: "Connect Claude",
      parameters: { key, capUsd: cap.value },
      preview: <span>Stores the key root-only for the model gateway, the one process on this server that may use it, and starts the gateway. Claude checks the key first, which costs nothing; a key it refuses is not kept. Agents never spend more than <strong>{dollars(cap.value)} a month</strong> on Claude: BoxPilot holds them to it, and so does the gateway, from its own count. Agents you already have stay on the local model until you change them; agents you make from now on move to Claude when a run needs it, which you change per agent.</span>,
    });
  };
  const setCap = () => {
    if (!changed.value) return;
    onStart({ operationId: "agents.cloud.cap", title: "Change Claude's monthly cap", parameters: { capUsd: changed.value }, preview: <span>From the next call, the gateway refuses any call that could take this month past <strong>{dollars(changed.value)}</strong>.</span> });
  };
  const disconnect = () => onStart({ operationId: "agents.cloud.disconnect", title: "Disconnect Claude", parameters: {}, preview: <span>Stops the model gateway and deletes the key from this server. Agents run on the local model only. This month&apos;s spend is kept.</span> });

  const facts: KeyValueItem[] = state.connected ? [
    { id: "model", label: "Model", value: modelNames[state.model ?? ""] ?? state.model ?? "unknown", hint: state.connectedAt ? `connected ${relativeTime(state.connectedAt, now) ?? ""}` : undefined },
    {
      id: "month", label: "This month", mono: true,
      status: state.spentUsd !== null && state.capUsd ? (state.spentUsd >= state.capUsd * 0.8 ? "warning" : undefined) : undefined,
      value: state.spentUsd !== null ? `${dollars(state.spentUsd)} of ${state.capUsd ? dollars(state.capUsd) : "no cap"}` : state.capUsd ? `cap ${dollars(state.capUsd)}` : "no cap",
      hint: state.calls !== null ? `${state.calls} ${state.calls === 1 ? "call" : "calls"} (UTC month ${state.month ?? ""})` : undefined,
    },
    { id: "gateway", label: "Gateway", status: state.gateway === "answering" ? "good" : "warning", value: state.gateway === "answering" ? "Answering" : "Not answering", hint: state.problem ?? undefined },
  ] : [];

  const actions = owner && state.connected && mayStart(role, "agents.cloud.disconnect")
    ? <Button variant="ghost" risk={riskOf("agents.cloud.disconnect")} onClick={disconnect}>Disconnect</Button>
    : undefined;

  return (
    <Panel className="agents-cloud" title="Claude" count={{ status: shown.status, label: shown.label }} meta={state.connected ? <>{modelNames[state.model ?? ""] ?? "Claude"}</> : "Anthropic"} actions={actions} padded>
      <div className="agents-cloud__body">
        {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
        {!state.connected && <p className="agents-quiet">Agents can use Claude, Anthropic&apos;s model, beside the local one. The key goes to the model gateway, a small service that holds it and sends to Anthropic alone; the web service never keeps it. You set a monthly cap, and choose per agent whether Claude may be used and what may leave this server.</p>}
        {state.connected && <KeyValue layout="rows" items={facts} />}
        {state.connected && state.gateway !== "answering" && <Notice tone="warning" title="The gateway is not answering">Agents run on the local model until it does. Connecting again restarts it.</Notice>}
        {owner && !state.connected && mayStart(role, "agents.cloud.connect") && (
          <form className="agents-cloud__form" aria-label="Connect Claude" onSubmit={(event) => { event.preventDefault(); connect(); }}>
            <div className="agents-form__grid">
              <Field label="Anthropic API key" hint="From the Anthropic Console. Kept root-only for the gateway; never shown again." error={keyProblem}>
                <SecretInput value={key} onValueChange={(value) => setKey(value.trim())} />
              </Field>
              <Field label="Monthly cap, in dollars" hint="Claude is not called past it. You type it again to agree." error={cap.problem}>
                <TextInput value={capText} inputMode="numeric" onValueChange={setCapText} />
              </Field>
            </div>
            <div className="agents-editor__foot">
              <Button type="submit" variant="primary" risk={riskOf("agents.cloud.connect")} disabled={!keyPattern.test(key) || !cap.value}>Connect Claude</Button>
            </div>
          </form>
        )}
        {owner && state.connected && mayStart(role, "agents.cloud.cap") && (
          <form className="agents-cloud__form" aria-label="Change the monthly cap" onSubmit={(event) => { event.preventDefault(); setCap(); }}>
            <div className="agents-form__grid">
              <Field label="New monthly cap, in dollars" error={changed.problem}>
                <TextInput value={newCap} inputMode="numeric" placeholder={state.capUsd ? String(state.capUsd) : "20"} onValueChange={setNewCap} />
              </Field>
            </div>
            <div className="agents-editor__foot">
              <Button type="submit" risk={riskOf("agents.cloud.cap")} disabled={!changed.value || changed.value === state.capUsd}>Change the cap</Button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
