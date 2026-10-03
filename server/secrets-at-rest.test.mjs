import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { createFlowService } from "./flows.mjs";
import { createJobService } from "./jobs.mjs";
import { registry } from "./ops/index.mjs";
import { redactionInternals } from "./redaction.mjs";
import { createSchedulerService } from "./scheduler.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { cloudImages } from "./tasks/cloud-images.mjs";

/**
 * M29.1: every operation in the registry, with a sentinel in every place it can carry a secret,
 * pushed through everything that stores parameters - the job record, a schedule, a flow created
 * and a flow edited - and the audit log that records all three. None may hold a sentinel, down to
 * the bytes of the database file and a VACUUM INTO copy of it (what a controller backup writes),
 * while the helper still receives the real value when the job runs.
 *
 * Positions come from the parameter specs, not from secretPaths, so this checks the function
 * rather than repeating it: a field flagged `secret: true` holds a secret, and a `secretEnvOf`
 * field holds the app's own in `env`. An operation that declares a secret needs a fixture below,
 * or this fails and says which.
 */

// Password hashing and approval run at production scrypt cost.
vi.setConfig({ testTimeout: 60_000 });

const clock = () => new Date("2026-09-27T12:00:00.000Z");
const appId = "sentinel-app";
// The stub catalog: the app's manifest calls APP_TOKEN a password, and TZ is an ordinary setting.
const appSecretEnv = ["APP_TOKEN"];
const secretEnvNamesFor = async (id) => (id === appId ? appSecretEnv : null);
const marker = "SENTINEL-";
const sentinelFor = (operationId) => (dotted) => `${marker}${operationId}-${dotted}`;

// Valid parameters for each operation that declares a secret, with `s(path)` in every secret position.
const vpnFields = registry.get("vpn.profile.set").parameters.fields;
const fixtures = {
  "app.compose.edit": (s) => ({ id: appId, compose: s("compose") }),
  "app.install": (s) => ({ id: appId, values: { env: { APP_TOKEN: s("values.env.APP_TOKEN"), TZ: "UTC" } } }),
  "app.reconfigure": (s) => ({ id: appId, values: { env: { APP_TOKEN: s("values.env.APP_TOKEN"), TZ: "UTC" } } }),
  "app.password.set": (s) => ({ id: appId, password: s("password") }),
  "vm.cloud.create": (s) => ({ name: "sentinel-vm", image: Object.keys(cloudImages)[0], vcpus: 1, memoryMiB: 1024, diskGiB: 8, sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyForTestsOnly fixture@example"], password: s("password") }),
  "share.mount": (s) => ({ kind: "smb", host: "nas", share: "Public", name: "nas", username: "jamie", password: s("password") }),
  "samba.user.set": (s) => ({ username: "sam", password: s("password") }),
  "backup.cloud.setup": (s) => ({ provider: "drive", path: "boxpilot", key: s("key"), secretAccessKey: s("secretAccessKey"), password: s("password"), token: s("token") }),
  "router.connect": (s) => ({ kind: "glinet", host: "router.example", password: s("password") }),
  "credentials.set": (s) => ({ name: "sentinel", value: s("value") }),
  // M39.3: the secret is an address, so the sentinel rides inside one.
  "heartbeat.set": (s) => ({ enabled: true, url: `https://hc-ping.example/${s("url")}`, intervalMinutes: 5 }),
  // M42: the owner's Cloudflare API token.
  "cloudflare.connect": (s) => ({ token: s("token") }),
  "vpn.profile.set": (s) => ({ provider: vpnFields.provider.enum[0], type: vpnFields.type.enum[0], wireguardPrivateKey: s("wireguardPrivateKey"), openvpnPassword: s("openvpnPassword") }),
};

/** Where the spec says this operation can carry a secret. */
function declaredPositions(operation) {
  const positions = [];
  for (const [name, field] of Object.entries(operation.parameters?.fields ?? {})) {
    if (field?.secret === true) positions.push([name]);
    if (typeof field?.secretEnvOf === "string") for (const env of appSecretEnv) positions.push([name, "env", env]);
  }
  return positions;
}

/** Where a fixture actually put a sentinel: anywhere in a string, since a secret may be an address. */
function sentinelPositions(value, at = []) {
  if (typeof value === "string") return value.includes(marker) ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => sentinelPositions(item, [...at, index]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => sentinelPositions(item, [...at, key]));
  return [];
}

const readPath = (object, keys) => keys.reduce((node, key) => node?.[key], object);
const secretBearing = registry.list().filter((operation) => declaredPositions(operation).length > 0);

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("secrets at rest, for every operation in the registry (M29.1)", () => {
  it("has a fixture for exactly the operations that declare a secret, filling every position", () => {
    expect(secretBearing.length).toBeGreaterThan(0);
    expect(Object.keys(fixtures).sort()).toEqual(secretBearing.map((operation) => operation.id).sort());
    for (const operation of secretBearing) {
      const parameters = fixtures[operation.id](sentinelFor(operation.id));
      expect(sentinelPositions(parameters).map((keys) => keys.join(".")).sort(), operation.id).toEqual(declaredPositions(operation).map((keys) => keys.join(".")).sort());
      expect(registry.validate(operation.id, parameters), operation.id).toBeNull();
    }
  });

  it("knows every shape a parameter spec can take, so a new way to nest a secret cannot slip past", () => {
    // secretPaths reads `secret` and `secretEnvOf`. A spec key this list does not know may be a new
    // kind of secret: teach secretPaths and this test about it, then add it here.
    const known = new Set(["type", "pattern", "optional", "nullable", "enum", "maxLength", "validate", "secret", "secretEnvOf"]);
    const unknown = registry.list().flatMap((operation) => Object.entries(operation.parameters?.fields ?? {}).flatMap(([name, field]) => Object.keys(field ?? {}).filter((key) => !known.has(key)).map((key) => `${operation.id}.${name}.${key}`)));
    expect(unknown).toEqual([]);
    // A field whose name reads like a credential is either declared secret or named here with why.
    const notSecret = new Map([
      ["accessKeyId", "the S3 access key ID is the public half of the pair; secretAccessKey is the secret"],
      ["credentialName", "names a stored credential; the value stays in the root-owned file"],
      ["credentialHeader", "the header the credential is sent in"],
      ["credentialPrefix", "text such as \"Bearer\" put before the credential"],
    ]);
    const unflagged = registry.list().flatMap((operation) => Object.entries(operation.parameters?.fields ?? {})
      .filter(([name, field]) => redactionInternals.sensitiveKey.test(name) && !field?.secret && !notSecret.has(name))
      .map(([name]) => `${operation.id}.${name}`));
    expect(unflagged).toEqual([]);
  });

  it.each(secretBearing.map((operation) => [operation.id]))("%s: no store holds a secret, and the helper gets them all", async (operationId) => {
    const operation = registry.get(operationId);
    const parameters = fixtures[operationId](sentinelFor(operationId));
    const positions = declaredPositions(operation);
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-secrets-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory, now: clock });
    const published = [];
    const unsubscribe = store.subscribeJobs((job) => published.push(job));
    const received = [];
    const helper = { request: async (requested, sent) => { received.push({ operation: requested, parameters: sent }); return { ok: true }; } };
    try {
      const bootstrap = store.createBootstrapToken();
      const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("correct horse battery") });
      const jobs = createJobService(store, helper, { secretEnvNamesFor, now: () => clock().getTime() });
      const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor, now: clock });
      const flows = createFlowService({ store, jobs, secretEnvNamesFor, now: clock, pollMs: 2 });

      // The job record: every position holds the placeholder; the operation gets the real values.
      const job = await jobs.createOperationJob(operationId, parameters, owner.id);
      for (const keys of positions) expect(readPath(store.getJob(job.id).parameters, keys), keys.join(".")).toBe("[secret]");
      if (operation.parameters.fields.values?.secretEnvOf) expect(store.getJob(job.id).parameters.values.env.TZ).toBe("UTC");   // an ordinary setting stays readable
      const finished = await jobs.approveAndRun(job.id, owner.id, { password: "correct horse battery" });
      expect(finished.state).toBe("completed");
      const call = received.find((entry) => entry.operation === operationId);
      for (const keys of positions) expect(readPath(call.parameters, keys), keys.join(".")).toBe(readPath(parameters, keys));

      // A schedule and a flow, created and edited: all refused (for the secret, or for a risk a
      // secret-bearing operation cannot be scheduled at anyway), and none stored.
      await expect(scheduler.create({ operationId, parameters, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id })).rejects.toThrow();
      await expect(flows.create({ name: "sweep", steps: [{ operationId, parameters }], createdBy: owner.id })).rejects.toThrow();
      const flow = await flows.create({ name: "sweep", steps: [{ operationId: "controller.backup.create", parameters: {} }], createdBy: owner.id });
      await expect(flows.update(flow.id, { steps: [{ operationId, parameters }] }, owner.id)).rejects.toThrow();

      const answers = {
        jobs: store.listJobs(200), published, schedules: store.listSchedules(), scheduleList: scheduler.list(),
        flows: store.listFlows(), flowList: await flows.list(), audit: store.listAudit(200),
      };
      for (const [where, answer] of Object.entries(answers)) expect(JSON.stringify(answer), where).not.toContain(marker);
    } finally {
      unsubscribe();
      store.close();
    }

    // The bytes on disk, and the copy a controller backup makes of them (VACUUM INTO).
    const copy = path.join(directory, "controller-backup-copy.sqlite3");
    const database = new DatabaseSync(store.databasePath);
    try { database.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); } finally { database.close(); }
    for (const name of await readdir(directory)) {
      expect((await readFile(path.join(directory, name))).includes(marker), name).toBe(false);
    }
  });
});

/**
 * M29.3: the same fixtures, every secret-bearing operation in one controller database, and the
 * backup written by the controller-backup helper itself rather than a copy made here. Each
 * operation has one job that ran and one still awaiting approval, its secrets staged in this
 * process's memory while the backup is written: the transient state M29.3 is about. Schedules and
 * flows are attempted with them too. Approving the waiting jobs afterwards proves the secrets were
 * really held, so a clean backup means they were kept out, not that they were never there.
 */
describe("controller backups hold no transient operation secret (M29.3)", () => {
  const password = "correct horse battery";
  const backupId = "29290003-0000-4000-8000-000000000003";

  async function filesUnder(root) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  }

  async function expectNoSentinel(files) {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect((await readFile(file)).includes(marker), file).toBe(false);
  }

  async function stageEverything() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-backup-secrets-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: path.join(directory, "state"), now: clock });
    const received = [];
    const helper = { request: async (operation, parameters) => { received.push({ operation, parameters }); return { ok: true }; } };
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword(password) });
    const jobs = createJobService(store, helper, { secretEnvNamesFor, now: () => clock().getTime() });
    const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor, now: clock });
    const flows = createFlowService({ store, jobs, secretEnvNamesFor, now: clock, pollMs: 2 });
    const flow = await flows.create({ name: "sweep", steps: [{ operationId: "controller.backup.create", parameters: {} }], createdBy: owner.id });
    const waiting = [];
    for (const operation of secretBearing) {
      // Distinct values for the job that runs now and the one left waiting, in every position.
      const ran = fixtures[operation.id](sentinelFor(`${operation.id}/ran`));
      const staged = fixtures[operation.id](sentinelFor(`${operation.id}/staged`));
      const job = await jobs.createOperationJob(operation.id, ran, owner.id);
      expect((await jobs.approveAndRun(job.id, owner.id, { password })).state, operation.id).toBe("completed");
      waiting.push({ operation, parameters: staged, job: await jobs.createOperationJob(operation.id, staged, owner.id) });
      await expect(scheduler.create({ operationId: operation.id, parameters: staged, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id }), operation.id).rejects.toThrow();
      await expect(flows.create({ name: "sweep", steps: [{ operationId: operation.id, parameters: staged }], createdBy: owner.id }), operation.id).rejects.toThrow();
      await expect(flows.update(flow.id, { steps: [{ operationId: operation.id, parameters: staged }] }, owner.id), operation.id).rejects.toThrow();
    }
    expect(received).toHaveLength(secretBearing.length);
    return { directory, store, jobs, owner, waiting, received };
  }

  /** Approve the jobs left waiting: the helper must get every staged value, from memory. */
  async function approveWaiting({ jobs, owner, waiting, received }) {
    for (const { operation, parameters, job } of waiting) {
      const before = received.length;
      expect((await jobs.approveAndRun(job.id, owner.id, { password })).state, operation.id).toBe("completed");
      const call = received[before];
      expect(call.operation).toBe(operation.id);
      for (const keys of declaredPositions(operation)) expect(readPath(call.parameters, keys), `${operation.id} ${keys.join(".")}`).toBe(readPath(parameters, keys));
    }
  }

  it("stages them all into a database the backup helper accepts, with none in its bytes", async () => {
    const staged = await stageEverything();
    const { directory, store, waiting } = staged;
    try {
      for (const { job } of waiting) expect(store.getJob(job.id).state).toBe("awaiting_approval");
      // The helper's own preflight, which createBackup runs before it copies anything.
      const helper = createControllerBackupHelper({ sourceDatabasePath: store.databasePath, backupRoot: path.join(directory, "backups"), restoreDrillRoot: path.join(directory, "drills"), now: clock });
      await helper.initialize();
      await expect(helper.inspect()).resolves.toMatchObject({ healthy: true, state: "ready", journalAwareSnapshot: "sqlite-vacuum-into" });
      // The live database, its WAL and shared-memory index: what VACUUM INTO reads from.
      await expectNoSentinel(await filesUnder(path.join(directory, "state")));
      await approveWaiting(staged);
    } finally {
      store.close();
    }
  });

  // Linux only: the helper fsyncs the finished artifact through a read-only handle, which Windows
  // refuses. The test above runs the same staging and the helper's preflight everywhere.
  it.skipIf(onWindows)("writes a controller backup through the helper with none of them in the artifact, the manifest or the drill", async () => {
    const staged = await stageEverything();
    const { directory, store, waiting } = staged;
    const backupRoot = path.join(directory, "managed", "backups", "boxpilot-controller");
    const restoreDrillRoot = path.join(directory, "managed", "controller-restore-drills");
    try {
      const helper = createControllerBackupHelper({ sourceDatabasePath: store.databasePath, backupRoot, restoreDrillRoot, now: clock });
      await helper.initialize();
      const result = await helper.createBackup({ backupId });
      expect(result).toMatchObject({ backupId, snapshotMethod: "sqlite-vacuum-into", restoreDrill: { passed: true, workspaceRemoved: true } });

      // Everything the backup wrote: the artifact and its manifest. The drill copy is removed on
      // success; anything left in its root is scanned too.
      const written = [...await filesUnder(backupRoot), ...await filesUnder(restoreDrillRoot)];
      expect(written.map((file) => path.relative(backupRoot, file)).sort()).toEqual([path.join(backupId, "boxpilot.sqlite3"), path.join(backupId, "manifest.json")].sort());
      await expectNoSentinel(written);

      // The copy is not empty of the jobs that carried them: each waiting job is in it, still
      // waiting, with the placeholder in every secret position.
      const copy = new DatabaseSync(result.artifactPath, { readOnly: true });
      try {
        for (const { operation, job } of waiting) {
          const row = copy.prepare("SELECT state, parameters_json FROM jobs WHERE id = ?").get(job.id);
          expect(row?.state, operation.id).toBe("awaiting_approval");
          const parameters = JSON.parse(row.parameters_json);
          for (const keys of declaredPositions(operation)) expect(readPath(parameters, keys), `${operation.id} ${keys.join(".")}`).toBe("[secret]");
        }
        expect(Number(copy.prepare("SELECT COUNT(*) AS count FROM jobs").get().count)).toBe(2 * secretBearing.length);
      } finally {
        copy.close();
      }

      await approveWaiting(staged);
    } finally {
      store.close();
    }
  });
});
