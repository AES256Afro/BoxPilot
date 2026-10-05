// @vitest-environment node
/**
 * A card's steps and the jobs that came of them (2026-10 sweep 3). Which step was staged as which
 * job is kept on the server, so a card drawn again - another tab, the page left and come back to,
 * a reload - still knows, and a card is decided when every step's job is approved, wherever it was
 * approved: its own dialog, a push, Activity, Today. Before, only the dialog that staged a step
 * remembered it, and only that dialog could decide the card.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { createJobService } from "../jobs.mjs";
import { agentsRuntimeKey, defaultRuntimeSettings } from "./service.mjs";

let h;
let jobs;
let stop = null;
beforeEach(async () => {
  h = await createAgentsHarness();
  jobs = createJobService(h.state, h.helper);
  h.helperAnswers["agents.model.download"] = () => ({ downloaded: true });
  h.helperAnswers["agents.model.switch"] = () => ({ repo: "unsloth/Qwen3.6-4B-GGUF", file: "Qwen3.6-4B-UD-Q4_K_XL.gguf" });
  h.helperAnswers["apt.refresh"] = () => ({ refreshed: true });
});
afterEach(async () => { stop?.(); stop = null; await h.close(); });

const thrown = async (fn) => { try { await fn(); } catch (error) { return error; } return null; };
const owner = () => h.caller("owner");

/** BoxPilot's own two-step card: download a newer Qwen, then switch agents to it. */
async function modelCard() {
  h.enable();
  h.state.setSetting(agentsRuntimeKey, defaultRuntimeSettings());
  h.newerListing.value = [{ id: "unsloth/Qwen3.6-4B-GGUF" }];
  await h.service.checkForNewerModel();
  const [card] = h.service.listProposals(owner()).filter((entry) => entry.source === "runtime");
  expect(card.steps.map((step) => step.operationId)).toEqual(["agents.model.download", "agents.model.switch"]);
  return card;
}

/** An agent's one-step card, asked for by the owner. */
async function agentCard() {
  h.enable();
  const agent = h.service.createAgent(owner(), { template: "server-keeper" });
  h.fake.state.script = (body) => (body.messages.some((message) => message.role === "tool") ? { content: "Proposed [T1]." } : { toolCalls: [{ name: "plan_propose", arguments: { title: "Refresh", reason: "Lists are old", steps: [{ operationId: "apt.refresh", parameters: {} }] } }] });
  h.service.startRun(owner(), agent.id, { kind: "ask", question: "Are the package lists fresh?" });
  await h.runNext();
  const [card] = h.service.listProposals(owner()).filter((entry) => entry.kind === "plan");
  return card;
}

const stageFor = (card, index, role = "owner") => jobs.createOperationJob(card.steps[index].operationId, card.steps[index].parameters, h.accounts[role].id, { role });
const record = (card, index, job, role = "owner") => h.service.stageProposalStep(h.caller(role), card.id, index, { jobId: job.id });

describe("a card's staged steps", () => {
  it("are kept on the server, so a card read again still knows a step is waiting and offers it once", async () => {
    const card = await modelCard();
    expect(card.steps.map((step) => step.status)).toEqual(["ready", "ready"]);
    const download = await stageFor(card, 0);
    const recorded = record(card, 0, download);
    expect(recorded.state).toBe("open");
    expect(recorded.steps[0]).toMatchObject({ jobId: download.id, jobState: "awaiting_approval", status: "waiting" });
    expect(recorded.steps[1]).toMatchObject({ jobId: null, jobState: null, status: "ready" });
    // Read again, as a tab switched back to, the page come back to, or a reload would.
    const [again] = h.service.listProposals(owner()).filter((entry) => entry.id === card.id);
    expect(again.steps[0]).toMatchObject({ jobId: download.id, status: "waiting" });
    expect(h.service.getProposal(owner(), card.id).steps[0]).toMatchObject({ jobId: download.id, status: "waiting" });
    // A second download for the same step, while the first waits, is refused: it would run twice.
    const twice = await stageFor(card, 0);
    expect(await thrown(() => record(card, 0, twice))).toMatchObject({ status: 409, code: "step_staged" });
    // The same job again is no change.
    expect(record(card, 0, download).steps[0]).toMatchObject({ jobId: download.id, status: "waiting" });
    expect(h.state.listAudit(50).filter((event) => event.type === "agents.proposal.step-staged")).toHaveLength(1);
  });

  it("can be staged again once its job was cancelled, but not while it waits or after it was approved", async () => {
    const card = await modelCard();
    const first = await stageFor(card, 0);
    record(card, 0, first);
    jobs.cancelJob(first.id, h.accounts.owner.id);
    expect(h.service.getProposal(owner(), card.id).steps[0]).toMatchObject({ jobId: first.id, jobState: "cancelled", status: "ready" });
    const second = await stageFor(card, 0);
    expect(record(card, 0, second).steps[0]).toMatchObject({ jobId: second.id, status: "waiting" });
    await jobs.approveAndRun(second.id, h.accounts.owner.id, {});
    expect(h.service.getProposal(owner(), card.id).steps[0]).toMatchObject({ jobId: second.id, jobState: "completed", status: "approved" });
    const third = await stageFor(card, 0);
    expect(await thrown(() => record(card, 0, third))).toMatchObject({ status: 409, code: "step_staged" });
  });

  it("says a step may be staged again when its approved job never started", async () => {
    const card = await modelCard();
    const download = await stageFor(card, 0);
    record(card, 0, download);
    h.state.transitionJob(download.id, "awaiting_approval", "applying");
    h.state.transitionJob(download.id, "applying", "failed", { error: "Waited behind other work", timeout: { phase: "queued", scope: "operation", budgetMs: 1000, elapsedMs: 1000 } });
    expect(h.service.getProposal(owner(), card.id).steps[0]).toMatchObject({ jobState: "failed", status: "ready" });
  });

  it("refuses a job that is not the caller's, not this step's, or not a job; and a card the caller may not see", async () => {
    const card = await modelCard();
    const download = await stageFor(card, 0);
    // The switch's job named against the download, and a download of another file.
    const switching = await stageFor(card, 1);
    expect(await thrown(() => record(card, 0, switching))).toMatchObject({ status: 409, code: "job_mismatch" });
    const other = await jobs.createOperationJob("agents.model.download", { ...card.steps[0].parameters, file: "Qwen3.6-4B-Q8_0.gguf" }, h.accounts.owner.id, { role: "owner" });
    expect(await thrown(() => record(card, 0, other))).toMatchObject({ status: 409, code: "job_mismatch" });
    expect(await thrown(() => h.service.stageProposalStep(owner(), card.id, 0, { jobId: "0f8fad5b-d9cb-469f-a165-70867728950e" }))).toMatchObject({ status: 404, code: "job_not_found" });
    expect(await thrown(() => h.service.stageProposalStep(owner(), card.id, 0, { jobId: "not a job" }))).toMatchObject({ status: 400 });
    expect(await thrown(() => h.service.stageProposalStep(owner(), card.id, 2, { jobId: download.id }))).toMatchObject({ status: 404, code: "step_not_found" });
    // BoxPilot's own card is the owner's: nobody else may see it, so nobody else may stage it.
    expect(await thrown(() => record(card, 0, download, "operator"))).toMatchObject({ status: 404, code: "proposal_not_found" });
    expect(await thrown(() => record(card, 0, download, "viewer"))).toMatchObject({ status: 403 });
    expect(await thrown(() => h.service.getProposal(h.caller("operator"), card.id))).toMatchObject({ status: 404 });
    expect(await thrown(() => h.service.getProposal(h.caller("viewer"), card.id))).toMatchObject({ status: 404 });
    // Its own job, for its own step, by the person who staged it, is taken.
    record(card, 0, download);
    expect(h.service.getProposal(owner(), card.id).steps.map((step) => step.status)).toEqual(["waiting", "ready"]);
  });

  it("refuses a job someone else staged, even for the same operation and settings", async () => {
    const card = await agentCard();
    const operators = await jobs.createOperationJob("apt.refresh", {}, h.accounts.operator.id, { role: "operator" });
    expect(await thrown(() => record(card, 0, operators))).toMatchObject({ status: 404, code: "job_not_found" });
    expect(h.service.getProposal(owner(), card.id).steps[0]).toMatchObject({ jobId: null, status: "ready" });
  });
});

describe("a card decided by the server", () => {
  it("is decided once every step's job is approved through the jobs API, with no card dialog involved", async () => {
    const card = await modelCard();
    stop = h.service.start({ subscribeJobs: (listener) => h.state.subscribeJobs(listener) });
    const download = await stageFor(card, 0);
    const switching = await stageFor(card, 1);
    record(card, 0, download);
    record(card, 1, switching);
    // Approved from a push, Activity or Today: the jobs API, not the card.
    await jobs.approveAndRun(download.id, h.accounts.owner.id, {});
    await Promise.resolve();
    expect(h.store.getProposal(card.id).state).toBe("open");
    await jobs.approveAndRun(switching.id, h.accounts.owner.id, {});
    await Promise.resolve();
    // Decided as the job changed, before anyone read the card again.
    expect(h.store.getProposal(card.id)).toMatchObject({ state: "staged", decidedBy: h.accounts.owner.id, jobIds: [download.id, switching.id] });
    expect(h.state.listAudit(50).find((event) => event.type === "agents.proposal.decided")).toMatchObject({ subjectId: card.id, details: { decision: "staged", jobs: 2 } });
    expect(h.service.listProposals(owner()).find((entry) => entry.id === card.id)).toBeUndefined();
    expect(h.service.getProposal(owner(), card.id).steps.map((step) => step.status)).toEqual(["approved", "approved"]);
    // Recording that same job again (the dialog's own approval arriving late) is no change and no error.
    expect(record(card, 1, switching)).toMatchObject({ state: "staged" });
    const late = await stageFor(card, 0);
    expect(await thrown(() => record(card, 0, late))).toMatchObject({ status: 409, code: "proposal_decided" });
  });

  it("is decided when the card is next read, if the job's approval was not heard", async () => {
    const card = await agentCard();
    const job = await stageFor(card, 0);
    record(card, 0, job);
    await jobs.approveAndRun(job.id, h.accounts.owner.id, {});
    expect(h.store.getProposal(card.id).state).toBe("open");
    expect(h.service.listProposals(owner()).find((entry) => entry.id === card.id)).toBeUndefined();
    expect(h.store.getProposal(card.id)).toMatchObject({ state: "staged", jobIds: [job.id] });
  });

  it("is not decided while a step waits, or a step was never staged", async () => {
    const card = await modelCard();
    stop = h.service.start({ subscribeJobs: (listener) => h.state.subscribeJobs(listener) });
    // Only the switch staged and approved: the download is still to do, so the card stays open.
    const switching = await stageFor(card, 1);
    record(card, 1, switching);
    await jobs.approveAndRun(switching.id, h.accounts.owner.id, {});
    await Promise.resolve();
    const shown = h.service.getProposal(owner(), card.id);
    expect(shown.state).toBe("open");
    expect(shown.steps.map((step) => step.status)).toEqual(["ready", "approved"]);
    const download = await stageFor(card, 0);
    record(card, 0, download);
    expect(h.service.getProposal(owner(), card.id).state).toBe("open");
    await jobs.approveAndRun(download.id, h.accounts.owner.id, {});
    await Promise.resolve();
    expect(h.store.getProposal(card.id).state).toBe("staged");
  });

  it("still lets a person dismiss a card, or mark it staged, with the decide route", async () => {
    const card = await agentCard();
    expect(h.service.decideProposal(owner(), card.id, { decision: "dismissed" })).toMatchObject({ state: "dismissed" });
  });
});
