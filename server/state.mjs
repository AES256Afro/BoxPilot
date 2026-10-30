import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAuditStore } from "./state/audit.mjs";
import { createBackupStore } from "./state/backups.mjs";
import { createJobStore } from "./state/jobs.mjs";
import { createOidcClientStore } from "./state/oidc-clients.mjs";
import { createPasskeyStore } from "./state/passkeys.mjs";
import { createPeopleStore } from "./state/people.mjs";
import { createRecoveryCodeStore } from "./state/recovery-codes.mjs";
import { createScheduleFlowStore } from "./state/schedules-flows.mjs";
import { applySchema } from "./state/schema.mjs";
import { createSettingsStore } from "./state/settings.mjs";
import { digest, iso, parseJson } from "./state/shared.mjs";
import { createStoredParameterStore } from "./state/stored-parameters.mjs";
import { createVmLedgerStore } from "./state/vm-ledger.mjs";

const defaultStateDirectory = process.platform === "linux" ? "/var/lib/boxpilot" : path.join(os.tmpdir(), "boxpilot");

/** @param {{ stateDirectory?: string, databasePath?: string, now?: () => Date, tokenBytes?: typeof randomBytes }} [options] */
export function createStateStore({
  stateDirectory = process.env.BOXPILOT_STATE_DIRECTORY ?? defaultStateDirectory,
  databasePath,
  now = () => new Date(),
  tokenBytes = randomBytes,
} = {}) {
  // Create the directory the database actually needs, and nothing else. A caller that says where
  // the database goes has answered the question; also creating the default state directory is work
  // nobody asked for, and on Linux that default is /var/lib/boxpilot, which an unprivileged process
  // cannot create. Tests pass a temp path and were still reaching for it — passing on macOS, where
  // the default lives under the temp dir, and failing on every Linux machine including CI.
  // `:memory:` and `file:` URIs are SQLite's own, not filesystem paths: resolving one turns it into
  // a real file, and an in-memory database needs no directory at all.
  const inMemory = databasePath === ":memory:" || String(databasePath ?? "").startsWith("file:");
  const resolvedDatabasePath = !databasePath
    ? path.join(path.resolve(stateDirectory), "boxpilot.sqlite3")
    : inMemory ? databasePath : path.resolve(databasePath);
  if (!inMemory) mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(resolvedDatabasePath);
  // Every query here used to compile its SQL on each call. The statements are fixed strings,
  // so they are compiled once and reused; `prepare` below is that cache, not the raw method.
  const compiled = new Map();
  const rawPrepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    let statement = compiled.get(sql);
    if (!statement) { statement = rawPrepare(sql); compiled.set(sql, statement); }
    return statement;
  };
  applySchema(database);

  function timestamp() {
    return iso(now());
  }

  // Each domain is its own module under server/state/; a store that calls into another domain is
  // handed that function here, and is built after the store that owns it.
  const context = { database, now, timestamp, tokenBytes };
  const { recordAudit, listAudit } = createAuditStore(context);
  const { getSetting, setSetting, updateSetting } = createSettingsStore(context);
  const {
    ownerCount,
    createBootstrapToken,
    bootstrapTokenUsable,
    consumeBootstrapToken,
    findOwnerByUsername,
    findFirstOwner,
    findOwnerById,
    createOwnerAccount,
    listOwners,
    setOwnerRole,
    disableOwner,
    setOwnerPassword,
    createSession,
    getSession,
    renewSession,
    listSessions,
    revokeSession,
    revokeOtherSessions,
    elevateSession,
    clearSessionElevation,
    deleteSession,
    deleteExpiredSessions,
    forgetTrustedDevices,
  } = createPeopleStore({ ...context, recordAudit, updateSetting });
  const { addPasskey, findPasskeyById, listPasskeys, countPasskeys, anyPasskeys, updatePasskeyUse, renamePasskey, deletePasskey } = createPasskeyStore({ ...context, recordAudit, findOwnerById });
  const { addOidcClient, getOidcClient, listOidcClients, removeOidcClient } = createOidcClientStore({ ...context, recordAudit });
  const { replaceRecoveryCodes, countRecoveryCodes, consumeRecoveryCode } = createRecoveryCodeStore({ ...context, recordAudit, findOwnerById });
  const {
    saveJobOutput,
    getJobOutput,
    subscribeJobs,
    emitJobChanged,
    createJob,
    createPlan,
    getPlan,
    addJobStep,
    addApproval,
    transitionJob,
    getJob,
    listJobs,
    pruneHistory,
    listActiveJobs,
    listAwaitingApproval,
    recoverInterruptedJobs,
  } = createJobStore({ ...context, recordAudit, deleteExpiredSessions });
  const {
    createFlow,
    getFlow,
    listFlows,
    updateFlow,
    markFlowRun,
    listDueFlows, listFlowsTriggeredBy, setFlowWebhook,
    deleteFlow,
    createSchedule,
    getSchedule,
    listSchedules,
    listDueSchedules,
    setScheduleEnabled,
    markScheduleRun,
    settleScheduleRun,
    deleteSchedule,
  } = createScheduleFlowStore({ ...context, recordAudit });
  const {
    recordBackup,
    getBackup,
    listBackups,
    recordControllerBackupProtection,
    getControllerBackupProtection,
    getControllerBackupProtectionByBackup,
    listControllerBackupProtections,
    listAllControllerBackupProtections,
    recordControllerRetention,
    getControllerRetentionRun,
    listControllerRetentionRuns,
  } = createBackupStore({ ...context, recordAudit });
  const {
    recordVmExport,
    listVmExports,
    getVmExport,
    recordVmBackup,
    listVmBackups,
    listAllVmBackups,
    getVmBackup,
    recordVmRestoreDrill,
    recordVmRecovery,
    getVmRecovery,
    listVmRecoveries,
    listAllVmRecoveries,
    recordVmRetention,
    getVmRetentionRun,
    listVmRetentionRuns,
  } = createVmLedgerStore({ ...context, recordAudit });
  const { listStoredParameters, maskStoredSecrets } = createStoredParameterStore({ ...context, recordAudit, emitJobChanged });

  function close() {
    database.close();
  }

  return {
    databasePath: resolvedDatabasePath,
    ownerCount,
    createBootstrapToken,
    bootstrapTokenUsable,
    consumeBootstrapToken,
    findOwnerByUsername,
    findFirstOwner,
    findOwnerById,
    createOwnerAccount,
    listOwners,
    setOwnerRole,
    disableOwner,
    setOwnerPassword,
    createSession,
    getSession,
    renewSession,
    listSessions,
    revokeSession,
    revokeOtherSessions,
    elevateSession,
    clearSessionElevation,
    getSetting,
    setSetting,
    updateSetting,
    saveJobOutput,
    getJobOutput,
    deleteSession,
    deleteExpiredSessions,
    addPasskey,
    findPasskeyById,
    listPasskeys,
    countPasskeys,
    anyPasskeys,
    updatePasskeyUse,
    renamePasskey,
    deletePasskey,
    replaceRecoveryCodes,
    countRecoveryCodes,
    consumeRecoveryCode,
    addOidcClient,
    getOidcClient,
    listOidcClients,
    removeOidcClient,
    recordAudit,
    listAudit,
    subscribeJobs,
    createJob,
    createPlan,
    getPlan,
    addJobStep,
    addApproval,
    transitionJob,
    getJob,
    listJobs,
    forgetTrustedDevices,
    pruneHistory,
    listActiveJobs,
    listAwaitingApproval,
    createFlow,
    getFlow,
    listFlows,
    updateFlow,
    markFlowRun,
    listDueFlows, listFlowsTriggeredBy, setFlowWebhook,
    deleteFlow,
    createSchedule,
    getSchedule,
    listSchedules,
    listDueSchedules,
    setScheduleEnabled,
    markScheduleRun,
    settleScheduleRun,
    deleteSchedule,
    recordBackup,
    getBackup,
    listBackups,
    recordControllerBackupProtection,
    getControllerBackupProtection,
    getControllerBackupProtectionByBackup,
    listControllerBackupProtections,
    listAllControllerBackupProtections,
    recordControllerRetention,
    getControllerRetentionRun,
    listControllerRetentionRuns,
    recordVmExport,
    listVmExports,
    getVmExport,
    recordVmBackup,
    listVmBackups,
    listAllVmBackups,
    getVmBackup,
    recordVmRestoreDrill,
    recordVmRecovery,
    getVmRecovery,
    listVmRecoveries,
    listAllVmRecoveries,
    recordVmRetention,
    getVmRetentionRun,
    listVmRetentionRuns,
    recoverInterruptedJobs,
    listStoredParameters,
    maskStoredSecrets,
    close,
  };
}

export const stateInternals = { digest, parseJson };
