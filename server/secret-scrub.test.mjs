import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { createFlowService } from "./flows.mjs";
import { createJobService } from "./jobs.mjs";
import { createSchedulerService } from "./scheduler.mjs";
import { scrubStoredSecrets } from "./secret-scrub.mjs";
import { createStateStore } from "./state.mjs";

/**
 * M29.3: rows written before secrets were refused (M29.1) still held them in clear. These are
 * written straight into the store, as older versions wrote them: an app's token in values.env, a
 * numeric one, a password a schedule kept and a flow step that carried one.
 */

const clock = () => new Date("2026-09-28T12:00:00.000Z");
const appId = "sentinel-app";
// The catalog: the app's manifest calls APP_TOKEN a password; TZ is an ordinary setting.
const catalog = async (id) => (id === appId ? ["APP_TOKEN"] : null);
const legacy = "LEGACY-";
const legacyPin = 29290003112233; // values.env takes numbers, and a PIN is one
const share = (password) => ({ kind: "smb", host: "nas", share: "Public", name: "nas", username: "jamie", password });
const app = (token) => ({ id: appId, values: { env: { APP_TOKEN: token, TZ: "UTC" } } });
const masked = { id: appId, values: { env: { APP_TOKEN: "[secret]", TZ: "UTC" } } };
const nothingMasked = { jobs: 0, schedules: 0, flows: 0, secrets: 0 };

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function legacyStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-secret-scrub-"));
  directories.push(directory);
  const writer = createStateStore({ stateDirectory: directory, now: clock });
  const bootstrap = writer.createBootstrapToken();
  const owner = writer.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: "not-used" });
  const job = (operationId, parameters, { finished = true } = {}) => {
    const { id } = writer.createJob({ type: `op:${operationId}`, title: operationId, risk: "medium", parameters, createdBy: owner.id });
    if (finished) {
      writer.transitionJob(id, "awaiting_approval", "applying");
      writer.transitionJob(id, "applying", "completed", { result: {} });
    }
    return id;
  };
  const schedule = (operationId, parameters, nextDueAt) => writer.createSchedule({ operationId, parameters, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt }).id;
  const rows = {
    jobs: {
      token: job("app.reconfigure", app(`${legacy}job-token`)),
      pin: job("app.install", app(legacyPin)),
      // Left waiting by a restart: whatever was staged in memory went with it.
      waiting: job("share.mount", share(`${legacy}job-password`), { finished: false }),
      clean: job("controller.backup.create", {}),
    },
    schedules: {
      share: schedule("share.mount", share(`${legacy}schedule-password`), "2026-09-28T03:00:00.000Z"),
      app: schedule("app.reconfigure", app(`${legacy}schedule-token`), "2026-09-28T03:00:00.000Z"),
      clean: schedule("controller.backup.create", {}, "2026-09-29T03:00:00.000Z"),
    },
    flows: {
      steps: writer.createFlow({ name: "legacy steps", createdBy: owner.id, steps: [
        // As long as a real API token: the shorter placeholder leaves most of the old row's bytes behind.
        { operationId: "credentials.set", parameters: { name: "ntfy", value: `${legacy}flow-credential-${"k".repeat(320)}` } },
        { operationId: "app.reconfigure", parameters: app(`${legacy}flow-token`) },
      ] }).id,
      nightly: writer.createFlow({ name: "legacy nightly", createdBy: owner.id, steps: [{ operationId: "share.mount", parameters: share(`${legacy}flow-password`) }], frequency: "daily", minute: 0, hour: 3, nextDueAt: "2026-09-28T03:00:00.000Z" }).id,
    },
  };
  // Written by an earlier run, as they were: closing checkpoints them into the database file
  // itself, where an UPDATE alone would leave the old bytes in the page's free space.
  writer.close();
  const store = createStateStore({ stateDirectory: directory, now: clock });
  return { directory, store, owner, rows };
}

/** What the running server does with these rows: its scheduler and flows, and what it tells the owner. */
async function outcomes({ store, owner, rows }) {
  const announced = [];
  const alerts = { raise: async ({ title, message }) => { announced.push({ title, message }); }, clear: async () => {} };
  const jobs = createJobService(store, { request: async () => ({ ok: true }) }, { secretEnvNamesFor: catalog, now: () => clock().getTime() });
  const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor: catalog, now: clock, alerts });
  const flows = createFlowService({ store, jobs, secretEnvNamesFor: catalog, now: clock, alerts, pollMs: 2, report: () => {} });
  await scheduler.tick();
  await flows.tick();
  const launched = await flows.launch(rows.flows.steps, owner.id).then(() => "started", (error) => error.message);
  return {
    launched,
    schedules: store.listSchedules().map(({ operationId, enabled, lastResult, nextDueAt }) => ({ operationId, enabled, lastResult, nextDueAt })),
    flows: store.listFlows().map(({ name, enabled, lastResult, nextDueAt }) => ({ name, enabled, lastResult, nextDueAt })),
    announced,
    audit: store.listAudit(200).map((event) => event.type).filter((type) => type !== "stored-secrets.masked"),
    jobs: store.listJobs(200).length,
  };
}

async function expectNoLegacyBytes(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const bytes = await readFile(file);
    expect(bytes.includes(legacy), file).toBe(false);
    expect(bytes.includes(String(legacyPin)), file).toBe(false);
  }
}

describe("secrets stored before they were refused (M29.3)", () => {
  it("are masked in jobs, schedules and flows, and a masked schedule or flow is refused exactly as before", async () => {
    const untouched = await legacyStore();
    const scrubbed = await legacyStore();
    try {
      expect(await scrubStoredSecrets({ store: scrubbed.store, secretEnvNamesFor: catalog })).toEqual({ jobs: 3, schedules: 2, flows: 2, secrets: 8, unchecked: 0 });
      const { store, rows } = scrubbed;
      expect(store.getJob(rows.jobs.token).parameters).toEqual(masked);
      expect(store.getJob(rows.jobs.pin).parameters).toEqual(masked);
      expect(store.getJob(rows.jobs.waiting).parameters).toEqual(share("[secret]"));
      expect(store.getJob(rows.jobs.clean).parameters).toEqual({});
      expect(store.getSchedule(rows.schedules.share).parameters).toEqual(share("[secret]"));
      expect(store.getSchedule(rows.schedules.app).parameters).toEqual(masked);
      expect(store.getFlow(rows.flows.steps).steps.map((step) => step.parameters)).toEqual([{ name: "ntfy", value: "[secret]" }, masked]);
      expect(store.getFlow(rows.flows.nightly).steps[0].parameters).toEqual(share("[secret]"));

      // The scheduler pauses both schedules, the flows refuse to run, and the owner hears the same
      // reasons, as they did while the secrets were there.
      const before = await outcomes(untouched);
      const after = await outcomes(scrubbed);
      expect(after).toEqual(before);
      expect(after.schedules.filter((schedule) => !schedule.enabled)).toEqual([
        expect.objectContaining({ operationId: "share.mount", lastResult: "paused: it holds a password, which schedules no longer store" }),
        expect.objectContaining({ operationId: "app.reconfigure", lastResult: "paused: it holds a password, which schedules no longer store" }),
      ]);
      expect(after.launched).toMatch(/^This flow is no longer valid: step 1: .* needs a password or key each time/);
      expect(after.flows.find((flow) => flow.name === "legacy nightly").lastResult).toMatch(/^skipped: This flow is no longer valid: step 1/);
      expect(after.announced.map((alert) => alert.title)).toEqual(expect.arrayContaining([expect.stringMatching(/^Scheduled task paused/), expect.stringMatching(/^Automation did not run: legacy nightly/)]));
      expect(after.jobs).toBe(4);   // nothing ran

      // A job a restart left waiting is refused at approval, rather than run with a stored password.
      const helper = { calls: 0, request: async () => { helper.calls += 1; return { ok: true }; } };
      const jobs = createJobService(store, helper, { secretEnvNamesFor: catalog, now: () => clock().getTime() });
      await expect(jobs.approveAndRun(rows.jobs.waiting, scrubbed.owner.id, {})).rejects.toThrow("no longer available");
      expect(helper.calls).toBe(0);
    } finally {
      untouched.store.close();
      scrubbed.store.close();
    }
  });

  it("records one audit entry with counts only, rewrites nothing a second time, and leaves no old value in the file", async () => {
    const { directory, store, rows } = await legacyStore();
    try {
      await scrubStoredSecrets({ store, secretEnvNamesFor: catalog });
      const rewritten = store.listStoredParameters();
      expect(await scrubStoredSecrets({ store, secretEnvNamesFor: catalog })).toEqual({ ...nothingMasked, unchecked: 0 });
      expect(store.listStoredParameters()).toEqual(rewritten);

      const entries = store.listAudit(200).filter((event) => event.type === "stored-secrets.masked");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorId: null, subjectId: null, details: { jobs: 3, schedules: 2, flows: 2, secrets: 8 } });
      expect(Object.keys(entries[0].details).sort()).toEqual(["flows", "jobs", "schedules", "secrets"]);
      expect(JSON.stringify(store.listAudit(200))).not.toMatch(new RegExp(`${legacy}|${legacyPin}`));

      // A row that changed after the pass read it is left for the next pass.
      expect(store.maskStoredSecrets({ jobs: [{ id: rows.jobs.clean, from: "{\"stale\":true}", to: "{}", secrets: 1 }] })).toEqual(nothingMasked);
      expect(store.listAudit(200).filter((event) => event.type === "stored-secrets.masked")).toHaveLength(1);

      // The old values are gone from the live file, its WAL and index too, not only from the rows.
      await expectNoLegacyBytes(directory);
    } finally {
      store.close();
    }
    await expectNoLegacyBytes(directory);
  });

  it("never touches a job whose secrets are staged in memory", async () => {
    const { store, owner } = await legacyStore();
    const received = [];
    const jobs = createJobService(store, { request: async (operation, parameters) => { received.push({ operation, parameters }); return { ok: true }; } }, { secretEnvNamesFor: catalog, now: () => clock().getTime() });
    try {
      const staged = await jobs.createOperationJob("app.reconfigure", app("STAGED-token"), owner.id);
      const stored = store.getJob(staged.id).parameters;
      expect(stored).toEqual(masked);
      // The catalog cannot name the app's settings now, so every env value counts as a secret: the
      // same pass masks TZ in every record it may touch, but not in this one, whose staged copy
      // would not put it back.
      const counts = await scrubStoredSecrets({ store, secretEnvNamesFor: async () => null, holdsStagedSecrets: jobs.holdsStagedSecrets });
      expect(counts.jobs).toBeGreaterThan(0);
      expect(store.getJob(staged.id).parameters).toEqual(stored);
      expect(store.getSchedule(store.listSchedules().find((schedule) => schedule.operationId === "app.reconfigure").id).parameters.values.env.TZ).toBe("[secret]");

      expect((await jobs.approveAndRun(staged.id, owner.id, {})).state).toBe("completed");
      expect(received).toEqual([{ operation: "app.reconfigure", parameters: app("STAGED-token") }]);
    } finally {
      store.close();
    }
  });

  it("leaves a row it cannot check for the next start", async () => {
    const { store, owner } = await legacyStore();
    try {
      const unreadable = store.createSchedule({ operationId: "app.reconfigure", parameters: { id: "broken", values: { env: { TOKEN: `${legacy}unreadable` } } }, frequency: "daily", minute: 0, hour: 4, createdBy: owner.id, nextDueAt: "2026-09-29T04:00:00.000Z" });
      const failing = async (id) => { if (id === "broken") throw new Error("catalog unreadable"); return catalog(id); };
      expect(await scrubStoredSecrets({ store, secretEnvNamesFor: failing })).toEqual({ jobs: 3, schedules: 2, flows: 2, secrets: 8, unchecked: 1 });
      expect(store.getSchedule(unreadable.id).parameters.values.env.TOKEN).toBe(`${legacy}unreadable`);
      // The next start can read it: an app the catalog does not know has every setting treated as a secret.
      expect(await scrubStoredSecrets({ store, secretEnvNamesFor: catalog })).toEqual({ jobs: 0, schedules: 1, flows: 0, secrets: 1, unchecked: 0 });
      expect(store.getSchedule(unreadable.id).parameters.values.env.TOKEN).toBe("[secret]");
    } finally {
      store.close();
    }
  });

  // Linux only: the controller-backup helper fsyncs the artifact through a read-only handle, which
  // Windows refuses. The live-file check above covers what VACUUM INTO reads, on every platform.
  it.skipIf(onWindows)("are in a controller backup written before the pass, and in none written after", async () => {
    const { directory, store } = await legacyStore();
    const helper = createControllerBackupHelper({ sourceDatabasePath: store.databasePath, backupRoot: path.join(directory, "managed", "backups"), restoreDrillRoot: path.join(directory, "managed", "drills"), now: clock });
    try {
      await helper.initialize();
      const earlier = await helper.createBackup({ backupId: "29290003-0000-4000-8000-00000000000a" });
      expect((await readFile(earlier.artifactPath)).includes(legacy)).toBe(true);
      await scrubStoredSecrets({ store, secretEnvNamesFor: catalog });
      const later = await helper.createBackup({ backupId: "29290003-0000-4000-8000-00000000000b" });
      for (const file of [later.artifactPath, later.manifestPath]) {
        const bytes = await readFile(file);
        expect(bytes.includes(legacy), file).toBe(false);
        expect(bytes.includes(String(legacyPin)), file).toBe(false);
      }
    } finally {
      store.close();
    }
  });
});
