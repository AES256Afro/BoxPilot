/**
 * The agents the Builder starts from (M37). Each is an ordinary spec (spec.mjs) the owner can
 * change before saving, and each is sized for a small model on a CPU: few tools, few steps, short
 * instructions, and its heavy work - the daily digest, learning the server - in quiet hours.
 */
import { normalizeSpec } from "./spec.mjs";

const off = { "server.facts": "off", "apps.list": "off", "services.status": "off", "logs.query": "off", "storage.health": "off", "docs.search": "off", "notes.read": "off", "notes.write": "off", "jobs.recent": "off", "alerts.active": "off", "backups.status": "off", "pihole.stats": "off", "where.runs": "off", "plan.propose": "off", "notify.owner": "off" };

export const agentTemplates = Object.freeze([
  {
    id: "server-keeper",
    title: "Server Keeper",
    summary: "The resident agent: learns what is on this server, answers questions about it, and writes a daily digest.",
    spec: {
      name: "Server Keeper",
      purpose: "Knows this server: what runs on it, where, and how it is doing. Answers questions about it and writes a short digest every morning.",
      instructions: [
        "Keep notes of what you learn about this server: its apps and where each runs, its drives, its services, anything unusual. Update a note when it is no longer true.",
        "When asked a question, look before you answer: use the tools, then answer in a few sentences with the tool output cited.",
        "For the daily digest: what changed since yesterday, anything failing or getting worse, and what needs the owner. Lead with anything that needs action. Say plainly when all is well.",
        "Suggest a plan only when a registered operation clearly fixes something you found.",
      ].join("\n"),
      audience: ["owner", "operator"],
      tools: { ...off, "server.facts": "auto", "apps.list": "auto", "services.status": "auto", "logs.query": "ask", "storage.health": "auto", "docs.search": "auto", "notes.read": "auto", "notes.write": "auto", "jobs.recent": "auto", "alerts.active": "auto", "backups.status": "auto", "pihole.stats": "ask", "where.runs": "auto", "plan.propose": "auto", "notify.owner": "auto" },
      triggers: { ask: true, schedule: { every: "daily", hour: 5, minute: 30, quietHours: true }, events: ["health.alert", "drive.dropped"] },
      budget: { runsPerDay: 24, modelSecondsPerDay: 1_800, stepsPerRun: 6, tokensPerRun: 12_000, runSeconds: 600 },
      outputs: { notes: true, digest: true, notify: "important", proposals: true },
      memory: { enabled: true, freshDays: 14, maxNotes: 80 },
    },
  },
  {
    id: "pihole-watcher",
    title: "Pi-hole Watcher",
    summary: "Watches Pi-hole: whether it is blocking, whether its lists are fresh, and whether its upstreams answer. Network-wide counts only.",
    spec: {
      name: "Pi-hole Watcher",
      purpose: "Checks that Pi-hole is up, blocking and fresh, and says where it runs.",
      instructions: [
        "Use pihole.stats and where.runs. Report: is blocking on, how many queries and what share were blocked today, how old the blocklists are, and whether each upstream answers quickly.",
        "Blocklists older than 8 days, blocking turned off, or an upstream with no answers are worth telling the owner about.",
        "Talk about the network as a whole. Never try to find out which device asked for what.",
      ].join("\n"),
      audience: ["owner", "operator"],
      tools: { ...off, "pihole.stats": "auto", "where.runs": "auto", "alerts.active": "auto", "docs.search": "auto", "notes.read": "auto", "notes.write": "auto", "plan.propose": "auto", "notify.owner": "auto" },
      triggers: { ask: true, schedule: { every: "every-6-hours", minute: 17, quietHours: false }, events: [] },
      budget: { runsPerDay: 8, modelSecondsPerDay: 600, stepsPerRun: 4, tokensPerRun: 6_000, runSeconds: 300 },
      outputs: { notes: true, digest: false, notify: "important", proposals: true },
      memory: { enabled: true, freshDays: 7, maxNotes: 20 },
    },
  },
  {
    id: "backup-auditor",
    title: "Backup Auditor",
    summary: "Checks every night that backups ran, restore checks passed and the off-box copy is recent, and proposes the fix when one did not.",
    spec: {
      name: "Backup Auditor",
      purpose: "Makes sure every app worth keeping has a recent backup that restores, and a copy off this server.",
      instructions: [
        "Use backups.status and jobs.recent. For each app: when was it last backed up, did its restore check pass, is there an off-box copy newer than two days.",
        "A backup job that failed, or an app never backed up, is a finding. Propose the registered backup operation for it when docs.search shows one.",
        "Keep a note of which apps you have seen, so you notice a new app with no backup.",
      ].join("\n"),
      audience: ["owner", "operator"],
      tools: { ...off, "backups.status": "auto", "jobs.recent": "auto", "storage.health": "auto", "alerts.active": "auto", "docs.search": "auto", "notes.read": "auto", "notes.write": "auto", "plan.propose": "auto", "notify.owner": "auto" },
      triggers: { ask: true, schedule: { every: "daily", hour: 3, minute: 45, quietHours: true }, events: ["job.failed"] },
      budget: { runsPerDay: 6, modelSecondsPerDay: 600, stepsPerRun: 5, tokensPerRun: 8_000, runSeconds: 400 },
      outputs: { notes: true, digest: false, notify: "important", proposals: true },
      memory: { enabled: true, freshDays: 14, maxNotes: 40 },
    },
  },
  {
    id: "it-support",
    title: "IT Support helper",
    summary: "A read-only helper anyone signed in can borrow: answers how-to questions and says what state things are in. Keeps no notes, proposes nothing.",
    spec: {
      name: "IT Support helper",
      purpose: "Answers questions about how this server and BoxPilot work, for anyone signed in.",
      instructions: [
        "Answer how-to questions from docs.search and say what state things are in from the other tools.",
        "You help people who may not run this server: explain in plain words, name the BoxPilot page to open, and say who can make a change when one is needed.",
      ].join("\n"),
      audience: ["owner", "operator", "viewer"],
      tools: { ...off, "server.facts": "auto", "apps.list": "auto", "services.status": "auto", "storage.health": "auto", "docs.search": "auto", "alerts.active": "auto", "where.runs": "auto" },
      triggers: { ask: true, schedule: null, events: [] },
      budget: { runsPerDay: 60, modelSecondsPerDay: 1_200, stepsPerRun: 4, tokensPerRun: 8_000, runSeconds: 300 },
      outputs: { notes: false, digest: false, notify: "never", proposals: false },
      memory: { enabled: false, freshDays: 14, maxNotes: 1 },
    },
  },
  {
    id: "blank",
    title: "Blank",
    summary: "Start from nothing: a name, and the tools you choose.",
    spec: {
      name: "New agent",
      purpose: "",
      instructions: "",
      audience: ["owner", "operator"],
      tools: { ...off, "server.facts": "auto", "docs.search": "auto" },
      triggers: { ask: true, schedule: null, events: [] },
      budget: {},
      outputs: { notes: false, digest: false, notify: "never", proposals: false },
      memory: { enabled: false },
    },
  },
].map((template) => Object.freeze({ ...template, spec: normalizeSpec(template.spec) })));

export const templateById = (id) => agentTemplates.find((template) => template.id === id) ?? null;

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
