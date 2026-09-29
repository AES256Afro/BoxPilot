import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, KeyValue, Notice, Panel, StatusChip, Table, Tag, mayStart, riskOf, type KeyValueItem, type Status, type TableColumn } from "../../ui";
import { agentsApi, type ChatPost, type ZulipState } from "./api";
import { errorText } from "./format";

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

export function ZulipPanel({ csrfToken, role, now, onStart, refreshKey }: ZulipPanelProps) {
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
  const connect = () => onStart({
    operationId: "agents.zulip.connect",
    title: state.connected ? "Connect the agents to Zulip again" : "Connect the agents to Zulip",
    parameters: { boxpilotUrl: window.location.origin },
    preview: <span>Runs Zulip's own manage.py inside its container to make a bot for the agents, owned by your organization's owner, and four private channels only you and the bot are in: {Object.values(state.channels).map((name, index) => <span key={name}>{index ? ", " : ""}<code>#{name}</code></span>)}. The bot's key goes straight into BoxPilot's credential store and is never shown. Cards in chat link back to <code>{window.location.origin}</code>, where approvals happen. Safe to run again: it repairs what is missing.</span>,
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
      setNotice(read_.error ? `#agent-files could not be read: ${read_.error}` : read_.skipped === "off" ? "Agents are off or paused, so #agent-files waits." : `Read ${read_.messages ?? 0} new ${read_.messages === 1 ? "message" : "messages"}; ${read_.added ?? 0} added to Knowledge.`);
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
    { id: "post", header: "Post", cell: (post) => <span className="agents-name"><span className="agents-model__title">#{post.channel} › {post.topic}<Tag>{post.kind}</Tag></span><span className="agents-name__purpose">{post.error ?? post.preview}</span></span> },
    { id: "state", header: "State", className: "agents-actions-cell", cell: (post) => <span className="agents-last"><StatusChip status={stateTone[post.state]}>{post.state}</StatusChip><span className="agents-dim">{relativeTime(post.sentAt ?? post.createdAt, now) ?? ""}</span></span> },
  ];

  const actions = owner ? (
    <>
      {state.connected && <Button busy={checking} onClick={() => void check()}>Check #{state.channels.files} now</Button>}
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
        {owner && state.recent.length > 0 && <Table caption="The last posts" columns={postColumns} rows={state.recent} rowKey={(post) => post.id} />}
      </div>
    </Panel>
  );
}
