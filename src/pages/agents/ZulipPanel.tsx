import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, Field, KeyValue, Notice, Panel, Select, StatusChip, Switch, Table, Tag, TextInput, mayStart, riskOf, type KeyValueItem, type Status, type TableColumn } from "../../ui";
import { agentsApi, type AgentSummary, type ChatPost, type ZulipAsking, type ZulipPerson, type ZulipState } from "./api";
import { errorText } from "./format";
import { PasswordSheet } from "./PasswordSheet";

/*
 * The team chat (M38): Zulip, which the owner installs from the App catalog and connects here. Whether
 * it is installed and connected; the four channels and what goes to each; the last post or what
 * went wrong; what came in from #agent-files; and, for the owner, the last few posts. Connect is a
 * registered operation approved in the ordinary dialog: it makes the bot and the channels with
 * Zulip's own manage.py and keeps the bot's key in the credential store, never on this page.
 */

export interface ZulipPanelProps {
  csrfToken: string;
  role: string;
  now: number;
  onStart: (operation: PendingOperation) => void;
  /** Bumped by the page when a job it started has finished, so the panel reads again. */
  refreshKey: number;
  /** The agents, for the one asked by default in Zulip (M40.5). */
  agents?: AgentSummary[];
}

/**
 * Asking the agents in Zulip (M40.5), the owner's: who in Zulip asks as which BoxPilot account, the
 * agent asked when a message names none, and whether questions are answered at all. Someone who
 * asked without being set up is listed, to let them ask with one choice. Saving takes the password:
 * it lets a chat account ask as a BoxPilot one.
 */
function AskingInZulip({ asking, agents, csrfToken, now, onSaved }: { asking: ZulipAsking; agents: AgentSummary[]; csrfToken: string; now: number; onSaved: (next: ZulipState) => void }) {
  const [people, setPeople] = useState<ZulipPerson[]>(asking.people);
  const [defaultAgentId, setDefaultAgentId] = useState<string>(asking.defaultAgentId ?? "");
  const [on, setOn] = useState(asking.on);
  const [adding, setAdding] = useState({ email: "", account: "" });
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const accountName = (id: string) => asking.accounts.find((account) => account.id === id);
  const accountOptions = [{ value: "", label: "Choose an account" }, ...asking.accounts.map((account) => ({ value: account.id, label: `${account.username} (${account.role})` }))];
  const waiting = asking.askers.filter((asker) => !people.some((person) => (person.zulipId && person.zulipId === asker.zulipId) || person.zulipEmail === asker.zulipEmail));
  const dirty = JSON.stringify(people) !== JSON.stringify(asking.people) || (defaultAgentId || null) !== asking.defaultAgentId || on !== asking.on;
  const save = async (password: string) => {
    const next = await agentsApi.zulipPeople(csrfToken, { password, people, defaultAgentId: defaultAgentId || null, twoWay: on });
    setSaved("Saved. The next question in Zulip goes by this list.");
    onSaved(next);
  };
  const columns: Array<TableColumn<ZulipPerson>> = [
    { id: "who", header: "In Zulip", cell: (person) => <span className="agents-name"><span>{person.zulipName ?? person.zulipEmail ?? `user ${person.zulipId}`}</span><span className="agents-name__purpose">{person.zulipEmail ?? ""}</span></span> },
    { id: "as", header: "Asks as", cell: (person) => { const account = accountName(person.boxpilotId); return <span className="agents-mono">{account ? `${account.username} · ${account.role}` : "an account that is gone"}</span>; } },
    { id: "remove", header: <span className="ui-visually-hidden">Remove</span>, label: "Actions", className: "agents-actions-cell", cell: (person) => <Button variant="ghost" onClick={() => setPeople(people.filter((entry) => entry !== person))} aria-label={`Stop ${person.zulipName ?? person.zulipEmail ?? "them"} asking`}>Remove</Button> },
  ];
  return (
    <section className="agents-zulip__asking" aria-label="Asking in Zulip">
      <h3 className="agents-zulip__heading">Asking in Zulip</h3>
      <p className="agents-dim">Send the bot a direct message, or mention it in a channel it is in, and an agent answers in that thread: read-only, as the BoxPilot account below, as if asked on the Test tab. Cards it proposes link back here; nothing is approved in chat. Anyone not on this list is told they are not set up, and no model sees their words.</p>
      {saved && <Notice tone="success" live onDismiss={() => setSaved(null)}>{saved}</Notice>}
      <Switch label="Answer questions asked in Zulip" description={asking.lastPollAt ? `Read ${relativeTime(asking.lastPollAt, now) ?? "just now"}, once a minute while Agents run.` : "Read once a minute while Agents run."} checked={on} onChange={setOn} />
      {asking.lastError && <p className="agents-dim">The last read did not work: {asking.lastError}</p>}
      <div className="agents-form__grid">
        <Field label="Asked when a message names no agent" hint="A message can start with an agent's name, like: Steve, which drives are connected?">
          <Select value={defaultAgentId} onValueChange={setDefaultAgentId} options={[{ value: "", label: "The Server Keeper, or the first that takes the question" }, ...agents.map((agent) => ({ value: agent.id, label: agent.name }))]} />
        </Field>
      </div>
      <Table caption="Who may ask in Zulip" columns={columns} rows={people} rowKey={(person) => `${person.zulipId ?? ""}|${person.zulipEmail ?? ""}`} empty="Nobody yet: add someone below, or let in someone who asked." />
      {waiting.length > 0 && (
        <ul className="agents-zulip__askers" aria-label="Asked, not set up">
          {waiting.map((asker) => (
            <li key={`${asker.zulipId}|${asker.zulipEmail}`} className="agents-zulip__asker">
              <span className="agents-name"><span>{asker.zulipName || asker.zulipEmail} asked {asker.count === 1 ? "once" : `${asker.count} times`}</span><span className="agents-name__purpose">{asker.zulipEmail} · {relativeTime(asker.lastAt, now) ?? ""}</span></span>
              <Select aria-label={`Let ${asker.zulipName || asker.zulipEmail} ask as`} value="" onValueChange={(value) => value && setPeople([...people, { zulipId: asker.zulipId, zulipEmail: asker.zulipEmail, zulipName: asker.zulipName, boxpilotId: value }])} options={[{ value: "", label: "Let them ask as…" }, ...accountOptions.slice(1)]} />
            </li>
          ))}
        </ul>
      )}
      <div className="agents-form__grid">
        <Field label="Their Zulip address"><TextInput value={adding.email} placeholder="name@example.com" onValueChange={(value) => setAdding({ ...adding, email: value })} /></Field>
        <Field label="Asks as"><Select value={adding.account} onValueChange={(value) => setAdding({ ...adding, account: value })} options={accountOptions} /></Field>
      </div>
      <div className="agents-editor__foot">
        <Button variant="ghost" disabled={!/^[^\s@]+@[^\s@]+$/.test(adding.email.trim()) || !adding.account} onClick={() => { setPeople([...people, { zulipId: null, zulipEmail: adding.email.trim().toLowerCase(), zulipName: null, boxpilotId: adding.account }]); setAdding({ email: "", account: "" }); }}>Add</Button>
        <Button variant="primary" disabled={!dirty} onClick={() => setConfirm(true)}>Save who may ask</Button>
      </div>
      {confirm && (
        <PasswordSheet title="Save who may ask in Zulip" confirmLabel="Save" onClose={() => setConfirm(false)} onConfirm={save}>
          <p>Each person on the list asks the agents as the BoxPilot account beside them, read-only. It takes your password.</p>
        </PasswordSheet>
      )}
    </section>
  );
}

const channelWords: Record<string, string> = {
  findings: "answers, digests, and cards that link back here to approve",
  logs: "each run's trace, one topic per agent",
  knowledge: "notes the agents keep, as they write them",
  files: "drop images, PDFs and documents here for the agents to learn from",
};
const stateTone: Record<ChatPost["state"], Status> = { queued: "unknown", sent: "good", failed: "danger", dropped: "warning" };

function verdict(state: ZulipState): { status: Status; label: string } {
  if (state.connected && state.lastError) return { status: "warning", label: "Connected, last post failed" };
  if (state.connected) return { status: "good", label: "Connected" };
  if (state.app?.installed) return { status: "unknown", label: "Installed, not connected" };
  return { status: "unknown", label: "Not installed" };
}

export function ZulipPanel({ csrfToken, role, now, onStart, refreshKey, agents = [] }: ZulipPanelProps) {
  const [state, setState] = useState<ZulipState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const read = useCallback(async () => {
    try { setState(await agentsApi.zulip()); setError(null); } catch (requestError) { setError(errorText(requestError, "The team chat could not be read")); }
  }, []);
  useEffect(() => { void read(); }, [read, refreshKey]);

  if (!state) {
    return error
      ? <Notice tone="danger" live title="The team chat could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>
      : <Panel title="Team chat" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const owner = state.canChange;
  const shown = verdict(state);
  // Where cards in chat link back to: this page's own address, when it is one the server takes.
  const here = /^https?:\/\/[A-Za-z0-9.-]{1,180}(?::\d{1,5})?$/.test(window.location.origin) ? window.location.origin : null;
  const connect = () => onStart({
    operationId: "agents.zulip.connect",
    title: state.connected ? "Connect the agents to Zulip again" : "Connect the agents to Zulip",
    parameters: here ? { boxpilotUrl: here } : {},
    preview: <span>Runs Zulip's own manage.py inside its container to make a bot for the agents, owned by your organization's owner, and four private channels only you and the bot are in: {Object.values(state.channels).map((name, index) => <span key={name}>{index ? ", " : ""}<code>#{name}</code></span>)}. The bot's key goes straight into BoxPilot's credential store and is never shown. {here ? <>Cards in chat link back to <code>{here}</code>, where approvals happen.</> : "Cards in chat say to decide on the Agents page, where approvals happen."} Safe to run again: it repairs what is missing.</span>,
  });
  const disconnect = () => onStart({
    operationId: "agents.zulip.disconnect",
    title: "Disconnect the agents from Zulip",
    parameters: {},
    preview: <span>Removes the bot's key from BoxPilot, so nothing more is posted or read. Nothing in Zulip is deleted: the bot, its channels and what was posted stay until you remove them there.</span>,
  });
  const check = async () => {
    setChecking(true);
    try {
      const read_ = await agentsApi.zulipPoll(csrfToken);
      const asked = read_.asked && !read_.asked.skipped && !read_.asked.error ? ` ${read_.asked.asked ?? 0} ${read_.asked.asked === 1 ? "question" : "questions"} asked of the agents.` : "";
      setNotice(read_.error ? `#agent-files could not be read: ${read_.error}` : read_.skipped === "off" ? "Agents are off or paused, so #agent-files waits." : `Read ${read_.messages ?? 0} new ${read_.messages === 1 ? "message" : "messages"}; ${read_.added ?? 0} added to Knowledge.${asked}`);
      await read();
    } catch (requestError) { setError(errorText(requestError, "#agent-files could not be read")); } finally { setChecking(false); }
  };

  const facts: KeyValueItem[] = state.connected ? [
    { id: "site", label: "Zulip", mono: true, value: state.site ? <a href={state.site} target="_blank" rel="noreferrer">{state.site.replace(/^https:\/\//, "")}</a> : "unknown", hint: state.realm ? `organization ${state.realm}` : undefined },
    { id: "bot", label: "Bot", mono: true, value: state.botEmail ?? "unknown", hint: state.connectedAt ? `connected ${relativeTime(state.connectedAt, now) ?? ""}` : undefined },
    state.lastError
      ? { id: "last", label: "Last post", status: "danger", value: state.lastError.message, hint: relativeTime(state.lastError.at, now) ?? undefined }
      : { id: "last", label: "Last post", status: state.lastPost ? "good" : undefined, value: state.lastPost ? `#${state.lastPost.channel} › ${state.lastPost.topic}` : "Nothing posted yet", hint: state.lastPost ? relativeTime(state.lastPost.at, now) ?? undefined : undefined },
    { id: "files", label: "#" + state.channels.files, status: state.files.lastError ? "warning" : undefined, value: state.files.lastError ?? (state.files.lastIngest ? `Added “${state.files.lastIngest.title}”` : "Nothing added yet"), hint: state.files.lastPollAt ? `read ${relativeTime(state.files.lastPollAt, now) ?? ""}` : "read every few minutes while Agents run" },
    { id: "posts", label: "Posts", mono: true, value: `${state.counts.sent ?? 0} sent · ${state.counts.queued ?? 0} waiting · ${state.counts.failed ?? 0} failed` },
  ] : [];

  const postColumns: Array<TableColumn<ChatPost>> = [
    { id: "post", header: "Post", cell: (post) => <span className="agents-name"><span className="agents-model__title">{post.direct ? "a direct message" : `#${post.channel} › ${post.topic}`}<Tag>{post.kind}</Tag></span><span className="agents-name__purpose">{post.error ?? post.preview}</span></span> },
    { id: "state", header: "State", className: "agents-actions-cell", cell: (post) => <span className="agents-last"><StatusChip status={stateTone[post.state]}>{post.state}</StatusChip><span className="agents-dim">{relativeTime(post.sentAt ?? post.createdAt, now) ?? ""}</span></span> },
  ];

  const actions = owner ? (
    <>
      {state.connected && <Button busy={checking} onClick={() => void check()}>Check Zulip now</Button>}
      {state.app?.installed && mayStart(role, "agents.zulip.connect") && <Button variant={state.connected ? "secondary" : "primary"} risk={riskOf("agents.zulip.connect")} disabled={!state.app.running} onClick={connect}>{state.connected ? "Connect again" : "Connect the agents"}</Button>}
      {state.connected && mayStart(role, "agents.zulip.disconnect") && <Button variant="ghost" risk={riskOf("agents.zulip.disconnect")} onClick={disconnect}>Disconnect</Button>}
    </>
  ) : undefined;

  return (
    <Panel className="agents-zulip" title="Team chat" count={{ status: shown.status, label: shown.label }} meta={state.connected ? <>Zulip · <b>{state.counts.sent ?? 0}</b> posted</> : "Zulip"} actions={actions} padded>
      <div className="agents-zulip__body">
        {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
        {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}
        {!state.app?.installed && !state.connected && (
          <p className="agents-quiet">Zulip is the agents' team chat: they post what they find, their traces and what they learn there, and you drop files there for them. Install it from the <a href="?view=catalog&amp;app=zulip">App catalog</a>; it is reached through Tailscale only. Then create your organization from its sheet, and connect here.</p>
        )}
        {state.app?.installed && !state.connected && (
          <p className="agents-quiet">{state.app.running ? "Zulip is installed. Create your organization from its sheet in the App catalog first, then connect: BoxPilot makes the agents' bot and channels in it with Zulip's own tools." : "Zulip is installed but not running; start it from the App catalog, then connect."}</p>
        )}
        {state.connected && !state.active && <Notice tone="info" title="Waiting while Agents are off or paused">Posts wait in the outbox and files wait in Zulip until Agents run again.</Notice>}
        {state.notPrivate.length > 0 && <Notice tone="warning" title="Not every channel is private">{state.notPrivate.map((name) => `#${name}`).join(", ")} {state.notPrivate.length === 1 ? "was" : "were"} already there and public: anyone in the organization can read what agents post there. Make {state.notPrivate.length === 1 ? "it" : "them"} private in Zulip's channel settings.</Notice>}
        {state.connected && <KeyValue layout="rows" items={facts} />}
        <ul className="agents-zulip__channels" aria-label="Channels">
          {Object.entries(state.channels).map(([kind, name]) => (
            <li key={kind} className="agents-zulip__channel"><code>#{name}</code><span className="agents-dim">{channelWords[kind] ?? ""}</span></li>
          ))}
        </ul>
        <p className="agents-dim">Every agent posts here unless its Build tab turns an output off. BoxPilot posts from each run's outcome, redacted; the model never posts, and nothing is approved in chat.</p>
        {owner && state.connected && state.asking && <AskingInZulip key={JSON.stringify(state.asking.people)} asking={state.asking} agents={agents} csrfToken={csrfToken} now={now} onSaved={setState} />}
        {owner && state.recent.length > 0 && <Table caption="The last posts" columns={postColumns} rows={state.recent} rowKey={(post) => post.id} />}
      </div>
    </Panel>
  );
}
