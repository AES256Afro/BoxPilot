/**
 * The team chat (M38) as the agents service sees it, in the web process: the Zulip panel, "check
 * now", who may ask in Zulip, and a question or feedback from there turned into a run or a verdict
 * as the asker's account. The connection itself is chat.mjs's. Part of the agents service
 * (service.mjs), which hands it what it uses.
 */
import { ConnectorError } from "./connectors.mjs";
import { zulipSettingKey } from "./chat.mjs";
import { nameKey } from "./orchestrator.mjs";
import { roleAtLeast } from "./tool-catalog.mjs";
import { questionFrom } from "./zulip.mjs";

/**
 * @param {{
 *   state: any, store: any, helper: any, chat: any, audit: (type: string, entry: object) => void,
 *   refuse: (status: number, message: string, code?: string) => never,
 *   AgentError: typeof import("./service.mjs").AgentError,
 *   personOf: (caller: any) => { id: string, role: string },
 *   canAsk: (caller: any, agent: any) => boolean, agentPaused: (agent: any) => boolean,
 *   makerOf: (agent: any) => any,
 *   startRun: (caller: any, agentId: string, body?: object, options?: { trigger?: object }) => any,
 *   giveFeedback: (caller: any, runId: string, body?: { verdict?: string, note?: string | null, expect?: any }) => any,
 * }} deps
 */
export function createTeamChat({ state, store, helper, chat, audit, refuse, AgentError, personOf, canAsk, agentPaused, makerOf, startRun, giveFeedback }) {
  /** The Zulip panel: whether Zulip is installed and connected, its channels, and the last post or error. */
  async function zulipState(caller) {
    const person = personOf(caller);
    if (person.role === "viewer") refuse(403, "The team chat is the owner's and operators'", "forbidden");
    let app = null;
    if (helper) {
      const inspected = await helper.request("app.inspect", {}, { timeoutMs: 30_000 }).catch(() => null);
      const entry = inspected?.applications?.find((application) => application.id === "zulip") ?? null;
      app = inspected ? { installed: Boolean(entry?.installed), running: Boolean(entry?.container?.running), port: entry?.urls?.[0]?.host ?? null } : null;
    }
    const accounts = person.role === "owner" ? (state.listOwners?.() ?? []).map(({ id, username, role }) => ({ id, username, role })) : [];
    return chat.present(person, { app, accounts });
  }

  /** "Check now": #agent-files and what was asked of the bot (M40.5), without waiting for the tick. */
  async function zulipPollNow(caller) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner reads #agent-files now", "forbidden");
    if (!chat.connection()) refuse(409, "Zulip is not connected", "not_connected");
    const asked = await chat.pollAsks({ force: true }).catch((error) => ({ error: error.message }));
    const read = await chat.poll({ force: true });
    await chat.drain().catch(() => null);
    return { ...read, asked };
  }

  /**
   * Who in Zulip may ask the agents, as which BoxPilot account, and the agent asked by default
   * (M40.5): the owner's list, with their password like the other agents' settings.
   */
  async function setZulipPeople(caller, input = {}) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner says who may ask in Zulip", "forbidden");
    try {
      chat.setPeople(input, { actorId: person.id, accounts: state.listOwners?.() ?? [], agents: store.listAgents() });
    } catch (error) {
      if (error instanceof ConnectorError) refuse(400, error.message, "invalid_setting");
      throw error;
    }
    return zulipState(person);
  }

  /**
   * A question from Zulip (M40.5), from someone the owner mapped to a BoxPilot account: asked as that
   * account, exactly as the Test tab's Ask asks it - their role's tools, their rate limit, their
   * conversation - of the agent the message names, or the default one. The answer goes back to the
   * thread it was asked in; nothing is approved in chat. A refusal is said in the thread.
   */
  /**
   * Feedback from Zulip (M47.4): a reply of "+1", "-1", "right" or "wrong: ..." under an agent's
   * answer rates the run that answer came from, as the Test tab's thumbs do, by the account the
   * owner mapped the sender to. A thumbs up keeps the run as an example (M46); a thumbs down takes
   * one back. The reply says what was noted, or that there is no answer above to rate.
   */
  function feedbackFromChat({ message, person, where, rating }) {
    const account = state.findOwnerById?.(person.boxpilotId);
    if (!account || !["owner", "operator", "viewer"].includes(account.role)) return { reply: "Your BoxPilot account cannot rate answers any more. The owner can set you up again." };
    const post = store.latestAnsweredPost(where);
    const run = post?.runId ? store.getRun(post.runId) : null;
    if (!run) return { reply: "There is no agent's answer here to rate yet. Reply under one with +1 or -1, or wrong: what was expected." };
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    try {
      giveFeedback({ id: account.id, role: account.role }, run.id, { verdict: rating.verdict, note: rating.note });
    } catch (error) {
      if (error instanceof AgentError) return { reply: error.message };
      throw error;
    }
    audit("agents.feedback.chat", { actorId: account.id, subjectId: run.id, details: { verdict: rating.verdict, messageId: message.id } });
    const whose = agent?.name ?? "the agent";
    return {
      noted: true,
      reply: rating.verdict === "up"
        ? `Noted: a thumbs up for ${whose}'s answer. It is kept as an example its planner learns from.`
        : `Noted: a thumbs down for ${whose}'s answer${rating.note ? ` (${rating.note})` : ""}. It is no longer an example. Say what was expected on the Test tab to make it a golden question.`,
    };
  }

  function askFromChat({ message, person, where }) {
    const account = state.findOwnerById?.(person.boxpilotId);
    if (!account) return { refused: "Your BoxPilot account is gone; the owner can set you up again." };
    // Only an account that may sign in asks: a disabled one ("disabled") was taken for a viewer and
    // kept getting answers (2026-10 sweep 3).
    if (!["owner", "operator", "viewer"].includes(account.role)) return { refused: "Your BoxPilot account cannot ask agents any more. The owner can set you up again." };
    const caller = { id: account.id, role: account.role };
    const askable = store.listAgents().filter((agent) => canAsk(caller, agent) && !agentPaused(agent));
    const { text, agentName, exact } = questionFrom(message.content, { agents: askable.map((agent) => agent.name) });
    if (!text) return { refused: "Ask a question after the mention, like: Steve, which drives are connected?" };
    const chosen = state.getSetting?.(zulipSettingKey, null)?.defaultAgentId ?? null;
    // Two the name the message gives could mean: neither is guessed at, and the reply says whose each
    // is (2026-10 sweep 4: the first made was asked - an operator's, say, run as the owner under that
    // operator's words). Matched as questionFrom matches - any case, "the" before it or not (sweep 5:
    // an operator's "The Server Keeper" took the owner's questions to the owner's Server Keeper) -
    // and said by role, never by username: the thread may hold people who are not in BoxPilot (sweep 5).
    // Without a name, the owner's own agents, then the asker's, come first.
    const named = agentName ? askable.filter((entry) => nameKey(entry.name) === nameKey(agentName)) : [];
    const whose = (entry) => { const maker = makerOf(entry); return !maker ? "one whose maker has gone" : maker.id === account.id ? "one you made" : maker.role === "owner" ? "one made by the owner" : `one made by ${maker.role === "operator" ? "an operator" : "a viewer"}`; };
    if (named.length > 1) return { refused: `More than one agent is called ${agentName}: ${named.map(whose).join(", ")}. Ask the owner to give them different names, then ask again.` };
    const ownersFirst = (list) => list.find((entry) => makerOf(entry)?.role === "owner") ?? list.find((entry) => entry.createdBy === account.id) ?? list[0];
    const agent = agentName ? named[0]
      : askable.find((entry) => entry.id === chosen) ?? ownersFirst(askable.filter((entry) => entry.template === "server-keeper")) ?? ownersFirst(askable);
    if (!agent) return { refused: "None of BoxPilot's agents takes questions from you." };
    // An agent whose maker reads less than the asker runs as the asker, under its maker's words: only
    // when the message names it exactly, its full name and a colon - never "the", another case or
    // the start of a sentence that happens to match (sweep 5: an operator's agent called "Hey" took
    // the owner's "Hey, ..."). Otherwise the reply says whose it is and how to ask it.
    const maker = makerOf(agent);
    if (agentName && !exact && (!maker || !roleAtLeast(maker.role, account.role))) {
      return { refused: `The agent ${agent.name} was made by ${maker ? (maker.role === "operator" ? "an operator" : "a viewer") : "someone who has gone"}, and it would answer as you. To ask it, start with its full name and a colon - ${agent.name}: your question - or ask without a name.` };
    }
    try {
      const run = startRun(caller, agent.id, { kind: "ask", question: text }, { trigger: { title: "Asked in Zulip", chat: { ...where, messageId: message.id, kind: message.kind } } });
      return { run, agentName: agent.name };
    } catch (error) {
      if (error instanceof AgentError) return { refused: error.message };
      throw error;
    }
  }

  return { zulipState, zulipPollNow, setZulipPeople, feedbackFromChat, askFromChat };
}
