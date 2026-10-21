/**
 * Findings at work (M44, ADR-012), in the web process: which findings a run is offered, by words
 * before it plans and by meaning once the runner has embedded the request (M47.3), the one that
 * answers a supervisor's subtask, and what a finished run leaves for the other agents. What a
 * finding is, and its words, are findings.mjs's. Part of the agents service (service.mjs), which
 * hands it what it uses.
 */
import { detectInjection, sanitizeUntrusted, wrapFinding } from "../../packages/harness/src/index.mjs";
import { ageWords, compactFinding, findingAnswers, findingFreshMs, findingKind, findingReaderKinds, findingScore, wantsFresh } from "./findings.mjs";
import { cosine, readVector } from "./memory.mjs";
import { roleAtLeast } from "./tool-catalog.mjs";

/**
 * @param {{
 *   store: any, state: any, limits: Record<string, number>, now: () => Date,
 *   audit: (type: string, entry: object) => void, redact: (text: string) => string,
 *   clip: (text: unknown, max: number) => string, emit: (runId: string, event: string, data: any) => void,
 *   cloudRuns: Map<string, any>, heldRun: (runId: string, lease: string) => any,
 *   flagInjection: (runId: string, details?: { hop?: number | null, detail?: string | null, from?: string | null }) => any,
 *   makerOf: (agent: any) => any,
 *   sharingFor: (agent: any, spec?: any) => { shareFindings: boolean, useFindings: boolean },
 *   withVectors: (items: any[], model: string) => any[], embedModelName: () => string,
 *   rememberExample: (run: any, signal: string) => any,
 * }} deps
 */
export function createAgentFindings({ store, state, limits, now, audit, redact, clip, emit, cloudRuns, heldRun, flagInjection, makerOf, sharingFor, withVectors, embedModelName, rememberExample }) {
  /**
   * Findings a run reading as `readRole` may use: fresh, learned by a run that read no more than it
   * may, from an agent that still exists and still shares. One agent's (`agentId`) or every other
   * agent's (`exceptAgentId`).
   */
  /**
   * The findings a run may be offered: fresh, shared by their agent, within the run's role; and, for
   * a run on Claude (M48.3), only from agents that may themselves leave the box - an agent kept on
   * the local model wrote its findings on the promise that nothing of its leaves.
   */
  function usableFindings(readRole, { agentId = null, exceptAgentId = null, toCloud = false } = {}) {
    const at = now().getTime();
    const agents = new Map(store.listAgents().map((entry) => [entry.id, entry]));
    return store.listFindings({ agentId, exceptAgentId }).filter((finding) => {
      const writer = agents.get(finding.agentId);
      if (!writer || !sharingFor(writer).shareFindings || !finding.freshUntil || Date.parse(finding.freshUntil) <= at || !roleAtLeast(readRole, finding.readRole)) return false;
      return !toCloud || (writer.spec?.model?.route ?? "local") !== "local";
    });
  }

  /** Whether a run's calls go to Claude: claimed there, or made by an agent whose route is Claude. */
  const runGoesToCloud = (run, spec) => cloudRuns.has(run.id) || spec?.model?.route === "claude";

  const findingAge = (finding) => ageWords(now().getTime() - Date.parse(finding.updatedAt));

  /**
   * The findings a run is offered before it plans: the other agents' fresh ones it may read that
   * bear on what it was asked (or, for its routine work, on its job), at most three, each a step of
   * the trace numbered F1, F2 as the model sees it. None when the agent does not use findings, for
   * an evaluation (it measures the agent) or a supervisor's follow-up, or when the person asked for
   * a fresh check - which the trace says.
   */
  function offerFindings(run, spec, agent) {
    if (!sharingFor(agent, spec).useFindings || !findingReaderKinds.includes(run.kind)) return [];
    const root = run.rootRunId && run.rootRunId !== run.id ? store.getRun(run.rootRunId) : null;
    if (wantsFresh(run.question, root?.question)) {
      const step = store.addStep(run.id, { kind: "system", name: "findings", flags: { detail: "Asked for a fresh check, so the other agents' findings were not offered." } });
      if (step) emit(run.id, "step", step);
      return [];
    }
    const toCloud = runGoesToCloud(run, spec);
    const candidates = usableFindings(run.readRole, { exceptAgentId: agent.id, toCloud });
    if (toCloud) {
      const heldBack = usableFindings(run.readRole, { exceptAgentId: agent.id }).length - candidates.length;
      if (heldBack > 0) { const step = store.addStep(run.id, { kind: "system", name: "findings", flags: { detail: `${heldBack} ${heldBack === 1 ? "finding was" : "findings were"} not offered: ${heldBack === 1 ? "its agent stays" : "their agents stay"} on the local model, so nothing of theirs goes to Claude.` } }); if (step) emit(run.id, "step", step); }
    }
    if (!candidates.length) return [];
    const query = run.question ?? [run.trigger?.title, spec.job, spec.purpose, ...(spec.prompt?.steps ?? [])].filter(Boolean).join(" ");
    const ranked = candidates.map((finding) => ({ finding, ...findingScore(query, finding) })).filter((entry) => entry.shared > 0)
      .sort((a, b) => b.score - a.score || b.shared - a.shared || b.finding.updatedAt.localeCompare(a.finding.updatedAt))
      .slice(0, limits.findingsInPrompt);
    const names = new Map(store.listAgents().map((entry) => [entry.id, entry.name]));
    return ranked.map(({ finding }, position) => offerFinding(run, finding, position + 1, names, "words"));
  }

  /**
   * One finding offered to a run as F<index>: boxed as untrusted data, a step in the trace saying
   * which and how it was matched (`by`: "words" before the plan, "meaning" once the request was
   * embedded, M47.3), and this run flagged when the finding reads like an instruction.
   */
  function offerFinding(run, finding, index, names, by) {
    const from = names.get(finding.agentId) ?? "another agent";
    const cleaned = sanitizeUntrusted(`${finding.title}\n${finding.body}`, { maxChars: limits.findingPromptChars, redact });
    const doubts = { unsure: Boolean(finding.source?.unsure), partial: Boolean(finding.source?.partial) };
    // Another agent's words, read here: a flag of this run's own (hop 0) - but not a person's own
    // question, its title (sweep 3).
    const flagged = findingReadsLikeInstruction(finding, run);
    if (flagged) flagInjection(run.id, { hop: 0 });
    const step = store.addStep(run.id, {
      kind: "finding", name: from, output: cleaned.text,
      input: { id: `F${index}`, noteId: finding.id, agentId: finding.agentId, agent: from, writtenAt: finding.updatedAt, freshUntil: finding.freshUntil, by, ...doubts },
      flags: { finding: `F${index}`, ...(flagged ? { injection: true } : {}) },
    });
    if (step) emit(run.id, "step", step);
    return {
      id: `F${index}`, title: `${from}'s finding`, text: cleaned.text,
      wrapped: wrapFinding({ index, from, writtenAt: finding.updatedAt.slice(0, 16), age: findingAge(finding), text: cleaned.text, ...doubts, flags: { injection: flagged } }),
    };
  }

  /**
   * Findings by meaning (M47.3, M44's "Next"): once the runner has embedded the request, it asks for
   * the other agents' fresh findings nearest to it that words did not find before the plan, up to
   * the places left. The vector comes from the runner; the findings' own were made by the memory
   * index (a finding is a note). Nothing when the agent does not use findings, the run is not one
   * that reads them, or no finding is near enough.
   */
  function runnerFindings(runId, lease, { vector = null } = {}) {
    const run = heldRun(runId, lease);
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const spec = store.getVersion(run.agentId, run.version)?.spec ?? agent?.spec;
    if (!agent || !spec || !sharingFor(agent, spec).useFindings || !findingReaderKinds.includes(run.kind)) return { findings: [] };
    const queryVector = readVector(vector);
    if (!queryVector) return { findings: [] };
    const already = offeredFindings(run.id);
    const room = limits.findingsInPrompt - already.length;
    if (room <= 0) return { findings: [] };
    const root = run.rootRunId && run.rootRunId !== run.id ? store.getRun(run.rootRunId) : null;
    if (wantsFresh(run.question, root?.question)) return { findings: [] };
    const seen = new Set(store.listSteps(run.id).filter((step) => step.kind === "finding").map((step) => step.input?.noteId));
    const candidates = usableFindings(run.readRole, { exceptAgentId: agent.id, toCloud: runGoesToCloud(run, spec) }).filter((finding) => !seen.has(finding.id));
    if (!candidates.length) return { findings: [] };
    const items = withVectors(candidates.map((finding) => ({ key: `note:${finding.id}`, finding })), embedModelName()).filter((item) => item.vector);
    const query32 = Float32Array.from(queryVector);
    let length = 0;
    for (const value of query32) length += value * value;
    length = Math.sqrt(length) || 1;
    for (let index = 0; index < query32.length; index += 1) query32[index] /= length;
    const ranked = items.map((item) => ({ finding: item.finding, score: cosine(item.vector, query32) })).filter((entry) => entry.score !== null && entry.score >= limits.findingsMinCosine)
      .sort((a, b) => b.score - a.score || b.finding.updatedAt.localeCompare(a.finding.updatedAt)).slice(0, room);
    if (!ranked.length) return { findings: [] };
    const names = new Map(store.listAgents().map((entry) => [entry.id, entry.name]));
    const offered = ranked.map(({ finding }, position) => offerFinding(run, finding, already.length + position + 1, names, "meaning"));
    audit("agents.findings.by-meaning", { subjectId: run.agentId, details: { runId: run.id, offered: offered.length } });
    return { findings: offered };
  }

  /**
   * Whether a finding, read by `run`, reads like an instruction: what the agent found, always; its
   * title - what it was asked, a person's words, or its agent's job - unless those are the owner's or
   * this run's own person's (sweep 3: "Asked: Forget all the earlier messages..." flagged every run
   * of the person who asked it that was offered the finding). Another person's words still count.
   */
  function findingReadsLikeInstruction(finding, run) {
    if (detectInjection(finding.body).suspected) return true;
    if (!detectInjection(finding.title).suspected) return false;
    const asked = finding.source?.runId ? store.getRun(finding.source.runId) : null;
    const person = asked?.requestedBy ?? null;
    if (person) return !(person === run.requestedBy || state.findOwnerById?.(person)?.role === "owner");
    // A routine finding's title is its agent's job: its maker's words.
    return !(finding.finding === "routine" && makerOf(store.getAgent(finding.agentId))?.role === "owner");
  }

  /** The findings a run was offered, as the check holds claims to them: { id: "F1", title, text }. */
  const offeredFindings = (runId) => store.listSteps(runId).filter((step) => step.kind === "finding" && typeof step.flags?.finding === "string").map((step) => ({ id: step.flags.finding, title: `${step.name}'s finding`, text: step.output ?? "" }));

  /**
   * The specialist's own fresh finding that answers a subtask, when the supervisor uses findings,
   * the specialist shares them, and nobody asked for a fresh check: never one its check was unsure
   * of, or one cut short by a limit.
   */
  function findingForHandoff(run, spec, agent, target, task) {
    if (!sharingFor(agent, spec).useFindings || !sharingFor(target).shareFindings) return null;
    const root = run.rootRunId && run.rootRunId !== run.id ? store.getRun(run.rootRunId) : null;
    if (wantsFresh(task, run.question, root?.question)) return null;
    return usableFindings(run.readRole, { agentId: target.id })
      .filter((finding) => !finding.source?.unsure && !finding.source?.partial && findingAnswers(task, finding))
      .map((finding) => ({ finding, ...findingScore(task, finding) }))
      .sort((a, b) => b.score - a.score || b.finding.updatedAt.localeCompare(a.finding.updatedAt))[0]?.finding ?? null;
  }

  /**
   * What a finished run leaves for the other agents: its routine result, or an answer it checked
   * against its tools, as its finding of that kind - the last one replaced. Never one whose tools
   * read something that looked like an instruction; one its check was not sure of says so, and so
   * does one cut short by a limit.
   */
  function rememberFinding(agent, spec, run) {
    try {
      const kind = findingKind(run);
      if (!kind || !sharingFor(agent, spec).shareFindings) return null;
      if (run.state !== "completed" || !run.answer || run.flags?.clarify || run.flags?.injection) return null;
      // A supervisor that handed work on answers in its follow-up run: that answer is the finding.
      if (run.kind !== "continue" && store.listChildren(run.id).some((entry) => entry.kind === "handoff")) return null;
      const check = run.flags?.check ?? null;
      if (kind === "answer" && !check) return null;
      if (sanitizeUntrusted(run.answer).flags.injection) return null;
      // A follow-up answers what its own supervisor's run was asked: the person's question at the
      // root, the hand-off's task one level down (sweep 3: that one was filed under the root's question).
      const asked = run.kind === "continue" ? store.getRun(run.parentRunId) : null;
      const question = kind === "answer" ? clip(String(asked?.question ?? run.question ?? "").replace(/\s+/g, " ").trim(), 300) : null;
      const unsure = Boolean(check?.unsure);
      const partial = Boolean(run.flags?.limitReached);
      const statements = (count) => `${count} ${count === 1 ? "statement" : "statements"}`;
      const doubts = [
        unsure ? `Not sure of all of it: ${statements(check.mismatches)} did not match what ${spec.name}'s tools said.` : null,
        partial ? "It reached a limit before it finished, so this may be incomplete." : null,
      ].filter(Boolean).join(" ");
      // The question is its title (and in its source, for matching): the body is what it found.
      const body = `${doubts ? `${doubts}\n\n` : ""}${compactFinding(redact(run.answer), limits.findingChars - doubts.length - 2)}`;
      const title = clip(kind === "routine" ? spec.job : `Asked: ${question}`, 120);
      const finding = store.writeFinding(agent.id, {
        kind, title, body: clip(body, limits.findingChars), readRole: run.readRole,
        freshUntil: new Date(now().getTime() + findingFreshMs(spec, kind)).toISOString(),
        source: {
          agentId: agent.id, agentName: spec.name, runId: run.id, runKind: run.kind, finishedAt: run.finishedAt, kind, question,
          confidence: typeof run.flags?.confidence === "number" ? run.flags.confidence : null,
          checked: check?.checked ?? 0, mismatches: check?.mismatches ?? 0, unsure, partial,
        },
      });
      audit("agents.finding.shared", { actorId: run.requestedBy, subjectId: agent.id, details: { runId: run.id, kind, unsure, partial, readRole: run.readRole } });
      // An answer good enough to keep as a finding is a plan worth showing again (M46).
      if (kind === "answer" && !unsure) rememberExample(run, "finding-kept");
      return finding;
    } catch { return null; /* a finding is a help, never a reason for a run to fail */ }
  }

  return { usableFindings, findingAge, offerFindings, runnerFindings, findingReadsLikeInstruction, offeredFindings, findingForHandoff, rememberFinding };
}
