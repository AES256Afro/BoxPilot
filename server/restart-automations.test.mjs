// @vitest-environment node
/**
 * BoxPilot restarting itself under a running automation (sweep 5, R5B2-1).
 *
 * The drained restart after the night's package update waits only for the helper's lanes. An
 * automation holds none between two steps, so the restart began the moment its backup step ended,
 * and the next step - the off-box copy - was refused "BoxPilot is restarting" and the automation
 * stopped there. When the web side restarted too, the runner died with it, and the automations that
 * run after it never started.
 *
 * Driven with the real store, job layer, flow runner, helper lanes and drained restart. The helper
 * is helper-server.mjs's dispatch in small: its refusal goes over the wire as the web side reads it,
 * and a restart of the helper or the web unit replaces that process.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlowService } from "./flows.mjs";
import { createLaneQueues, laneFor } from "./helper-lanes.mjs";
import { createHelperResponseReader, helperErrorReply } from "./helper-response.mjs";
import { createJobService } from "./jobs.mjs";
import { createDrainedRestart, restartRefusalError } from "./self-restart.mjs";
import { createStateStore } from "./state.mjs";

vi.setConfig({ testTimeout: 20_000 });

const directories = [];
const closers = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* closed already */ } }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const forever = () => new Promise(() => {});

async function databaseFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restart-flows-"));
  directories.push(directory);
  return path.join(directory, "boxpilot.sqlite3");
}

function openStore(databasePath) {
  const store = createStateStore({ databasePath });
  closers.push(() => store.close());
  return store;
}

/** An error as the web side reads it from the helper's reply. */
function overTheWire(error) {
  try { createHelperResponseReader("request").push(`${JSON.stringify(helperErrorReply("request", error))}\n`); } catch (thrown) { return thrown; }
  return error;
}

/**
 * One helper process: helper-server.mjs's dispatch of a change, with its real lanes and drained
 * restart. While the restart is under way a change is refused unstarted, as the real one refuses it.
 * `restart(units)` is what systemd-run's restart does.
 */
function helperProcess({ ops, restart }) {
  const lanes = createLaneQueues();
  let restarting = false;
  const selfRestart = createDrainedRestart({ lanes, graceMs: 30, sleep: wait, log: () => {}, run: async (_binary, args) => restart(args.slice(args.indexOf("restart") + 1)), onRestarting: (active) => { restarting = active; } });
  async function request(operation, parameters = {}) {
    if (operation === "job.output.release") return {};
    if (operation === "system.runtime.inspect") return { selfRestart: selfRestart.status() };
    try {
      if (restarting) throw restartRefusalError();
      return await lanes.run(laneFor(operation, parameters), () => ops[operation](parameters));
    } catch (error) {
      throw overTheWire(error);
    }
  }
  return { request, selfRestart };
}

/**
 * The helper's socket as one web process sees it: whichever helper process is listening, or none
 * (between a helper restart's stop and start). A web process that was stopped hears nothing more.
 */
function helperSocket() {
  let current = null;
  const sockets = {
    get current() { return current; },
    listen(helper) { current = helper; },
    /** The client one web process holds. */
    client() {
      let stopped = false;
      return {
        stop: () => { stopped = true; },
        invalidate: () => {},
        async request(operation, parameters, options) {
          if (stopped) return forever();
          if (!current) throw Object.assign(new Error("Helper unavailable: connect ENOENT /run/boxpilot/helper.sock"), { code: "helper_unavailable" });
          const answer = await current.request(operation, parameters, options);
          return stopped ? forever() : answer;
        },
      };
    },
  };
  return sockets;
}

/** A web process's store that stops answering when the process is stopped: nothing it does after counts. */
function stoppable(store) {
  let stopped = false;
  const proxy = new Proxy(store, { get(target, key) {
    const value = target[key];
    if (typeof value !== "function") return value;
    return (...args) => { if (stopped) throw new Error("This web process was stopped"); return value.apply(target, args); };
  } });
  return { store: proxy, stop: () => { stopped = true; } };
}

/** One web process: its job layer and flow runner, over its own store and its client of the helper. */
function webProcess(store, helper) {
  const jobs = createJobService(store, helper, { helperPollMs: 5 });
  const flows = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2, report: () => {} });
  return { jobs, flows };
}

const backUp = { operationId: "controller.backup.create", parameters: {} };
const copyOff = { operationId: "backup.sync", parameters: {} };
const queueSteps = (store, jobId) => store.getJob(jobId).steps.filter((step) => step.name === "queue").map((step) => step.detail);

describe("an automation BoxPilot restarts under (sweep 5)", () => {
  it("sends its next step again once a restarted helper is back, so the copy is made and the automation after it runs", async () => {
    const store = openStore(await databaseFile());
    const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "owner", passwordHash: "not-checked-here" });
    const socket = helperSocket();
    let copies = 0;
    let tidied = 0;
    let releaseBackup = null;
    const ops = {
      "controller.backup.create": () => new Promise((resolve) => { releaseBackup = () => resolve({ backup: "boxpilot-1.sqlite3" }); }),
      "backup.sync": () => { copies += 1; return { copied: 3 }; },
      "apt.refresh": () => { tidied += 1; return {}; },
    };
    // A helper restart: this process stops, and a new one listens a moment later.
    const restart = async () => { socket.listen(null); await wait(40); socket.listen(helperProcess({ ops, restart })); return forever(); };
    socket.listen(helperProcess({ ops, restart }));
    const { flows } = webProcess(store, socket.client());
    const flow = await flows.create({ name: "Belt and braces", steps: [backUp, copyOff], createdBy: owner.id });
    const after = await flows.create({ name: "Tidy up after", steps: [{ operationId: "apt.refresh", parameters: {} }], createdBy: owner.id, triggerFlowId: flow.id });

    const ran = flows.run(flow.id, owner.id, { role: "owner" });
    await vi.waitFor(() => expect(releaseBackup).toBeTypeOf("function"));
    // KVM was installed beside it and asked for the helper to restart: that waits for the backup.
    expect(socket.current.selfRestart.request(["boxpilot-helper.service"], { reason: "KVM was installed" })).toBe(true);
    releaseBackup();
    await expect(ran).resolves.toMatchObject({ completed: true });

    expect(store.getFlow(flow.id).lastResult).toBe("completed");
    expect(copies).toBe(1);
    const copyJob = store.getJob(store.getFlow(flow.id).lastJobIds[1]);
    expect(copyJob.state).toBe("completed");
    // Turned away while BoxPilot restarted, then sent again once it was back.
    expect(queueSteps(store, copyJob.id)).toEqual(["BoxPilot is restarting, so this has not started; it is sent again once BoxPilot is back", "Sent again now that BoxPilot is back"]);
    // The automation that runs after it ran.
    expect(store.getFlow(after.id).lastResult).toBe("completed");
    expect(tidied).toBe(1);
  });

  /**
   * The night's run in one web process, stopped by a restart of both units the moment its backup
   * step ended; then the next web process starting on the same database. `steps` after the backup.
   */
  async function stoppedBetweenSteps(steps) {
    const databasePath = await databaseFile();
    const socket = helperSocket();
    const counts = { copies: 0, tidied: 0, upgrades: 0 };
    let releaseBackup = null;
    const ops = {
      "controller.backup.create": () => new Promise((resolve) => { releaseBackup = () => resolve({ backup: "boxpilot-1.sqlite3" }); }),
      "backup.sync": () => { counts.copies += 1; return { copied: 3 }; },
      "apt.refresh": () => { counts.tidied += 1; return {}; },
      "apt.upgrade": () => { counts.upgrades += 1; return {}; },
    };
    const before = stoppable(openStore(databasePath));
    const owner = before.store.consumeBootstrapToken(before.store.createBootstrapToken().token, { username: "owner", passwordHash: "not-checked-here" });
    const client = socket.client();
    let copyJobId = null;
    // A restart of both units: systemd stops the web side, then the helper. The web side had
    // recorded the copy as waiting for BoxPilot to come back; it never heard more.
    const restart = async () => {
      await vi.waitFor(() => { copyJobId = before.store.getFlow(flow.id).lastJobIds[1]; expect(queueSteps(before.store, copyJobId)).toHaveLength(1); });
      before.stop();
      client.stop();
      socket.listen(null);
      return forever();
    };
    socket.listen(helperProcess({ ops, restart }));
    const night = webProcess(before.store, client);
    const flow = await night.flows.create({ name: "Belt and braces", steps: [backUp, ...steps], createdBy: owner.id });
    const after = await night.flows.create({ name: "Tidy up after", steps: [{ operationId: "apt.refresh", parameters: {} }], createdBy: owner.id, triggerFlowId: flow.id });
    void night.flows.run(flow.id, owner.id, { role: "owner" }).catch(() => {});
    await vi.waitFor(() => expect(releaseBackup).toBeTypeOf("function"));
    // The night's package update ended and asked for both units to restart.
    socket.current.selfRestart.request(["boxpilot.service", "boxpilot-helper.service"], { reason: "it is running libraries the package change replaced" });
    releaseBackup();
    await vi.waitFor(() => expect(copyJobId).not.toBeNull());
    await wait(20);

    // The next web process, and a helper that is listening again a moment after it starts.
    const store = openStore(databasePath);
    setTimeout(() => socket.listen(helperProcess({ ops, restart: forever })), 40);
    const interrupted = store.recoverInterruptedJobs();
    const morning = webProcess(store, socket.client());
    return { store, flow, after, counts, copyJobId, interrupted, morning };
  }

  it("goes on from the step that never began when the web side restarted too, once, and the automation after it runs", async () => {
    const { store, flow, after, counts, copyJobId, interrupted, morning } = await stoppedBetweenSteps([copyOff]);
    expect(interrupted).toEqual([expect.objectContaining({ id: copyJobId, neverStarted: true })]);
    expect(morning.flows.recover(interrupted)).toBe(1);
    await morning.flows.resumed();

    expect(store.getFlow(flow.id).lastResult).toBe("completed (resumed at step 2 after BoxPilot restarted)");
    expect(counts.copies).toBe(1);
    const [backedUp, copied] = store.getFlow(flow.id).lastJobIds.map((jobId) => store.getJob(jobId));
    expect(backedUp.state).toBe("completed");
    expect(copied).toMatchObject({ state: "completed", type: "op:backup.sync" });
    expect(copied.id).not.toBe(copyJobId);
    // The step that never began says its automation ran it again.
    expect(store.getJob(copyJobId).steps.find((step) => step.name === "rerun")).toMatchObject({ state: "started", detail: "BoxPilot restarted before this step began; its automation runs it again." });
    // The automation that runs after it ran.
    expect(store.getFlow(after.id).lastResult).toBe("completed");
    expect(counts.tidied).toBe(1);
    expect(store.listAudit().some((event) => event.type === "flow.resumed" && event.subjectId === flow.id)).toBe(true);
  });

  it("is resumed only once: a second restart in the resumed run leaves it interrupted", async () => {
    const { store, flow, interrupted } = await stoppedBetweenSteps([copyOff]);
    // As the resumed run would have said it, had BoxPilot restarted again before step 2 began.
    store.markFlowRun(flow.id, { result: "running step 2 of 2 (Copy backups to the backup drive), resumed after BoxPilot restarted", jobIds: store.getFlow(flow.id).lastJobIds });
    const { flows } = webProcess(store, { request: async () => ({}), invalidate: () => {} });
    flows.recover(interrupted);
    await flows.resumed();
    expect(store.getFlow(flow.id).lastResult).toBe("interrupted by a BoxPilot restart before step 2 (Copy backups to the backup drive) began, so nothing ran for step 2 or after it. It was not run on from there: it had already been resumed once after a restart");
  });

  it("is not run on where a step still to run can restart BoxPilot: it says nothing ran for the step that never began", async () => {
    const { store, flow, after, counts, interrupted, morning } = await stoppedBetweenSteps([copyOff, { operationId: "apt.upgrade", parameters: {} }]);
    morning.flows.recover(interrupted);
    await morning.flows.resumed();
    expect(store.getFlow(flow.id).lastResult).toBe("interrupted by a BoxPilot restart before step 2 (Copy backups to the backup drive) began, so nothing ran for step 2 or after it. It was not run on from there: step 3 (Install package updates) can restart BoxPilot");
    expect(counts).toEqual({ copies: 0, tidied: 0, upgrades: 0 });
    expect(store.getFlow(after.id).lastResult).toBeNull();
  });
});
