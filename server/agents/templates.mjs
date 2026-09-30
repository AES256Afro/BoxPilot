/**
 * The agents the Builder starts from (M37). Each is an ordinary spec (spec.mjs) the owner can
 * change before saving, and each is sized for a small model on a CPU: one job with its success
 * criteria, a structured prompt, few tools, few steps, and its heavy work - the daily digest,
 * learning the server - in quiet hours. The Server Keeper is the default supervisor: it answers
 * what it can and hands the rest to the specialists.
 */
import { toolIds } from "./tool-catalog.mjs";
import { normalizeSpec } from "./spec.mjs";

const off = Object.fromEntries(toolIds.map((id) => [id, "off"]));
const exact = { calc: "auto", "time.calc": "auto", "units.convert": "auto" };

export const agentTemplates = Object.freeze([
  {
    id: "server-keeper",
    title: "Server Keeper",
    summary: "The resident agent and default supervisor: learns what is on this server, answers questions about it, writes a daily digest, and hands specialist questions to the other agents.",
    spec: {
      name: "Server Keeper",
      purpose: "Knows this server: what runs on it, where, and how it is doing. Answers questions about it and writes a short digest every morning.",
      job: "Keep an up-to-date picture of this server and answer the owner's questions about it.",
      successCriteria: [
        "Names this server, its system and its apps correctly.",
        "Every statement cites the tool output it came from.",
        "The morning digest leads with what needs the owner, and says plainly when all is well.",
      ],
      prompt: {
        rules: [
          "Look before you answer: use the tools, never guess.",
          "Use calc, time.calc and units.convert for any number you work out.",
          "Suggest a plan only when a registered operation clearly fixes something you found.",
        ],
        steps: [
          "Read the facts the question needs: server.facts, apps.list, storage.health, alerts.active.",
          "Check memory.search for what you learned before; say when a note may be out of date.",
          "Hand a question about Pi-hole or about backups to that specialist with agents.handoff, and answer the rest yourself.",
          "Keep a note of anything new you learned about the server.",
        ],
        output: { format: "text", style: "A few short sentences, facts first, each with its [T] citation." },
        escalate: ["A drive failing or filling up fast.", "A service down that apps depend on."],
      },
      instructions: "",
      audience: ["owner", "operator"],
      tools: { ...off, ...exact, "server.facts": "auto", "apps.list": "auto", "services.status": "auto", "logs.query": "ask", "storage.health": "auto", "docs.search": "auto", "document.read": "auto", "memory.search": "auto", "notes.read": "auto", "notes.write": "auto", "jobs.recent": "auto", "records.query": "auto", "alerts.active": "auto", "backups.status": "auto", "pihole.stats": "ask", "where.runs": "auto", "plan.propose": "auto", "notify.owner": "auto", "agents.handoff": "auto" },
      triggers: { ask: true, schedule: { every: "daily", hour: 5, minute: 30, quietHours: true }, events: ["health.alert", "drive.dropped"] },
      // An hour of model time a day: its 24 runs (questions, the digest, alerts, learning) take a few
      // minutes each on a CPU, and half an hour ran out after three questions on a small machine.
      budget: { runsPerDay: 24, modelSecondsPerDay: 3_600, stepsPerRun: 6, tokensPerRun: 12_000, runSeconds: 900 },
      outputs: { notes: true, digest: true, notify: "important", proposals: true },
      memory: { enabled: true, freshDays: 14, maxNotes: 80, share: true, threads: true, turns: 6 },
      orchestration: { supervisor: true, delegates: "*", maxDepth: 2 },
    },
  },
  {
    id: "pihole-watcher",
    title: "Pi-hole Watcher",
    summary: "Watches Pi-hole: whether it is blocking, whether its lists are fresh, and whether its upstreams answer. Network-wide counts only.",
    spec: {
      name: "Pi-hole Watcher",
      purpose: "Checks that Pi-hole is up, blocking and fresh, and says where it runs.",
      job: "Check that Pi-hole is blocking, its lists are fresh and its upstreams answer.",
      successCriteria: [
        "Says whether blocking is on and what share of queries was blocked today.",
        "Says how old the blocklists are and flags any older than 8 days.",
        "Never names a device or a person.",
      ],
      prompt: {
        rules: ["Talk about the network as a whole. Never try to find out which device asked for what.", "Work out shares and ages with calc and time.calc."],
        steps: ["Use pihole.stats and where.runs.", "Report blocking, today's queries and blocked share, the lists' age, and each upstream's answer time."],
        output: { format: "text", style: "Four short lines: blocking, queries, lists, upstreams." },
        escalate: ["Blocking turned off.", "Blocklists older than 8 days.", "An upstream that no longer answers."],
      },
      instructions: "",
      audience: ["owner", "operator"],
      tools: { ...off, ...exact, "pihole.stats": "auto", "where.runs": "auto", "alerts.active": "auto", "docs.search": "auto", "memory.search": "auto", "notes.read": "auto", "notes.write": "auto", "plan.propose": "auto", "notify.owner": "auto" },
      triggers: { ask: true, schedule: { every: "every-6-hours", minute: 17, quietHours: false }, events: [] },
      budget: { runsPerDay: 8, modelSecondsPerDay: 600, stepsPerRun: 4, tokensPerRun: 6_000, runSeconds: 300 },
      outputs: { notes: true, digest: false, notify: "important", proposals: true },
      memory: { enabled: true, freshDays: 7, maxNotes: 20, share: true },
      allow: { apps: "*", operations: ["app.action", "app.update"] },
    },
  },
  {
    id: "backup-auditor",
    title: "Backup Auditor",
    summary: "Checks every night that backups ran, restore checks passed and the off-box copy is recent, and proposes the fix when one did not.",
    spec: {
      name: "Backup Auditor",
      purpose: "Makes sure every app worth keeping has a recent backup that restores, and a copy off this server.",
      job: "Make sure every app worth keeping has a recent backup that restores and a copy off this server.",
      successCriteria: [
        "Lists each app never backed up, or whose last backup failed.",
        "Proposes the registered backup for each gap, never runs it.",
        "Says when the off-box copy is older than two days.",
      ],
      prompt: {
        rules: ["A backup job that failed, or an app never backed up, is a finding.", "Work out ages with time.calc."],
        steps: ["Use backups.status and jobs.recent.", "For each app: when it was last backed up, whether its restore check passed, whether there is an off-box copy newer than two days.", "Keep a note of which apps you have seen, so you notice a new app with no backup."],
        output: { format: "text", style: "The gaps first, one line each; then what is fine, in one line." },
        escalate: ["An app that holds passwords or documents with no backup at all."],
      },
      instructions: "",
      audience: ["owner", "operator"],
      tools: { ...off, ...exact, "backups.status": "auto", "jobs.recent": "auto", "records.query": "auto", "storage.health": "auto", "alerts.active": "auto", "docs.search": "auto", "memory.search": "auto", "notes.read": "auto", "notes.write": "auto", "plan.propose": "auto", "notify.owner": "auto" },
      triggers: { ask: true, schedule: { every: "daily", hour: 3, minute: 45, quietHours: true }, events: ["job.failed"] },
      budget: { runsPerDay: 6, modelSecondsPerDay: 600, stepsPerRun: 5, tokensPerRun: 8_000, runSeconds: 400 },
      outputs: { notes: true, digest: false, notify: "important", proposals: true },
      memory: { enabled: true, freshDays: 14, maxNotes: 40, share: true },
      allow: { apps: "*", operations: ["app.backup", "app.backup.many", "backup.sync", "backup.remote.sync", "backup.cloud.sync"] },
    },
  },
  {
    id: "it-support",
    title: "IT Support helper",
    summary: "A read-only helper anyone signed in can borrow: answers how-to questions and says what state things are in. Keeps no notes, proposes nothing.",
    spec: {
      name: "IT Support helper",
      purpose: "Answers questions about how this server and BoxPilot work, for anyone signed in.",
      job: "Answer how-to questions about this server and BoxPilot in plain words.",
      successCriteria: ["Names the BoxPilot page to open.", "Says who can make a change when one is needed.", "Uses plain words, no jargon."],
      prompt: {
        rules: ["You help people who may not run this server: explain in plain words.", "Never tell anyone how to get around a permission."],
        steps: ["Answer how-to questions from docs.search.", "Say what state things are in from the other tools.", "Name the page to open, and who can make a change."],
        output: { format: "text", style: "Short steps a person can follow." },
        escalate: [],
      },
      instructions: "",
      audience: ["owner", "operator", "viewer"],
      tools: { ...off, ...exact, "server.facts": "auto", "apps.list": "auto", "services.status": "auto", "storage.health": "auto", "docs.search": "auto", "document.read": "auto", "alerts.active": "auto", "where.runs": "auto" },
      triggers: { ask: true, schedule: null, events: [] },
      budget: { runsPerDay: 60, modelSecondsPerDay: 1_200, stepsPerRun: 4, tokensPerRun: 8_000, runSeconds: 300 },
      outputs: { notes: false, digest: false, notify: "never", proposals: false },
      memory: { enabled: false, freshDays: 14, maxNotes: 1, threads: true },
      escalation: { lowConfidence: false, limits: false, actions: false, risk: true },
    },
  },
  {
    id: "blank",
    title: "Blank",
    summary: "Start from nothing: one job, its success criteria, and the tools you choose.",
    spec: {
      name: "New agent",
      purpose: "",
      job: "Answer one kind of question about this server.",
      successCriteria: ["Answers from the tools, with citations."],
      prompt: { rules: [], steps: [], output: { format: "text" }, escalate: [] },
      instructions: "",
      audience: ["owner", "operator"],
      tools: { ...off, ...exact, "server.facts": "auto", "docs.search": "auto" },
      triggers: { ask: true, schedule: null, events: [] },
      budget: {},
      outputs: { notes: false, digest: false, notify: "never", proposals: false },
      memory: { enabled: false },
    },
  },
].map((template) => Object.freeze({ ...template, spec: normalizeSpec(template.spec) })));

export const templateById = (id) => agentTemplates.find((template) => template.id === id) ?? null;

/** The facts a golden question can expect, each read from this server when the evaluation runs. */
export const evaluationFacts = Object.freeze(["hostname", "operatingSystem", "installedApps", "rootDiskPercent", "piholePlacement", "piholeBlocking", "drives", "stoppedApps"]);

/**
 * The built-in evaluation (M40): real questions with answers BoxPilot can check, each asked only of
 * an agent whose own tools can answer it. They are the owner's own first questions to their agent
 * - which drives, where Pi-hole runs - and the plainest facts about the server.
 */
export const builtInEvaluation = Object.freeze([
  { id: "builtin-drives", tool: "storage.health", question: "Which drives are connected to this server?", expect: { fact: "drives" } },
  { id: "builtin-root", tool: "storage.health", question: "How full is the root filesystem, as a percentage?", expect: { fact: "rootDiskPercent" } },
  { id: "builtin-pihole", tool: "where.runs", question: "Where does Pi-hole run on this server?", expect: { fact: "piholePlacement" } },
  { id: "builtin-stopped", tool: "apps.list", question: "Which BoxPilot apps are stopped?", expect: { fact: "stoppedApps" } },
  { id: "builtin-os", tool: "server.facts", question: "Which operating system and version does this server run?", expect: { fact: "operatingSystem" } },
].map((entry) => Object.freeze(entry)));

/** The built-in questions an agent's tools can answer: any tool it may use when a person asks. */
export function builtInQuestions(spec) {
  return builtInEvaluation.filter((entry) => ["auto", "ask"].includes(spec?.tools?.[entry.tool])).map(({ id, question, expect, tool }) => ({ id, question, expect: { ...expect }, tool, builtIn: true }));
}

/**
 * Golden questions each template starts with (the Evaluation tab). `expect.fact` is read from this
 * server when the evaluation runs, so a question checks that the agent knows *this* server rather
 * than an answer typed in when it was written.
 */
export const templateQuestions = Object.freeze({
  "server-keeper": [
    { id: "hostname", question: "What is this server called?", expect: { fact: "hostname" } },
    { id: "os", question: "Which operating system does this server run?", expect: { fact: "operatingSystem" } },
    { id: "apps", question: "How many BoxPilot apps are installed?", expect: { fact: "installedApps" } },
    { id: "pihole-where", question: "Is Pi-hole a BoxPilot app, another container, or running on the host?", expect: { fact: "piholePlacement" } },
    { id: "root-disk", question: "How full is the root disk, as a percentage?", expect: { fact: "rootDiskPercent" } },
  ],
  "pihole-watcher": [
    { id: "pihole-where", question: "Where does Pi-hole run on this server?", expect: { fact: "piholePlacement" } },
    { id: "blocking", question: "Is Pi-hole blocking right now?", expect: { fact: "piholeBlocking" } },
  ],
  "backup-auditor": [
    { id: "apps", question: "How many BoxPilot apps are installed?", expect: { fact: "installedApps" } },
  ],
  "it-support": [
    { id: "hostname", question: "What is this server called?", expect: { fact: "hostname" } },
    { id: "restore-howto", question: "How do I restore an app from a backup?", expect: { includes: ["backup"] } },
  ],
  blank: [],
});
