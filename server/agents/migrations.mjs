/**
 * One-time changes BoxPilot makes to saved agents at startup, each once and each a version of its
 * own that says BoxPilot made it; what ran, and when, is kept under agentsMigrationsKey. Part of the
 * agents service (service.mjs), which hands it what it uses.
 */
import { budgetCeilings, normalizeSpec, previousRunSecondsDefault } from "./spec.mjs";
import { templateById } from "./templates.mjs";
import { toolById } from "./tool-catalog.mjs";

/**
 * @param {{
 *   store: any, state: any, now: () => Date, audit: (type: string, entry: object) => void,
 *   nextRunFor: (spec: any) => string | null,
 *   sharingFor: (agent: any, spec?: any) => { shareFindings: boolean, useFindings: boolean },
 *   seedAgentExamples: (agent: any) => number, agentsMigrationsKey: string,
 * }} deps
 */
export function createAgentMigrations({ store, state, now, audit, nextRunFor, sharingFor, seedAgentExamples, agentsMigrationsKey }) {
  /**
   * Once each, at startup, each a version of its own that says BoxPilot made it:
   * - an agent saved with the old default longest run (10 minutes) gets the new 15-minute default.
   *   An agent the owner set to anything else keeps it, and so does one they set back to 10 minutes
   *   after this ran.
   * - (M44) an agent saved before findings gets its two switches as its template would give them:
   *   it shares and uses findings, except the IT Support helper and the House Guide, which only use
   *   them. Its budget and everything else stay as the owner saved them.
   */
  function migrateDefaults() {
    const done = state.getSetting?.(agentsMigrationsKey, null) ?? {};
    const next = { ...done };
    let changed = 0;
    const save = (agent, spec, note, fields) => {
      const version = store.addVersion(agent.id, { spec, note, createdBy: null, nextRunAt: agent.nextRunAt ?? nextRunFor(spec) });
      if (!version) return false;
      audit("agents.updated", { subjectId: agent.id, details: { version, fields, by: "boxpilot" } });
      return true;
    };
    if (!done.runSeconds) {
      let raised = 0;
      for (const agent of store.listAgents()) {
        if (agent.spec?.budget?.runSeconds !== previousRunSecondsDefault) continue;
        let spec;
        try { spec = normalizeSpec({ ...agent.spec, budget: { ...agent.spec.budget, runSeconds: budgetCeilings.runSeconds.default }, sharing: sharingFor(agent) }); } catch { continue; }
        if (save(agent, spec, "BoxPilot raised the time limit to the new 15-minute default", ["budget.runSeconds"])) raised += 1;
      }
      next.runSeconds = { at: now().toISOString(), raised };
      changed += raised;
    }
    if (!done.sharing) {
      let added = 0;
      for (const agent of store.listAgents()) {
        if (agent.spec?.sharing) continue;
        const sharing = sharingFor(agent);
        let spec;
        try { spec = normalizeSpec({ ...agent.spec, sharing }); } catch { continue; }
        if (save(agent, spec, sharing.shareFindings ? "BoxPilot turned on findings: it shares what it finds with the other agents and uses theirs" : "BoxPilot turned on findings: it uses what the other agents find, and shares nothing", ["sharing"])) added += 1;
      }
      next.sharing = { at: now().toISOString(), added };
      changed += added;
    }
    // M47: agents made from a template before it had eyes on the firewall, package updates, Repair and
    // the rest get the template's new tools, once, and the Scout's rule that said it could not see them.
    if (!done.eyes) {
      const eyes = ["firewall.status", "updates.status", "repair.findings", "protection.status", "users.access", "tunnel.exposure"];
      const oldRule = "Your tools cannot see the firewall, open ports, SSH settings, waiting system package updates or Repair's findings. List them under Not checked with the page to open: Firewall, Updates, Repair.";
      let given = 0;
      for (const agent of store.listAgents()) {
        const template = agent.template ? templateById(agent.template) : null;
        if (!template) continue;
        const tools = { ...agent.spec.tools };
        const added = eyes.filter((id) => template.spec.tools[id] === "auto" && (tools[id] ?? "off") === "off");
        if (!added.length) continue;
        for (const id of added) tools[id] = "auto";
        const rules = (agent.spec.prompt?.rules ?? []).map((rule) => (rule === oldRule ? template.spec.prompt.rules.find((entry) => entry.startsWith("Asked about the firewall or Repair alone")) ?? rule : rule));
        let spec;
        try { spec = normalizeSpec({ ...agent.spec, tools, prompt: { ...agent.spec.prompt, rules }, sharing: sharingFor(agent) }); } catch { continue; }
        if (save(agent, spec, `BoxPilot gave it eyes on ${added.map((id) => toolById(id)?.title.toLowerCase() ?? id).join(", ")}`, added.map((id) => `tools.${id}`))) given += 1;
      }
      next.eyes = { at: now().toISOString(), given };
      changed += given;
    }
    // M47.2: a Scout still on the five-read survey gets the seven-read one and the budget it needs,
    // once. The survey is known by the tools its steps name - the five reads and neither of the
    // new ones - not by their words: the owner's Scout (made in M43) worded a step differently from
    // the template of the day, and the first try matched nothing. A Scout whose maker rewrote its
    // steps around other tools keeps them. Every templated agent also gets the seeds its template
    // gained for the new tools (the examples migration ran before those tools existed).
    if (!done.surveyWide) {
      const scout = templateById("environment-scout");
      const onRequestRule = "The firewall and Repair's findings are read on request: firewall.status and repair.findings. The weekly survey does not read them: list what this run did not read under Not checked, with the page to open (Firewall, Repair).";
      const newRule = scout?.spec.prompt.rules.find((entry) => entry.startsWith("Asked about the firewall or Repair alone")) ?? null;
      const fiveReads = ["alerts.active", "storage.health", "apps.list", "backups.status", "server.facts"];
      const mentions = (steps, id) => steps.some((step) => String(step).includes(id));
      let widened = 0;
      let seeded = 0;
      for (const agent of store.listAgents()) {
        if (agent.template) seeded += seedAgentExamples(agent);
        if (agent.template !== "environment-scout" || !scout) continue;
        const steps = agent.spec.prompt?.steps ?? [];
        const fiveReadSurvey = fiveReads.every((id) => mentions(steps, id)) && !mentions(steps, "firewall.status") && !mentions(steps, "repair.findings");
        const hasOldRule = (agent.spec.prompt?.rules ?? []).includes(onRequestRule);
        if (!fiveReadSurvey && !hasOldRule) continue;
        const prompt = {
          ...agent.spec.prompt,
          steps: fiveReadSurvey ? scout.spec.prompt.steps : steps,
          rules: (agent.spec.prompt?.rules ?? []).map((rule) => (rule === onRequestRule && newRule ? newRule : rule)),
        };
        const budget = { ...agent.spec.budget };
        for (const field of ["modelSecondsPerDay", "stepsPerRun", "tokensPerRun", "runSeconds"]) if ((budget[field] ?? 0) < scout.spec.budget[field]) budget[field] = scout.spec.budget[field];
        const tools = { ...agent.spec.tools };
        for (const id of ["firewall.status", "repair.findings"]) if ((tools[id] ?? "off") === "off") tools[id] = "auto";
        let spec;
        try { spec = normalizeSpec({ ...agent.spec, prompt, budget, tools, sharing: sharingFor(agent) }); } catch { continue; }
        if (save(agent, spec, "BoxPilot widened its weekly survey: it reads Repair's findings and the firewall too, with the steps, tokens and time that takes", ["prompt.steps", "budget"])) widened += 1;
      }
      next.surveyWide = { at: now().toISOString(), widened, seeded };
      changed += widened + seeded;
    }
    // M47.6: the templates said three things their tools could not see (what takes the space, how
    // many packages wait, which apps have no backup); now they can (the Scout keeps its ten: a call
    // that acts carries ten, and its survey fills them). Agents made from a template get
    // the tools it gained, once; a rule or a step of the template's old wording becomes the new one
    // (a rule or step the maker rewrote is left alone); the Backup Auditor, Storage Watch and the
    // Update Planner get the budget their longer work takes; and every templated agent gets the seeds
    // its template gained.
    if (!done.eyesMore) {
      const more = ["apps.usage", "backups.coverage", "space.reclaimable", "updates.status"];
      const reworded = new Map([
        ["Your tools cannot see what takes up the space, what Docker could free or how old the snapshots are: point to the Storage page for those.", "storage-watch"],
        ["Your tools cannot see how many system packages are waiting: say so, and point to the Updates page. Add apt.refresh and apt.upgrade only when no schedule or automation already installs them.", "update-planner"],
        ["Propose system.reboot only when alerts.active says a reboot is required, as a card of its own.", "update-planner"],
      ]);
      const newRuleFor = (template, oldRule) => {
        const starts = { "Your tools cannot see what takes up": "space.reclaimable says", "Your tools cannot see how many system packages": "updates.status says", "Propose system.reboot only when": "Propose system.reboot only when updates.status" };
        const start = Object.keys(starts).find((key) => oldRule.startsWith(key));
        return start ? template.spec.prompt.rules.find((rule) => rule.startsWith(starts[start]) && rule !== oldRule) ?? null : null;
      };
      const oldSteps = {
        "backup-auditor": "Use apps.list for the apps installed, then backups.status and jobs.recent.",
        "update-planner": "Use apps.list for apps with an update available, and alerts.active for a reboot required or news of a BoxPilot release.",
      };
      let given = 0;
      let seeded = 0;
      for (const agent of store.listAgents()) {
        const template = agent.template ? templateById(agent.template) : null;
        if (!template) continue;
        const tools = { ...agent.spec.tools };
        const added = more.filter((id) => template.spec.tools[id] === "auto" && (tools[id] ?? "off") === "off");
        for (const id of added) tools[id] = "auto";
        const rules = (agent.spec.prompt?.rules ?? []).map((rule) => (reworded.get(rule) === agent.template ? newRuleFor(template, rule) ?? rule : rule));
        // The Backup Auditor gained a rule (an app of caches needs no backup): after the one it follows in the template.
        const auditorRule = agent.template === "backup-auditor" ? template.spec.prompt.rules.find((rule) => rule.startsWith("An app backups.coverage says")) ?? null : null;
        const finding = "A backup job that failed, or an app never backed up, is a finding.";
        if (auditorRule && !rules.includes(auditorRule) && rules.includes(finding) && rules.length < 12) rules.splice(rules.indexOf(finding) + 1, 0, auditorRule);
        let steps = [...(agent.spec.prompt?.steps ?? [])];
        if (oldSteps[agent.template] && steps.includes(oldSteps[agent.template])) steps = steps.map((step) => (step === oldSteps[agent.template] ? template.spec.prompt.steps[0] : step));
        // Only a Storage Watch still on the template's old steps, word for word, gets the new one (M48.4: an edited step two or three is the maker's).
        const oldStorageSteps = template.spec.prompt.steps.filter((step) => !step.includes("space.reclaimable"));
        if (agent.template === "storage-watch" && steps.join("\n") === oldStorageSteps.join("\n")) steps = template.spec.prompt.steps;
        const budget = { ...agent.spec.budget };
        // Only a budget still at the old template's default rises to the new one: a budget the owner cut on purpose stays (M48.4).
        const formerBudgets = { "backup-auditor": { modelSecondsPerDay: 1_200, stepsPerRun: 5, tokensPerRun: 8_000, runSeconds: 400 }, "storage-watch": { modelSecondsPerDay: 1_200, stepsPerRun: 6, tokensPerRun: 8_000, runSeconds: 480 }, "update-planner": { modelSecondsPerDay: 1_200, stepsPerRun: 8, tokensPerRun: 12_000, runSeconds: 900 } };
        const former = formerBudgets[agent.template];
        if (former) for (const field of Object.keys(former)) if (budget[field] === former[field] && budget[field] < template.spec.budget[field]) budget[field] = template.spec.budget[field];
        const differs = added.length > 0 || rules.some((rule, index) => rule !== (agent.spec.prompt?.rules ?? [])[index]) || steps.join("\n") !== (agent.spec.prompt?.steps ?? []).join("\n") || Object.keys(budget).some((field) => budget[field] !== agent.spec.budget?.[field]);
        if (differs) {
          let spec;
          try { spec = normalizeSpec({ ...agent.spec, tools, prompt: { ...agent.spec.prompt, rules, steps }, budget, sharing: sharingFor(agent) }); } catch { spec = null; }
          const note = added.length ? `BoxPilot gave it eyes on ${added.map((id) => toolById(id)?.title.toLowerCase() ?? id).join(", ")}` : "BoxPilot reworded its steps for the reads it has now";
          if (spec && save(agent, spec, note, [...added.map((id) => `tools.${id}`), "prompt"])) given += 1;
        }
        seeded += seedAgentExamples(store.getAgent(agent.id) ?? agent);
      }
      next.eyesMore = { at: now().toISOString(), given, seeded };
      changed += given + seeded;
    }
    // M65: more room. The owner's server showed the limits, not the machine, were what stopped the
    // work (2026-11: a quarter of the memory in use, load under one, and a limit reached in one run
    // in six). An agent's steps, tokens and time a run and model time a day rise to its template's
    // new ones (a blank one's, to the new defaults) where they still stand at what the template or
    // the defaults gave before: a limit the owner set, lower or higher, stays (M48.4).
    if (!done.headroom) {
      let raised = 0;
      const fields = ["modelSecondsPerDay", "stepsPerRun", "tokensPerRun", "runSeconds"];
      const formerDefaults = { modelSecondsPerDay: 1_800, stepsPerRun: 6, tokensPerRun: 12_000, runSeconds: 900 };
      // What a template gave before its former budget: the IT Support helper's first day of model time.
      const earlier = { "it-support": { modelSecondsPerDay: [1_200] } };
      const was = (modelSecondsPerDay, stepsPerRun, tokensPerRun, runSeconds) => ({ modelSecondsPerDay, stepsPerRun, tokensPerRun, runSeconds });
      const formerBudgets = {
        "server-keeper": was(3_600, 6, 20_000, 1_200), "environment-scout": was(3_000, 12, 32_000, 1_500), "pihole-watcher": was(600, 4, 6_000, 300),
        "spyware-watch": was(900, 4, 10_000, 300), "backup-auditor": was(1_500, 7, 12_000, 600), "app-doctor": was(1_800, 8, 12_000, 900),
        "storage-watch": was(1_200, 7, 10_000, 480), "update-planner": was(1_800, 8, 12_000, 900), "it-support": was(1_800, 4, 8_000, 300),
        "security-reviewer": was(2_400, 10, 24_000, 1_200), "resource-watch": was(1_200, 6, 20_000, 600), "house-guide": was(1_800, 4, 8_000, 300),
      };
      for (const agent of store.listAgents()) {
        const template = agent.template ? templateById(agent.template) : null;
        const budget = { ...agent.spec?.budget };
        const former = formerBudgets[agent.template] ?? {};
        const raisedFields = fields.filter((field) => {
          const floor = template?.spec?.budget?.[field] ?? budgetCeilings[field].default;
          if (!((budget[field] ?? 0) < floor)) return false;
          if (budget[field] !== former[field] && budget[field] !== formerDefaults[field] && !(earlier[agent.template]?.[field] ?? []).includes(budget[field])) return false;
          budget[field] = floor;
          return true;
        });
        if (!raisedFields.length) continue;
        let spec;
        try { spec = normalizeSpec({ ...agent.spec, budget, sharing: sharingFor(agent) }); } catch { continue; }
        if (save(agent, spec, "BoxPilot gave it more room: more steps, tokens and time for each run", raisedFields.map((field) => `budget.${field}`))) raised += 1;
      }
      next.headroom = { at: now().toISOString(), raised };
      changed += raised;
    }
    // M66: two templates' lines said things the prompt already does or the tools contradict. The
    // Keeper spent a step on memory.search for what is pasted under every question; the Scout had
    // one rule twice and said no tool sees the firewall's ports. A line still in the template's old
    // words becomes the new one; a line the maker rewrote is theirs.
    if (!done.wording) {
      const keeperOld = "Check memory.search for what you learned before; say when a note may be out of date.";
      const scoutOld = {
        "Asked about the firewall or Repair alone, read firewall.status or repair.findings for it; the weekly survey reads both.": "Asked about the firewall or Repair alone",
        "Open ports, SSH settings and waiting system package updates no tool of yours sees: name them under Not checked, with the page to open (Updates).": "firewall.status lists the ports",
      };
      // The rule said twice, in both wordings a Scout may carry: the template's until M66, and the
      // one before M47.1 gave it the firewall and Repair, which a Scout made before then still has.
      const scoutTwice = [
        "Asked about one area, read the tool for it: services.status for which services failed, jobs.recent for jobs that failed, firewall.status for the firewall, repair.findings for what Repair found.",
        "Asked about one area, read the tool for it: services.status for which services failed, jobs.recent for jobs that failed.",
      ];
      let reworded = 0;
      for (const agent of store.listAgents()) {
        const template = agent.template ? templateById(agent.template) : null;
        if (!template || !["server-keeper", "environment-scout"].includes(agent.template)) continue;
        let steps = [...(agent.spec.prompt?.steps ?? [])];
        let rules = [...(agent.spec.prompt?.rules ?? [])];
        if (agent.template === "server-keeper") {
          const next = template.spec.prompt.steps.find((step) => step.startsWith("Your notes and what you remember"));
          if (next) steps = steps.map((step) => (step === keeperOld ? next : step));
        } else {
          rules = rules.map((rule) => (scoutOld[rule] ? template.spec.prompt.rules.find((entry) => entry.startsWith(scoutOld[rule]) && entry !== rule) ?? rule : rule));
          // The second saying of it goes only where the first now names its tools.
          if (rules.some((rule) => rule.startsWith("Asked about the firewall or Repair alone") && rule.includes("services.status"))) rules = rules.filter((rule) => !scoutTwice.includes(rule));
        }
        if (steps.join("\n") === (agent.spec.prompt?.steps ?? []).join("\n") && rules.join("\n") === (agent.spec.prompt?.rules ?? []).join("\n")) continue;
        let spec;
        try { spec = normalizeSpec({ ...agent.spec, prompt: { ...agent.spec.prompt, steps, rules }, sharing: sharingFor(agent) }); } catch { continue; }
        if (save(agent, spec, "BoxPilot reworded its steps and rules for what it is already shown and what its tools read", ["prompt"])) reworded += 1;
      }
      next.wording = { at: now().toISOString(), reworded };
      changed += reworded;
    }
    // M46: agents made before the example book get their template's examples, once.
    if (!done.examples) {
      let seeded = 0;
      for (const agent of store.listAgents()) if (agent.template) seeded += seedAgentExamples(agent);
      next.examples = { at: now().toISOString(), seeded };
      changed += seeded;
    }
    if (next.runSeconds !== done.runSeconds || next.sharing !== done.sharing || next.examples !== done.examples || next.eyes !== done.eyes || next.surveyWide !== done.surveyWide || next.eyesMore !== done.eyesMore || next.headroom !== done.headroom || next.wording !== done.wording) state.setSetting?.(agentsMigrationsKey, next, { updatedBy: null });
    return changed;
  }

  return { migrateDefaults };
}
