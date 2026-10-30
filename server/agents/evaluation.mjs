/**
 * Evaluation (M40), in the web process: each agent's golden questions, an evaluation asked as a
 * person or nightly in quiet hours within the budgets, each answer graded against this server's
 * facts as they were when it started (grade.mjs), the local model and Claude side by side (M45.7),
 * and accuracy over time with the drops worth flagging. Part of the agents service (service.mjs),
 * which hands it what it uses.
 */
import { randomUUID } from "node:crypto";
import { startOfLocalDay } from "./budget.mjs";
import { gradeFact } from "./grade.mjs";
import { builtInQuestions, evaluationFacts, templateQuestions } from "./templates.mjs";
import { appUpdatesOf, drivesOf, failedServicesOf, placementOf, stoppedAppsOf, unhealthyAppsOf } from "./tool-text.mjs";

/**
 * @param {{
 *   store: any, state: any, limits: Record<string, number>, now: () => Date,
 *   audit: (type: string, entry: object) => void,
 *   refuse: (status: number, message: string, code?: string) => never,
 *   finite: (value: unknown, max: number) => number,
 *   inTime: (read: () => any, ms: number, error: Error) => Promise<any>, wake: () => void, tools: any,
 *   inventory: any, helper: any, cloud: any, personOf: (caller: any) => { id: string, role: string },
 *   agentFor: (caller: any, id: string, options?: { edit?: boolean }) => any,
 *   ownActor: (caller: any, id: string | null) => string | null,
 *   canEdit: (caller: any, agent: any) => boolean, moduleSettings: () => any,
 *   modulePaused: (settings?: any) => boolean, agentPaused: (agent: any) => boolean,
 *   claudeAllowed: (spec: any, run: any) => { ok: boolean, reason?: string | null },
 *   queueCounts: () => { queued: number, [kind: string]: number },
 *   budgetOf: (agent: any, module?: any) => any, moduleBudget: () => any, embedModelName: () => string,
 *   rememberExample: (run: any, signal: string) => any,
 * }} deps
 */
export function createAgentEvaluation({ store, state, limits, now, audit, refuse, finite, inTime, wake, tools, inventory, helper, cloud, personOf, agentFor, ownActor, canEdit, moduleSettings, modulePaused, agentPaused, claudeAllowed, queueCounts, budgetOf, moduleBudget, embedModelName, rememberExample }) {
  // A nightly evaluation being started (its facts are read first): a tick meanwhile starts none
  // beside it. Only this is held to one at a time; the tick itself is not (2026-10 sweep 2).
  let nightlyStarting = false;
  // The night an agent's evaluation was last skipped for want of budget, so it is said once a night.
  const nightlySkipped = new Map();

  /**
   * The questions an agent is evaluated on (M40): the built-in ones its own tools can answer - which
   * drives, how full the root filesystem is, where Pi-hole runs, which apps are stopped, the OS and
   * its version - then the owner's own (or its template's, until the owner saves some). An owner's
   * question about the same fact takes the built-in one's place.
   */
  function evaluationSet(agent) {
    const custom = store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [];
    const covered = new Set(custom.map((question) => question.expect?.fact).filter(Boolean));
    const builtIn = builtInQuestions(agent.spec).filter((question) => !covered.has(question.expect.fact));
    return { builtIn, custom, all: [...builtIn, ...custom] };
  }

  function normalizeQuestions(list) {
    if (!Array.isArray(list) || list.length > limits.evalQuestions) refuse(400, `At most ${limits.evalQuestions} golden questions`, "invalid_questions");
    return list.map((entry, index) => {
      const question = typeof entry?.question === "string" ? entry.question.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
      if (!question || question.length > 300) refuse(400, `Question ${index + 1} needs words, under 300 characters`, "invalid_questions");
      const expect = entry.expect ?? {};
      if (expect.fact !== undefined) {
        if (!evaluationFacts.includes(expect.fact)) refuse(400, `Question ${index + 1}: the fact is one of ${evaluationFacts.join(", ")}`, "invalid_questions");
        return { id: typeof entry.id === "string" && /^[a-z0-9-]{1,40}$/.test(entry.id) ? entry.id : `q${index + 1}`, question, expect: { fact: expect.fact } };
      }
      const includes = Array.isArray(expect.includes) ? expect.includes.filter((text) => typeof text === "string" && text.trim()).map((text) => text.trim().slice(0, 80)).slice(0, 5) : [];
      if (!includes.length) refuse(400, `Question ${index + 1} needs an expected fact or words the answer must contain`, "invalid_questions");
      return { id: typeof entry.id === "string" && /^[a-z0-9-]{1,40}$/.test(entry.id) ? entry.id : `q${index + 1}`, question, expect: { includes } };
    });
  }

  function getEvaluation(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (person.role === "viewer") refuse(403, "Evaluations are for the owner and operators", "forbidden");
    const runs = store.listEvalRuns(agent.id, limits.evalHistory);
    const set = evaluationSet(agent);
    const history = historyOf(runs);
    const last = store.listEvalRuns(agent.id, 1)[0] ?? null;
    return {
      builtIn: set.builtIn,
      questions: set.custom,
      runs: runs.slice(0, 20).map((run) => ({ ...run, createdBy: ownActor(person, run.createdBy) })),
      canEdit: canEdit(person, agent),
      successCriteria: agent.spec.successCriteria ?? [],
      accuracy: accuracyOf(agent, runs),
      history,
      drop: accuracyDrop(history),
      people: peopleOf(agent),
      nightly: { quietHours: moduleSettings().quietHours, next: nightlyDue(agent, last) ? "tonight" : "tomorrow night", compare: moduleSettings().evaluation?.compareNightly === true },
      // M45.7: the routes side by side, newest first; and whether a comparison may be started now.
      comparisons: comparisonsOf(runs),
      canCompare: person.role === "owner" && claudeAllowed(agent.spec, { readRole: "owner" }).ok,
    };
  }

  /** One side of a comparison: how many it got right, how long each question took on average, what it cost. */
  function sideOf(evaluation) {
    if (!evaluation) return null;
    const graded = evaluation.results.filter((result) => !result.skipped && result.passed !== null);
    const timed = evaluation.results.filter((result) => Number.isFinite(result.seconds));
    return {
      evalId: evaluation.id, state: evaluation.state, model: evaluation.model, score: evaluation.score,
      right: graded.filter((result) => result.passed).length, questions: graded.length,
      seconds: timed.length ? Math.round((timed.reduce((sum, result) => sum + result.seconds, 0) / timed.length) * 10) / 10 : null,
      dollars: Math.round(evaluation.results.reduce((sum, result) => sum + (Number(result.costUsd) || 0), 0) * 10_000) / 10_000,
      // A Claude side whose questions ran locally (Claude could not take them) says so.
      ranLocally: evaluation.route === "claude" ? evaluation.results.filter((result) => result.route === "local").length : 0,
    };
  }

  /** The comparisons among an agent's evaluations: each pair, newest first, its local and Claude sides. */
  function comparisonsOf(runs) {
    const pairs = new Map();
    for (const evaluation of runs) {
      if (!evaluation.pairId) continue;
      const pair = pairs.get(evaluation.pairId) ?? { pairId: evaluation.pairId, at: evaluation.createdAt, nightly: !evaluation.createdBy, local: null, claude: null };
      pair[evaluation.route === "claude" ? "claude" : "local"] = sideOf(evaluation);
      pairs.set(evaluation.pairId, pair);
    }
    return [...pairs.values()].slice(0, 10);
  }

  /**
   * Each finished evaluation's score, oldest first: accuracy over time. `questions` are those graded,
   * as the score counts them, and `skipped` those that were not (sweep 4: "100% · 1/3" for one
   * right of one graded and two never asked).
   */
  function historyOf(runs) {
    return [...runs].reverse().filter((run) => run.state === "done" && run.score !== null).map((run) => ({
      id: run.id, at: run.finishedAt ?? run.createdAt, score: run.score, version: run.version, model: run.model, nightly: !run.createdBy,
      right: run.results.filter((result) => result.passed).length, questions: run.results.filter((result) => !result.skipped).length, skipped: run.results.filter((result) => result.skipped).length,
    }));
  }

  /**
   * A drop worth flagging: the latest score more than 20 points under the average of the five
   * before it, or more than 25 under the one before it - one question of five going wrong is not
   * yet a drop, two are - with the evaluations it is measured against.
   */
  function accuracyDrop(history) {
    if (history.length < 2) return null;
    const latest = history.at(-1);
    const before = history.slice(-6, -1);
    const average = before.reduce((sum, entry) => sum + entry.score, 0) / before.length;
    const previous = before.at(-1);
    if (latest.score < average - 0.2 - 1e-9 || latest.score < previous.score - 0.25 - 1e-9) {
      return { from: Math.round(average * 100) / 100, to: latest.score, previous: previous.score, at: latest.at, evalId: latest.id, version: latest.version, previousVersion: previous.version, model: latest.model, previousModel: previous.model };
    }
    return null;
  }

  /** People's verdicts on the agent's answers, by day, for the last month. */
  function peopleOf(agent) {
    const since = new Date(now().getTime() - 30 * 86_400_000).toISOString();
    const days = new Map();
    for (const feedback of store.listFeedback(agent.id).filter((entry) => entry.givenAt >= since)) {
      const day = feedback.givenAt.slice(0, 10);
      if (!days.has(day)) days.set(day, { day, up: 0, down: 0 });
      days.get(day)[feedback.verdict === "up" ? "up" : "down"] += 1;
    }
    return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  /**
   * Accuracy over time, per agent version and model: the golden questions' scores and the people's
   * thumbs, side by side, so an improvement or a regression shows against what changed.
   */
  function accuracyOf(agent, runs) {
    const groups = new Map();
    const group = (version, model) => {
      const key = `${version}|${model ?? ""}`;
      if (!groups.has(key)) groups.set(key, { version, model: model ?? null, evaluations: 0, score: null, up: 0, down: 0, since: null });
      return groups.get(key);
    };
    for (const run of [...runs].reverse().filter((entry) => entry.state === "done" && entry.score !== null)) {
      const entry = group(run.version, run.model);
      entry.score = entry.score === null ? run.score : Math.round(((entry.score * entry.evaluations + run.score) / (entry.evaluations + 1)) * 100) / 100;
      entry.evaluations += 1;
      entry.since ??= run.createdAt;
    }
    for (const feedback of store.listFeedback(agent.id)) {
      const entry = group(feedback.version, feedback.model);
      entry[feedback.verdict === "up" ? "up" : "down"] += 1;
      if (!entry.since || feedback.givenAt < entry.since) entry.since = feedback.givenAt;
    }
    return [...groups.values()].sort((a, b) => a.version - b.version || String(a.since).localeCompare(String(b.since)));
  }

  /**
   * @param {any} caller
   * @param {string} agentId
   * @param {{ questions?: unknown }} [body]
   */
  function setEvaluation(caller, agentId, { questions } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const normalized = normalizeQuestions(questions);
    store.setQuestions(agent.id, normalized, { updatedBy: person.id });
    audit("agents.evaluation.changed", { actorId: person.id, subjectId: agent.id, details: { questions: normalized.length } });
    return getEvaluation(person, agent.id);
  }

  /** The running app using the most processor, or null when none runs or the stats could not be read. */
  function busiestAppOf(usage) {
    if (!usage || usage.statsAvailable === false || !Array.isArray(usage.apps)) return null;
    const running = usage.apps.filter((app) => app?.running);
    if (!running.length) return null;
    return [...running].sort((a, b) => ((b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)) || ((b.memBytes ?? 0) - (a.memBytes ?? 0)))[0].id ?? null;
  }

  /** What a golden question's fact is on this server right now, read as `role` reads. */
  async function resolveFacts({ role }, { wanted = null } = {}) {
    // Each read within its time, or unknown: an inventory whose df or docker never answered held the
    // nightly evaluation, and with it every later tick, for good (2026-10 sweep 2).
    const read = (fn) => inTime(fn, limits.factsTimeoutMs, new Error("It did not answer in time")).catch(() => null);
    // Only the reads the questions' facts need (M48.5): nine reads, seven through the root helper,
    // ran for every evaluation whatever it asked.
    const want = (...facts) => !wanted || facts.some((fact) => wanted.has(fact));
    const when = (needed, fn) => (needed ? read(fn) : Promise.resolve(null));
    const [snapshot, apps, pihole, placed, services, firewall, protection, updates, usage, theyspy] = await Promise.all([
      when(want("hostname", "operatingSystem", "rootDiskPercent", "drives"), () => inventory?.inspect()),
      when(want("installedApps", "stoppedApps", "unhealthyApps", "appUpdates"), () => tools.readApps()),
      // An operator read (ADR-003); an evaluation is started by the owner or an operator anyway.
      when(want("piholePlacement", "piholeBlocking"), () => (helper && ["owner", "operator"].includes(role) ? helper.request("app.pihole.inspect", {}, { timeoutMs: 30_000 }) : null)),
      when(want("piholePlacement"), () => tools.whereRuns("pihole")),
      // The read services.status makes, open to every role.
      when(want("failedServices"), () => (helper ? helper.request("service.list", {}, { timeoutMs: 30_000 }) : null)),
      // M47: the read firewall.status makes, open to every role.
      when(want("firewallEnabled"), () => (helper ? helper.request("firewall.inspect", {}, { timeoutMs: 30_000 }) : null)),
      // M47.6: the reads backups.coverage and updates.status make, open to every role.
      when(want("neverBackedUp"), () => (helper ? helper.request("app.backup.protection", {}, { timeoutMs: 30_000 }) : null)),
      when(want("rebootRequired"), () => (helper ? helper.request("apt.upgradable.inspect", {}, { timeoutMs: 30_000 }) : null)),
      // M47.9: the read apps.usage makes, open to every role.
      when(want("busiestApp"), () => (helper ? helper.request("system.performance.inspect", {}, { timeoutMs: 30_000 }) : null)),
      // The read theyspy.status makes, an operator read as Pi-hole's.
      when(want("theyspyContacts", "theyspyUnblocked"), () => (helper && ["owner", "operator"].includes(role) ? helper.request("app.theyspy.inspect", {}, { timeoutMs: 45_000 }) : null)),
    ]);
    const applications = Array.isArray(apps?.applications) ? apps.applications : null;
    return {
      hostname: snapshot?.host?.hostname ?? null,
      operatingSystem: snapshot?.host?.operatingSystem ?? null,
      installedApps: applications ? applications.filter((entry) => entry?.installed).length : null,
      rootDiskPercent: Number.isFinite(snapshot?.storage?.root?.usedPercent) ? snapshot.storage.root.usedPercent : null,
      // Where where.runs finds it, the tool an agent asks; Pi-hole's own read when that could not look.
      piholePlacement: placed && !(placed.unread && !placed.places.length) ? placementOf(placed.places) : pihole?.placement ?? null,
      piholeBlocking: pihole?.available ? (pihole.blocking === true ? "on" : pihole.blocking === false ? "off" : null) : null,
      theyspyContacts: theyspy?.available ? String(theyspy.evidence.contacted) : null,
      theyspyUnblocked: theyspy?.available ? String(theyspy.lookups.notFullyBlocked) : null,
      drives: snapshot ? drivesOf(snapshot) : null,
      stoppedApps: stoppedAppsOf(applications),
      // M43: what the Environment Scout, the App Doctor and the Update Planner report.
      unhealthyApps: unhealthyAppsOf(applications),
      appUpdates: appUpdatesOf(applications),
      failedServices: failedServicesOf(services?.units ?? null),
      // M47: on, off, or absent when ufw is not installed.
      firewallEnabled: firewall ? (firewall.installed === false ? "absent" : firewall.enabled === true ? "on" : firewall.enabled === false ? "off" : null) : null,
      // M47.6: the apps that hold data worth keeping with no backup at all (unknown when the backup
      // folder could not be read: zero would call every app unprotected), and whether apt wants a reboot.
      neverBackedUp: protection?.available && Array.isArray(protection.apps) ? protection.apps.filter((app) => app.protectable && !(app.backups > 0)).map((app) => app.id) : null,
      rebootRequired: updates ? (updates.rebootRequired === true ? "yes" : updates.rebootRequired === false ? "no" : null) : null,
      // M47.9: the running app with the largest share of a core, as apps.usage lists it first; unknown when docker stats did not answer.
      busiestApp: busiestAppOf(usage),
    };
  }

  async function runEvaluation(caller, agentId, { compare = false } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    // M45.7: every question on the local model and on Claude, side by side. Claude costs money, so
    // it is the owner's to start, and only while Claude may take the owner's questions.
    if (compare === true) {
      if (person.role !== "owner") refuse(403, "Comparing with Claude spends money, so the owner starts it", "forbidden");
      const allowed = claudeAllowed(agent.spec, { readRole: "owner" });
      if (!allowed.ok) refuse(409, `${allowed.reason}, so there is nothing to compare with`, "claude_unavailable");
    }
    const settings = moduleSettings();
    if (!settings.enabled) refuse(409, "Agents are off. Turn them on to run an evaluation.", "agents_off");
    if (modulePaused(settings) || agentPaused(agent)) refuse(409, "Resume the agent to run an evaluation", "agent_paused");
    const recent = store.listEvalRuns(agent.id, 1)[0];
    if (recent && (recent.state === "running" || now().getTime() - Date.parse(recent.createdAt) < limits.evalEveryMs)) refuse(429, "An evaluation ran in the last hour. Try again later.", "evaluation_recent");
    const questions = evaluationSet(agent).all;
    if (!questions.length) refuse(400, "Give this agent some golden questions first", "no_questions");
    if (queueCounts().queued + questions.length * (compare === true ? 2 : 1) > limits.queueMax) refuse(503, "Agents have too much waiting right now. Try again later.", "agents_backlog");
    if (compare === true) {
      const pairId = randomUUID();
      const local = await startEvaluation(agent, questions, { person, route: "local", pairId });
      await startEvaluation(agent, questions, { person, route: "claude", pairId });
      audit("agents.evaluation.started", { actorId: person.id, subjectId: agent.id, details: { questions: questions.length, compare: true } });
      return local;
    }
    const evaluation = await startEvaluation(agent, questions, { person });
    audit("agents.evaluation.started", { actorId: person.id, subjectId: agent.id, details: { questions: questions.length } });
    return evaluation;
  }

  /**
   * An evaluation: every question asked as its own run and graded when it finishes. A person's is
   * asked as them, now; the nightly one as the person who made the agent, in quiet hours, as
   * background work nobody waits on.
   */
  async function startEvaluation(agent, questions, { person = null, reader = null, route = null, pairId = null, notAsked = [] } = {}) {
    const asWho = person ?? reader;
    const facts = await resolveFacts(asWho, { wanted: new Set(questions.map((question) => question.expect?.fact).filter(Boolean)) });
    const results = [
      ...questions.map((question) => ({ questionId: question.id, question: question.question, expected: question.expect.fact ? { fact: question.expect.fact, value: facts[question.expect.fact] ?? null } : { includes: question.expect.includes }, runId: null, passed: null, found: null })),
      // M48.6: the questions tonight's model time does not hold, said so and left out of the score.
      ...notAsked.map((question) => ({ questionId: question.id, question: question.question, expected: question.expect.fact ? { fact: question.expect.fact, value: null } : { includes: question.expect.includes }, runId: null, passed: null, skipped: true, found: `Not asked tonight: the night's model time holds ${questions.length} of ${questions.length + notAsked.length} questions` })),
    ];
    const model = route === "claude" ? cloud?.settings().model ?? "claude" : embedModelName();
    const evaluation = store.createEvalRun({ agentId: agent.id, version: agent.version, results, createdBy: person?.id ?? null, model, route, pairId });
    for (const result of results.filter((entry) => !entry.skipped)) {
      const run = store.enqueueRun({
        agentId: agent.id, version: agent.version, kind: "eval", question: result.question, requestedBy: person?.id ?? null, readRole: asWho.role, readAs: asWho.id,
        trigger: { ...(person ? {} : { title: "Nightly evaluation", quietHours: true }), ...(route ? { route } : {}) },
        evalInfo: { evalId: evaluation.id, questionId: result.questionId, expected: result.expected },
      });
      result.runId = run.id;
    }
    store.setEvalResults(evaluation.id, results);
    wake();
    return store.getEvalRun(evaluation.id);
  }

  /** Whether an agent's nightly evaluation is due: none yet, or the last one began a day ago or more. */
  const nightlyDue = (agent, last) => !last || (last.state !== "running" && now().getTime() - Date.parse(last.createdAt) >= limits.nightlyEvalEveryMs);

  /** The model time the nightly evaluation leaves for people: half of the agent's day, within every agent's day. */
  const nightlyKeep = (agent) => Math.min(agent.spec.budget.modelSecondsPerDay * 1000, moduleBudget().modelSecondsPerDay * 1000) / 2;

  /** What one evaluation question takes this agent here (M48.6): the median of its recent completed ones, never below the estimate. */
  function evalQuestionMs(agent) {
    const floor = limits.evalSecondsPerQuestion * 1000;
    const since = now().getTime() - 14 * 86_400_000;
    const taken = store.listRuns({ agentId: agent.id, limit: 60 })
      .filter((run) => run.kind === "eval" && run.state === "completed" && run.startedAt && Date.parse(run.startedAt) >= since && Number.isFinite(run.usage?.modelMs) && run.usage.modelMs > 0)
      .map((run) => run.usage.modelMs).sort((a, b) => a - b);
    if (taken.length < 3) return floor;
    return Math.max(floor, taken[Math.floor(taken.length / 2)]);
  }

  /**
   * What one of the nightly evaluation's runs may use: what the agent has left today above the half
   * kept for people, and what every agent together has left above theirs. The half was only
   * reckoned when the questions were queued, so one run could use the agent's whole day (2026-10
   * sweep 2).
   */
  function nightlyModelMs(agent) {
    const own = budgetOf(agent);
    const all = moduleBudget();
    return Math.max(0, Math.min(own.modelMsLeft - nightlyKeep(agent), all.modelMsLeft - all.modelSecondsPerDay * 500));
  }

  /**
   * The nightly evaluation (M40), from the service's tick in quiet hours: one agent at a time, each
   * at most once a day, as the person who made it, only when its own budget and every agent's
   * together have room for its questions and still keep half of the day's model time for people.
   * Its questions take none of the agent's own runs (usedToday), but every agent's runs together
   * count them, so half of those are kept for people too (2026-10 sweep).
   */
  async function queueNightlyEvaluation() {
    // One at a time: two ticks could each find no evaluation queued while the first read its facts,
    // and both start one (2026-10 sweep). A tick meanwhile goes on without it, rather than waiting.
    if (nightlyStarting) return null;
    nightlyStarting = true;
    try { return await startNightlyEvaluation(); } finally { nightlyStarting = false; }
  }

  async function startNightlyEvaluation() {
    const settings = moduleSettings();
    if (!settings.enabled || modulePaused(settings) || settings.killedAt) return null;
    if (store.activeRuns().some((run) => run.kind === "eval")) return null;
    for (const agent of store.listAgents()) {
      if (agentPaused(agent)) continue;
      if (!nightlyDue(agent, store.listEvalRuns(agent.id, 1)[0] ?? null)) continue;
      const questions = evaluationSet(agent).all;
      if (!questions.length) continue;
      const creator = agent.createdBy ? state.findOwnerById?.(agent.createdBy) : null;
      if (!["owner", "operator"].includes(creator?.role)) continue;
      // What a question takes this agent on this server (M48.6): the median of its recent evaluation
      // runs, never less than the estimate; the owner's Keeper took 135 s where 120 was assumed.
      const perQuestionMs = evalQuestionMs(agent);
      const own = budgetOf(agent);
      const all = moduleBudget();
      // How many questions tonight holds, above the half kept for people and within every agent's share.
      const fit = Math.min(
        Math.floor((own.modelMsLeft - nightlyKeep(agent)) / perQuestionMs),
        Math.floor((all.modelMsLeft - all.modelSecondsPerDay * 500) / perQuestionMs),
        Math.floor(all.runsPerDay - all.runsUsed - all.runsPerDay / 2),
      );
      const needed = questions.length * perQuestionMs;
      if (own.refusal || fit < 1) {
        // Said once a night, not every minute of quiet hours.
        const night = startOfLocalDay(now()).toISOString();
        if (nightlySkipped.get(agent.id) !== night) { nightlySkipped.set(agent.id, night); audit("agents.evaluation.skipped", { subjectId: agent.id, details: { reason: "budget", questions: questions.length } }); }
        continue;
      }
      // M45.7: both routes, when the owner asked for it and Claude may take the maker's questions now.
      const compare = settings.evaluation?.compareNightly === true && claudeAllowed(agent.spec, { readRole: creator.role }).ok;
      // Only what fits is asked (M48.6): the rest are marked not asked tonight, instead of queued to be refused one by one.
      const asked = fit < questions.length && needed > 0 ? questions.slice(0, fit) : questions;
      const notAsked = questions.slice(asked.length);
      if (queueCounts().queued + asked.length * (compare ? 2 : 1) > limits.queueMax) return null;
      const reader = { id: creator.id, role: creator.role };
      if (compare) {
        const pairId = randomUUID();
        const evaluation = await startEvaluation(agent, asked, { reader, route: "local", pairId, notAsked });
        await startEvaluation(agent, asked, { reader, route: "claude", pairId, notAsked });
        audit("agents.evaluation.started", { subjectId: agent.id, details: { questions: asked.length, notAsked: notAsked.length, nightly: true, compare: true } });
        return evaluation;
      }
      const evaluation = await startEvaluation(agent, asked, { reader, notAsked });
      audit("agents.evaluation.started", { subjectId: agent.id, details: { questions: asked.length, notAsked: notAsked.length, nightly: true } });
      return evaluation;
    }
    return null;
  }

  async function gradeEvalRun(run) {
    const expected = run.eval.expected ?? {};
    const answer = String(run.answer ?? "");
    let passed = false; let found = null; let skipped = false;
    // A nightly question cut short for want of model time says nothing of the agent's answers: not
    // graded, and left out of the score (sweep 3), as one refused for it at hand-out is.
    if (!run.requestedBy && run.state === "degraded" && run.flags?.degraded === "budget") { passed = null; skipped = true; found = "Not graded: the night's model time ran out before it finished"; }
    else if (run.state !== "completed") { passed = false; found = `The run ended ${run.state}`; }
    else if (expected.includes) {
      const missing = expected.includes.filter((text) => !answer.toLowerCase().includes(text.toLowerCase()));
      passed = missing.length === 0; found = passed ? "Every expected word is there" : `Missing: ${missing.join(", ")}`;
    } else if (expected.fact && (expected.value === null || expected.value === undefined)) {
      // M48.4: a fact this server could not read says nothing of the answer; left out of the score, not counted wrong.
      passed = null; skipped = true; found = "Not graded: the fact could not be read on this server when the evaluation started";
    } else if (expected.fact) {
      ({ passed, found } = gradeFact(expected.fact, expected.value, answer));
    }
    // M45.7: how long it took and what it cost, for the routes side by side.
    const measured = { seconds: Math.round(finite(run.usage?.wallMs, 86_400_000) / 100) / 10, costUsd: Math.round(finite(run.usage?.costUsd, 1_000) * 1_000_000) / 1_000_000, route: run.usage?.route ? "claude" : "local" };
    const graded = store.gradeEval(run.eval.evalId, run.eval.questionId, { passed, found, ...measured, ...(skipped ? { skipped } : {}) });
    // A question answered right is a plan worth showing again (M46).
    if (passed === true) rememberExample(run, "eval-passed");
    // The last answer is in: a drop against the evaluations before it is flagged (M40).
    if (graded?.state === "done") {
      const drop = accuracyDrop(historyOf(store.listEvalRuns(run.agentId, limits.evalHistory)));
      audit("agents.evaluation.finished", { subjectId: run.agentId, details: { evalId: graded.id, score: graded.score, questions: graded.results.length, skipped: graded.results.filter((result) => result.skipped).length, nightly: !graded.createdBy, dropped: Boolean(drop && drop.evalId === graded.id) } });
    }
  }

  return { normalizeQuestions, getEvaluation, setEvaluation, runEvaluation, historyOf, accuracyDrop, nightlyModelMs, queueNightlyEvaluation, gradeEvalRun };
}
