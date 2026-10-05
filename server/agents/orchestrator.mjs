/**
 * The orchestrator (M37): agents working together on one queue. A supervisor (the Server Keeper by
 * default) answers what it can and hands subtasks to specialists with agents.handoff. There is one
 * model and one capped runner, so nothing waits inside a run: a hand-off queues the specialist's
 * run as the same person, and when every specialist has answered, the supervisor gets a follow-up
 * run with their answers as tool output and writes the answer to the original request. The runs
 * form one tree under the first, which the console shows as one trace.
 *
 * Bounded: depth (the supervisor's maxDepth, at most 3), three hand-offs a run, and no loops - an
 * agent never receives a subtask from a chain it is already in.
 */

export const handoffLimits = Object.freeze({ perRun: 3, maxDepth: 3 });

/**
 * Whether `target` may take a subtask from `run` of `agent`; `{ problem }` if not. `chain` is the
 * agent ids from the root run down to this one.
 */
export function checkHandoff({ agent, spec, run, target, chain, handedSoFar }) {
  if (!spec.orchestration?.supervisor) return { problem: `${agent.name} is not a supervisor` };
  if (!target) return { problem: "There is no agent by that name" };
  if (target.id === agent.id) return { problem: "An agent cannot hand work to itself" };
  if (spec.orchestration.delegates !== "*" && !spec.orchestration.delegates.includes(target.id)) return { problem: `${agent.name} may not hand work to ${target.name}` };
  if (chain.includes(target.id)) return { problem: `${target.name} is already working on this request; that would go round in a loop` };
  const depth = (run.depth ?? 0) + 1;
  if (depth > Math.min(spec.orchestration.maxDepth ?? 2, handoffLimits.maxDepth)) return { problem: "The hand-offs would go deeper than this supervisor allows" };
  if (handedSoFar >= handoffLimits.perRun) return { problem: `A run hands off at most ${handoffLimits.perRun} subtasks` };
  if (target.paused) return { problem: `${target.name} is paused` };
  return { depth };
}

/** An agent's name as it is matched: any case, "the" before it or not, spaces as one (Zulip's names too, service.mjs). */
export const nameKey = (name) => String(name ?? "").trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ");

/** Words a message to the bot starts with anyway, and BoxPilot's own names: never an agent's (2026-10 sweep 5). */
const greetings = new Set(["hey", "hi", "hello", "ok", "okay", "thanks", "thank you", "please", "ask"]);
const boxpilotNames = new Set(["boxpilot", "boxpilot agents"]);

/**
 * Why `name` cannot be an agent's, or null. A message in Zulip that starts with an agent's name is
 * asked of that agent: one called "Hey" took every "Hey, ..." - the owner's included, run as the
 * owner under its maker's words - and one called "BoxPilot" would post as "BoxPilot: ...".
 */
export function reservedNameProblem(name) {
  const key = nameKey(name).replace(/[.!,:;]+$/, "");
  if (boxpilotNames.has(key)) return `"${String(name).trim()}" is BoxPilot's own name: its posts and warnings start with it. Give the agent another name.`;
  if (greetings.has(key)) return `"${String(name).trim()}" is a word people use to start a message, so their messages in the team chat would go to this agent. Give it another name.`;
  return null;
}

/**
 * The agents the model may mean by what it called one: the one with that id, else every one with
 * exactly that name (any case, "the" before it or not). Never a part of a name (2026-10 sweep 3:
 * "Pi-hole" was taken for whichever agent's name held it). More than one is not guessed between.
 */
export function agentsNamed(agents, name) {
  const wanted = nameKey(name);
  if (!wanted) return [];
  const byId = agents.find((agent) => agent.id === String(name ?? "").trim());
  return byId ? [byId] : agents.filter((agent) => nameKey(agent.name) === wanted);
}

/** Find an agent by what the model called it: its id, or its exact name; null for none, or two. */
export function findSpecialist(agents, name) {
  const found = agentsNamed(agents, name);
  return found.length === 1 ? found[0] : null;
}

/** The agents a supervisor may hand work to, as its prompt lists them. */
export function specialistsFor(spec, agents, selfId) {
  if (!spec.orchestration?.supervisor) return [];
  return agents
    .filter((agent) => agent.id !== selfId && !agent.paused && (spec.orchestration.delegates === "*" || spec.orchestration.delegates.includes(agent.id)))
    .slice(0, 8)
    .map((agent) => ({ id: agent.id, name: agent.name, job: agent.spec?.job ?? agent.spec?.purpose ?? "" }));
}

/** The chain of agents from the root run to `run`, following parents; bounded. */
export function chainOf(run, getRun) {
  const chain = [];
  let current = run;
  for (let hops = 0; current && hops < 8; hops += 1) {
    chain.unshift(current.agentId);
    current = current.parentRunId ? getRun(current.parentRunId) : null;
  }
  return chain;
}

/** A run's tree, for the console: each run with its depth and parent, in order. */
export function treeOf(runs, agentName) {
  return runs.map((run) => ({ id: run.id, parentRunId: run.parentRunId, depth: run.depth ?? 0, agentId: run.agentId, agentName: agentName(run.agentId), kind: run.kind, state: run.state, question: run.question, finishedAt: run.finishedAt }));
}
