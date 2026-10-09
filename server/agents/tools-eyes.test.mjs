// @vitest-environment node
/**
 * Eyes on what the agents said every night they could not see (M47): the firewall, waiting package
 * updates, Repair's findings, brute-force protection, the accounts and SSH, and what the tunnel
 * publishes. Each is the registered read the matching page makes, worded one fact a line, held to
 * the run's role as every read is (ADR-003): users.access needs an operator, tunnel.exposure the
 * owner, and a viewer's run is told so rather than shown it.
 */
import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { createAgentsHarness, defaultHelperAnswers } from "../../test/agents-harness.mjs";
import { gradeFact } from "./grade.mjs";
import { describeFirewall, describeProtection, describeRepair, describeTunnel, describeUpdates, describeUsers } from "./tool-text.mjs";
import { agentTemplates, seedExamples, templateById, templateQuestions } from "./templates.mjs";
import { toolById, toolsForQuestion } from "./tool-catalog.mjs";
import { createToolRunner } from "./tools.mjs";

const answers = defaultHelperAnswers();
const helper = { request: async (operation) => { const answer = answers[operation]; if (!answer) throw new Error(`no stub for ${operation}`); return answer({}); } };
const scan = { findings: [
  { id: "stale-mount:media", severity: "critical", title: "/mnt/media is mounted from a drive that is gone", detail: "Jellyfin still holds it.", fix: { operationId: "storage.remount", label: "Reconnect the drive", risk: "medium" }, fixes: [] },
  { id: "backup-untested:nextcloud", severity: "info", title: "Nextcloud's backups were never test-restored", detail: "", fix: null, fixes: [], manual: "Open Backups and verify one." },
  { id: "port-held:homepage", severity: "warning", title: "Homepage's port 3000 is held while it is stopped", detail: "By another container.", fix: null, fixes: [], view: "apps" },
], dismissed: [{ id: "x" }], jobs: [], counts: { critical: 1, warning: 1, info: 1 }, unavailableChecks: ["USB history (needs an operator)"] };
const repairScan = async ({ operatorReads }) => ({ ...scan, unavailableChecks: operatorReads ? [] : scan.unavailableChecks });
const runner = createToolRunner({ state: { listJobs: () => [] }, store: { listDocuments: () => [] }, registry, helper, repairScan });
const run = (tool, readRole = "owner") => runner.run(tool, {}, { spec: {}, readRole, readAs: "person-1" });

describe("the words of each read", () => {
  it("say the firewall's state, policy and each rule, and when ufw is missing", () => {
    expect(describeFirewall(answers["firewall.inspect"]())).toBe([
      "Firewall: ufw is installed and on. Default policy: incoming deny, outgoing allow, routed reject. 2 rules configured. Docker's own rules are in place, so a published container port is reachable whatever ufw says.",
      "- allow in to 22/tcp from anywhere - SSH",
      "- allow in to 8787/tcp from 192.0.2.0/24 - BoxPilot",
    ].join("\n"));
    expect(describeFirewall({ installed: false })).toMatch(/not installed/);
    expect(describeFirewall({ installed: true, enabled: false, defaults: null, rules: [] })).toMatch(/^Firewall: ufw is installed and off\. 0 rules configured\.$/);
    expect(describeFirewall(null)).toBe("The firewall could not be read.");
  });

  it("say how many updates wait, which are security, the reboot, and the services on old libraries", () => {
    const text = describeUpdates(answers["apt.upgradable.inspect"]());
    expect(text).toMatch(/^Package updates waiting: 2 packages, 1 of them security updates\. Reboot required: no\.\nServices still running old libraries \(needrestart\): ssh\.service\.\n- openssl: /m);
    expect(describeUpdates({ upgradable: [], count: 0, securityCount: 0, rebootRequired: true, needrestartPresent: false })).toBe("Package updates waiting: none. Reboot required: yes.\nWhich services run old libraries is not known: needrestart is not installed.");
  });

  it("say what fail2ban does and how many it banned, the accounts and SSH, and the tunnel's addresses", () => {
    expect(describeProtection(answers["fail2ban.inspect"]())).toBe("Brute-force protection: fail2ban is installed and running. BoxPilot's sshd jail: ban after 5 failures within 10 minutes, for 60 minutes, the home network never banned. Banned right now: 1; banned in all: 14.");
    expect(describeProtection({ installed: false })).toMatch(/not installed/);
    expect(describeUsers(answers["users.inspect"]())).toBe("2 accounts that can log in: root (sudo), 1 SSH key; owner (sudo), 2 SSH keys.\nSSH (running) on port 22: password login off, keys allowed, root login prohibit-password.");
    expect(describeTunnel(answers["cloudflare.tunnel.inspect"]())).toBe("Cloudflare tunnel boxpilot-testbox: connected. Published to the internet: 1 address.\n- photos.example.org: immich (port 2283), since 2026-10-01");
    expect(describeTunnel({ connected: false, tunnel: null, routes: [] })).toMatch(/not connected/);
  });

  it("say Repair's findings worst first, each with its fix, its manual step or its page", () => {
    expect(describeRepair(scan)).toBe([
      "Repair: 3 findings (1 critical, 1 warning, 1 info); 1 set aside by the owner.",
      "- [critical] /mnt/media is mounted from a drive that is gone: Jellyfin still holds it. Fix offered: Reconnect the drive (medium risk).",
      "- [warning] Homepage's port 3000 is held while it is stopped: By another container. Page: apps.",
      "- [info] Nextcloud's backups were never test-restored By hand: Open Backups and verify one.",
      "Not checked this time: USB history (needs an operator).",
    ].join("\n"));
    expect(describeRepair({ findings: [], counts: { critical: 0, warning: 0, info: 0 } })).toBe("Repair: nothing to fix.");
  });
});

describe("the tools, held to the run's role", () => {
  it("read for the owner, and refuse a viewer the operator's and the owner's reads with a reason", async () => {
    expect(await run("firewall.status")).toMatch(/^Firewall: ufw is installed and on/);
    expect(await run("updates.status", "viewer")).toMatch(/^Package updates waiting: 2 packages/);
    expect(await run("protection.status", "viewer")).toMatch(/^Brute-force protection: fail2ban is installed and running/);
    expect(await run("users.access", "operator")).toMatch(/^2 accounts that can log in/);
    await expect(run("users.access", "viewer")).rejects.toThrow(/needs an operator/);
    expect(await run("tunnel.exposure")).toMatch(/^Cloudflare tunnel boxpilot-testbox/);
    await expect(run("tunnel.exposure", "operator")).rejects.toThrow(/owner's to read/);
    // Repair's scan runs as the run's person: the operator reads only for one who may read as much.
    expect(await run("repair.findings")).not.toMatch(/Not checked this time/);
    expect(await run("repair.findings", "viewer")).toMatch(/Not checked this time: USB history/);
    const bare = createToolRunner({ state: {}, store: { listDocuments: () => [] }, registry, helper });
    await expect(bare.run("repair.findings", {}, { spec: {}, readRole: "owner", readAs: "p" })).rejects.toThrow(/not available here/);
  });

  it("are the tools a request's own words point at", () => {
    const offered = ["firewall.status", "updates.status", "repair.findings", "protection.status", "users.access", "tunnel.exposure", "apps.list"];
    expect(toolsForQuestion("Is the firewall on?", offered)).toEqual(["firewall.status"]);
    expect(toolsForQuestion("Are there security updates waiting, and is a reboot required?", offered)).toEqual(["updates.status"]);
    expect(toolsForQuestion("What does Repair want fixed?", offered)).toEqual(["repair.findings"]);
    expect(toolsForQuestion("Has fail2ban banned anyone?", offered)).toEqual(["protection.status"]);
    expect(toolsForQuestion("Can root log in over SSH?", offered)).toEqual(["users.access"]);
    expect(toolsForQuestion("What is exposed to the internet through the tunnel?", offered)).toEqual(["tunnel.exposure"]);
    for (const id of offered) expect(toolById(id)).toBeTruthy();
  });
});

describe("the templates and the evaluation", () => {
  it("give the Keeper, the Scout and IT Support the new reads, with seeds and golden questions, and add the Security Reviewer", () => {
    // The Keeper gets four: the accounts and the tunnel are the Security Reviewer's, so the Keeper's planner list stays short.
    expect(templateById("server-keeper").spec.tools).toMatchObject({ "firewall.status": "auto", "updates.status": "auto", "repair.findings": "auto", "protection.status": "auto", "users.access": "off", "tunnel.exposure": "off" });
    expect(templateById("environment-scout").spec.tools).toMatchObject({ "firewall.status": "auto", "repair.findings": "auto" });
    expect(templateById("it-support").spec.tools).toMatchObject({ "firewall.status": "auto", "updates.status": "auto", "repair.findings": "auto" });
    expect(templateById("environment-scout").spec.prompt.rules.some((rule) => /cannot see the firewall/.test(rule))).toBe(false);
    expect(templateQuestions["environment-scout"].find((question) => question.id === "firewall")).toMatchObject({ expect: { fact: "firewallEnabled" } });
    const reviewer = templateById("security-reviewer");
    expect(reviewer).toBeTruthy();
    expect(agentTemplates.map((template) => template.id)).toContain("security-reviewer");
    expect(reviewer.spec.tools).toMatchObject({ "firewall.status": "auto", "protection.status": "auto", "users.access": "auto", "tunnel.exposure": "auto" });
    expect(reviewer.spec.triggers.schedule).toMatchObject({ every: "weekly", weekday: 1, quietHours: true });
    expect(seedExamples("security-reviewer", reviewer.spec)).toHaveLength(6);
    const keeperSeeds = seedExamples("server-keeper", templateById("server-keeper").spec).map((seed) => seed.id);
    expect(keeperSeeds).toEqual(expect.arrayContaining(["firewall", "updates", "repair", "banned"]));
    expect(keeperSeeds).not.toContain("exposed");
  });

  it("grades whether the firewall is on, off or missing", () => {
    expect(gradeFact("firewallEnabled", "on", "The firewall (ufw) is on, with incoming denied by default.").passed).toBe(true);
    expect(gradeFact("firewallEnabled", "on", "ufw is installed but not enabled.").passed).toBe(false);
    expect(gradeFact("firewallEnabled", "off", "The firewall is off.").passed).toBe(true);
    expect(gradeFact("firewallEnabled", "off", "ufw is not installed.").passed).toBe(false);
    expect(gradeFact("firewallEnabled", "absent", "There is no host firewall: ufw is not installed.").passed).toBe(true);
    expect(gradeFact("firewallEnabled", null, "on")).toMatchObject({ passed: false });
  });

  it("reads the firewall fact from the server, and a Keeper asked about it answers from firewall.status", async () => {
    const h = await createAgentsHarness();
    try {
      h.enable();
      const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
      h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is the firewall on?" });
      const run = await h.runNext();
      expect(run.state).toBe("completed");
      expect(h.service.getRun(h.caller("owner"), run.id).steps.filter((step) => step.kind === "tool").map((step) => step.name)).toContain("firewall.status");
      expect(gradeFact("firewallEnabled", "on", run.answer).passed).toBe(true);
      // The migration gives an agent made before M47 the template's new tools, once.
      h.service.updateAgent(h.caller("owner"), keeper.id, { spec: { ...h.store.getAgent(keeper.id).spec, tools: { ...h.store.getAgent(keeper.id).spec.tools, "firewall.status": "off", "repair.findings": "off" } } });
      h.state.setSetting("agentsMigrations", { runSeconds: {}, sharing: {}, examples: {} }, { updatedBy: null });
      expect(h.service.migrateDefaults()).toBe(1);
      expect(h.store.getAgent(keeper.id).spec.tools).toMatchObject({ "firewall.status": "auto", "repair.findings": "auto" });
      expect(h.service.migrateDefaults()).toBe(0);
      // A Scout on the five-read survey as the owner's server has it (M43's wording of step two, the
      // M43 budget, M47.1's tools and rule) is widened to the seven-read one by the tools its steps
      // name, not their words; and every templated agent gets the seeds its template gained.
      const scout = h.service.createAgent(h.caller("owner"), { template: "environment-scout" });
      const template = templateById("environment-scout").spec;
      const liveSteps = [
        "Read what is wrong now with alerts.active: failed services and schedules, unhealthy apps, a reboot waiting, disks filling.",
        "Read the drives with storage.health, and the apps with apps.list: stopped, unhealthy or with an update waiting.",
        "Read backups.status for the copies off this server and which apps' backups were test-restored.",
        "Read server.facts for processor load, memory and how long it has been up.",
        "Rank what you found, say what changed since your last survey (in what you remember), and propose cards for the top two with plan.propose.",
      ];
      h.service.updateAgent(h.caller("owner"), scout.id, { spec: { ...template, prompt: { ...template.prompt, steps: liveSteps }, budget: { runsPerDay: 4, modelSecondsPerDay: 1_800, stepsPerRun: 8, tokensPerRun: 16_000, runSeconds: 900 } } });
      for (const example of h.service.examplesOf(h.caller("owner"), keeper.id).examples.filter((entry) => entry.tools.includes("firewall.status"))) h.service.forgetExample(h.caller("owner"), keeper.id, example.id);
      h.state.setSetting("agentsMigrations", { runSeconds: {}, sharing: {}, examples: {}, eyes: {} }, { updatedBy: null });
      expect(h.service.migrateDefaults()).toBeGreaterThanOrEqual(2);
      const widened = h.store.getAgent(scout.id).spec;
      expect(widened.prompt.steps).toEqual(template.prompt.steps);
      expect(widened.budget).toMatchObject({ stepsPerRun: 12, tokensPerRun: 32_000, runSeconds: 1_500, modelSecondsPerDay: 3_000 });
      expect(h.service.getAgent(h.caller("owner"), scout.id).versions[0].note).toMatch(/^BoxPilot widened its weekly survey/);
      expect(h.service.examplesOf(h.caller("owner"), keeper.id).examples.some((entry) => entry.tools.includes("firewall.status"))).toBe(true);
      // Once; and a Scout whose maker rewrote its steps around other tools is left alone.
      expect(h.service.migrateDefaults()).toBe(0);
    } finally {
      await h.close();
    }
  });
});
