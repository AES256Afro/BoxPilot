// @vitest-environment node
/**
 * The three reads the templates still said they could not make (M47.6): which apps use the
 * processor and memory (apps.usage, the Performance page's read), which apps hold data and have
 * never been backed up or have no schedule (backups.coverage, the Backups page's read), and what
 * takes up room that nothing needs with what the clean-up would free (space.reclaimable, the
 * Storage page's read; an operator's, ADR-003). The Update Planner gets updates.status, which M47.1
 * made for the Keeper while the Planner's rule went on saying it could not see package updates.
 */
import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { createAgentsHarness, defaultHelperAnswers } from "../../test/agents-harness.mjs";
import { gradeFact } from "./grade.mjs";
import { describeCoverage, describeReclaimable, describeUsage } from "./tool-text.mjs";
import { seedExamples, templateById, templateQuestions } from "./templates.mjs";
import { toolById, toolsForQuestion } from "./tool-catalog.mjs";
import { createToolRunner } from "./tools.mjs";

const answers = defaultHelperAnswers();
const helper = { request: async (operation) => { const answer = answers[operation]; if (!answer) throw new Error(`no stub for ${operation}`); return answer({}); } };
const schedules = [{ id: "s1", operationId: "app.backup", parameters: { id: "pi-hole" }, enabled: true }, { id: "s2", operationId: "app.backup.many", parameters: { ids: ["immich"] }, enabled: false }];
const runner = createToolRunner({ state: { listJobs: () => [], listSchedules: () => schedules }, store: { listDocuments: () => [] }, registry, helper, now: () => new Date("2026-09-29T10:00:00Z") });
const run = (tool, readRole = "owner") => runner.run(tool, {}, { spec: {}, readRole, readAs: "person-1" });

describe("the words of each read", () => {
  it("say how hard the machine works and which apps do the working, busiest first", () => {
    expect(describeUsage(answers["system.performance.inspect"]())).toBe([
      "Machine: processor 12% busy across 4 cores (load 0.42 over 1 minute, 0.50 over 5, 0.61 over 15); memory 6.0 GB of 16.0 GB used (38%), 10.0 GB available; swap none of 2.0 GB used.",
      "2 apps running, busiest first (processor as a share of one core):",
      "- jellyfin: 48.6% of a core, 1.3 GB memory (2 containers)",
      "- pi-hole: 1.2% of a core, 120 MB memory",
      "Not running, so using nothing: nextcloud.",
    ].join("\n"));
    expect(describeUsage({ cpu: { cores: 2 }, memory: {}, swap: {}, statsAvailable: false, apps: [] })).toMatch(/docker stats did not answer\.\nNo app is running\.$/);
    expect(describeUsage(null)).toBe("Resource use could not be read.");
  });

  it("say which apps hold data, which were never backed up or have no schedule, and which keep only caches", () => {
    expect(describeCoverage(answers["app.backup.protection"](), { schedules, now: Date.parse("2026-09-29T10:00:00Z") })).toBe([
      "Backup coverage: 2 apps hold data worth keeping; 1 never backed up; 1 with no backup schedule.",
      "- nextcloud: never backed up, no schedule",
      "- pi-hole: 3 backups, newest 2 days old (2026-09-27), scheduled",
      "Keep no data worth backing up (caches only), so need no backup: jellyfin.",
    ].join("\n"));
    const covered = { available: true, apps: [{ id: "pi-hole", protectable: true, backups: 3, newestAt: "2026-09-29T03:00:00Z" }] };
    expect(describeCoverage(covered, { schedules, now: Date.parse("2026-09-29T10:00:00Z") })).toBe("Backup coverage: 1 app holds data worth keeping; every one has been backed up; each has a schedule.\n- pi-hole: 3 backups, newest today (2026-09-29), scheduled");
    expect(describeCoverage({ available: false, apps: [] })).toBe("Backup coverage: no app is installed.\nThe backup folder could not all be read, so a count may be short.");
    expect(describeCoverage(null)).toBe("Which apps have backups could not be read.");
  });

  it("say what the clean-up would free, what it leaves, and Docker's own figures", () => {
    expect(describeReclaimable(answers["housekeeping.inspect"](), answers["docker.disk.inspect"]())).toBe([
      "Reclaimable by the Storage page's clean-up: 2.5 GB in 2 categories.",
      "- Previous BoxPilot releases: 2 items, 410 MB",
      "- Docker images no app uses: 3 items, 2.1 GB",
      "- Unfinished restores: 1 item, 50 MB (not removed by the clean-up: Recovery evidence. General cleanup cannot remove these folders.)",
      "Docker (docker system df):",
      "- Images: 12 in all, 9 in use, 6.2GB, reclaimable 2.1GB (33%)",
      "- Containers: 9 in all, 8 in use, 120MB, reclaimable 0B (0%)",
      "- Local Volumes: 7 in all, 7 in use, 3.4GB, reclaimable 0B (0%)",
      "- Build Cache: 0 in all, 0 in use, 0B, reclaimable 0B",
      "Container logs are not capped: a chatty container can fill the disk until Docker's log rotation is set (the Storage page offers it).",
    ].join("\n"));
    expect(describeReclaimable(answers["housekeeping.inspect"](), null)).not.toMatch(/Docker \(/);
    expect(describeReclaimable(null, { available: false })).toBe("BoxPilot's own leftovers could not be read.\nDocker's disk use could not be read: docker system df did not answer.");
    expect(describeReclaimable(null, null)).toBe("What space could be reclaimed could not be read.");
  });
});

describe("the tools, held to the run's role", () => {
  it("read for a viewer what the pages show a viewer, and keep the clean-up's read to an operator", async () => {
    expect(await run("apps.usage", "viewer")).toMatch(/^Machine: processor 12% busy/);
    expect(await run("backups.coverage", "viewer")).toMatch(/^Backup coverage: 2 apps hold data worth keeping; 1 never backed up; 1 with no backup schedule\.\n- nextcloud: never backed up, no schedule\n- pi-hole: 3 backups, newest 2 days old \(2026-09-27\), scheduled/);
    expect(await run("space.reclaimable", "operator")).toMatch(/^Reclaimable by the Storage page's clean-up: 2\.5 GB/);
    await expect(run("space.reclaimable", "viewer")).rejects.toThrow(/needs an operator/);
    expect(toolById("space.reclaimable").role).toBe(registry.get("housekeeping.inspect").minimumRole);
  });

  it("are the tools a request's own words point at, beside the whole-machine ones that share a word", () => {
    const offered = ["server.facts", "storage.health", "backups.status", "apps.list", "apps.usage", "backups.coverage", "space.reclaimable", "updates.status"];
    expect(toolsForQuestion("Which app is using the most memory?", offered)).toContain("apps.usage");
    expect(toolsForQuestion("Why is the server so slow?", offered)).toEqual(["apps.usage"]);
    expect(toolsForQuestion("Which apps have never been backed up?", offered)).toContain("backups.coverage");
    expect(toolsForQuestion("Which apps have no backup schedule?", offered)).toContain("backups.coverage");
    expect(toolsForQuestion("How much disk space could be cleaned up?", offered)).toContain("space.reclaimable");
    expect(toolsForQuestion("How much disk is Docker using?", offered)).toContain("space.reclaimable");
    expect(toolsForQuestion("Does the server need a reboot?", offered)).toEqual(["updates.status"]);
    expect(toolsForQuestion("Do I need to reboot the server?", offered)).toEqual(["updates.status"]);
    expect(toolsForQuestion("Which app is eating the most memory?", offered)).toContain("apps.usage");
    expect(toolsForQuestion("How much space would a clean-up free?", offered)).toContain("space.reclaimable");
    for (const id of offered) expect(toolById(id)).toBeTruthy();
  });
});

describe("the templates and the evaluation", () => {
  it("give each template the read it said it lacked, with seeds and golden questions", () => {
    expect(templateById("server-keeper").spec.tools).toMatchObject({ "apps.usage": "auto", "backups.coverage": "auto", "space.reclaimable": "auto" });
    // The Scout keeps its ten: a call that acts carries ten, and its survey fills them.
    expect(templateById("environment-scout").spec.tools).toMatchObject({ "backups.coverage": "off", "apps.usage": "off" });
    expect(templateById("backup-auditor").spec.tools).toMatchObject({ "backups.coverage": "auto" });
    expect(templateById("storage-watch").spec.tools).toMatchObject({ "space.reclaimable": "auto" });
    expect(templateById("update-planner").spec.tools).toMatchObject({ "updates.status": "auto" });
    expect(templateById("it-support").spec.tools).toMatchObject({ "apps.usage": "auto" });
    expect(templateById("backup-auditor").spec.prompt.steps[0]).toMatch(/backups\.coverage/);
    expect(templateById("storage-watch").spec.prompt.steps).toHaveLength(4);
    expect(templateById("update-planner").spec.prompt.steps[0]).toMatch(/updates\.status/);
    expect(seedExamples("backup-auditor", templateById("backup-auditor").spec).map((seed) => seed.id)).toEqual(expect.arrayContaining(["never", "unscheduled"]));
    expect(seedExamples("update-planner", templateById("update-planner").spec).map((seed) => seed.id)).toEqual(expect.arrayContaining(["packages", "reboot"]));
    expect(seedExamples("storage-watch", templateById("storage-watch").spec).map((seed) => seed.id)).toEqual(expect.arrayContaining(["reclaim", "docker-disk"]));
    expect(templateQuestions["backup-auditor"].find((question) => question.id === "never")).toMatchObject({ expect: { fact: "neverBackedUp" } });
    expect(templateQuestions["update-planner"].find((question) => question.id === "reboot")).toMatchObject({ expect: { fact: "rebootRequired" } });
  });

  it("grades the apps never backed up, and whether a reboot is required", () => {
    expect(gradeFact("neverBackedUp", ["nextcloud"], "Nextcloud has never been backed up [T1]; Pi-hole has 3 backups.").passed).toBe(true);
    expect(gradeFact("neverBackedUp", ["nextcloud"], "Every app has been backed up.").passed).toBe(false);
    expect(gradeFact("neverBackedUp", [], "Every app has been backed up [T1].").passed).toBe(true);
    expect(gradeFact("neverBackedUp", [], "Nextcloud has never been backed up.").passed).toBe(false);
    expect(gradeFact("rebootRequired", "no", "No: 2 packages wait, but reboot required: no [T1].").passed).toBe(true);
    expect(gradeFact("rebootRequired", "yes", "Yes. The server needs a reboot after the kernel update [T1].").passed).toBe(true);
    expect(gradeFact("rebootRequired", "no", "Yes, a reboot is required.").passed).toBe(false);
    expect(gradeFact("rebootRequired", null, "no")).toMatchObject({ passed: false });
  });

  it("reads the facts from the server, a Keeper asked answers from backups.coverage, and agents made before get the reads and the words once", async () => {
    const h = await createAgentsHarness();
    try {
      h.enable();
      const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
      h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Which apps have never been backed up?" });
      const asked = await h.runNext();
      expect(asked.state).toBe("completed");
      expect(h.service.getRun(h.caller("owner"), asked.id).steps.filter((step) => step.kind === "tool").map((step) => step.name)).toContain("backups.coverage");
      expect(gradeFact("neverBackedUp", ["nextcloud"], asked.answer).passed).toBe(true);

      // The Backup Auditor's and the Update Planner's golden questions read this server's facts.
      const auditor = h.service.createAgent(h.caller("owner"), { template: "backup-auditor" });
      const started = await h.service.runEvaluation(h.caller("owner"), auditor.id);
      expect(started.results.find((result) => result.questionId === "never").expected).toEqual({ fact: "neverBackedUp", value: ["nextcloud"] });
      const planner = h.service.createAgent(h.caller("owner"), { template: "update-planner" });
      expect((await h.service.runEvaluation(h.caller("owner"), planner.id)).results.find((result) => result.questionId === "reboot").expected).toEqual({ fact: "rebootRequired", value: "no" });

      // Agents as the owner's server had them before M47.6: the tools off, the old words, the old budget.
      const watch = h.service.createAgent(h.caller("owner"), { template: "storage-watch" });
      const before = {
        [auditor.id]: {
          tools: { "backups.coverage": "off" },
          rules: ["A backup job that failed, or an app never backed up, is a finding.", "Work out ages with time.calc."],
          steps: ["Use apps.list for the apps installed, then backups.status and jobs.recent.", "For each app: when it was last backed up, whether its restore check passed, whether there is an off-box copy newer than two days.", "Keep a note of which apps you have seen, so you notice a new app with no backup."],
          budget: { runsPerDay: 6, modelSecondsPerDay: 1_200, stepsPerRun: 5, tokensPerRun: 8_000, runSeconds: 400 },
        },
        [planner.id]: {
          tools: { "updates.status": "off" },
          rules: (rules) => rules.map((rule) => (rule.startsWith("updates.status says") ? "Your tools cannot see how many system packages are waiting: say so, and point to the Updates page. Add apt.refresh and apt.upgrade only when no schedule or automation already installs them." : rule.startsWith("Propose system.reboot") ? "Propose system.reboot only when alerts.active says a reboot is required, as a card of its own." : rule)),
          steps: (steps) => ["Use apps.list for apps with an update available, and alerts.active for a reboot required or news of a BoxPilot release.", ...steps.slice(1)],
          budget: { runsPerDay: 4, modelSecondsPerDay: 1_200, stepsPerRun: 8, tokensPerRun: 12_000, runSeconds: 900 },
        },
        [watch.id]: {
          tools: { "space.reclaimable": "off" },
          rules: (rules) => rules.map((rule) => (rule.startsWith("space.reclaimable says") ? "Your tools cannot see what takes up the space, what Docker could free or how old the snapshots are: point to the Storage page for those." : rule)),
          steps: (steps) => steps.filter((step) => !step.includes("space.reclaimable")),
          budget: { runsPerDay: 4, modelSecondsPerDay: 1_200, stepsPerRun: 6, tokensPerRun: 8_000, runSeconds: 480 },
        },
      };
      for (const [id, old] of Object.entries(before)) {
        const spec = h.store.getAgent(id).spec;
        const rules = typeof old.rules === "function" ? old.rules(spec.prompt.rules) : old.rules;
        const steps = typeof old.steps === "function" ? old.steps(spec.prompt.steps) : old.steps;
        h.service.updateAgent(h.caller("owner"), id, { spec: { ...spec, tools: { ...spec.tools, ...old.tools }, prompt: { ...spec.prompt, rules, steps }, budget: old.budget ?? spec.budget } });
      }
      h.state.setSetting("agentsMigrations", { runSeconds: {}, sharing: {}, examples: {}, eyes: {}, surveyWide: {} }, { updatedBy: null });
      expect(h.service.migrateDefaults()).toBeGreaterThanOrEqual(3);
      for (const [id, templateId] of [[auditor.id, "backup-auditor"], [planner.id, "update-planner"], [watch.id, "storage-watch"]]) {
        const template = templateById(templateId).spec;
        const spec = h.store.getAgent(id).spec;
        expect(spec.tools, templateId).toEqual(template.tools);
        expect(spec.prompt.rules, templateId).toEqual(template.prompt.rules);
        expect(spec.prompt.steps, templateId).toEqual(template.prompt.steps);
        expect(spec.budget, templateId).toEqual(template.budget);
        expect(h.service.getAgent(h.caller("owner"), id).versions[0].note, templateId).toMatch(/^BoxPilot gave it eyes on/);
      }
      // Once; the Keeper and the Scout, already on their templates, were left alone.
      expect(h.service.migrateDefaults()).toBe(0);
    } finally {
      await h.close();
    }
  });
});
