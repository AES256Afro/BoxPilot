/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit, emitJobChanged: ReturnType<typeof import("./jobs.mjs").createJobStore>["emitJobChanged"] }} context */
export function createStoredParameterStore({ database, recordAudit, emitJobChanged }) {
  /**
   * Every stored parameter set as written, for the startup pass that masks secrets stored before
   * M29.1 refused them (server/secret-scrub.mjs). What each row holds, not what it means: which
   * values are secrets is the registry's answer, and this file does not know the registry.
   */
  function listStoredParameters({ afterJobRow = 0 } = {}) {
    // Jobs after a rowid (M50): the scrub at boot read every job row ever written, to check again
    // rows it had checked at every start before. `lastJobRow` is the mark to keep once they pass.
    const after = Number.isFinite(afterJobRow) && afterJobRow > 0 ? afterJobRow : 0;
    return {
      jobs: database.prepare("SELECT id, type, parameters_json AS stored FROM jobs WHERE rowid > ? ORDER BY rowid").all(after),
      lastJobRow: Number(database.prepare("SELECT COALESCE(MAX(rowid), 0) AS row FROM jobs").get().row),
      schedules: database.prepare("SELECT id, operation_id AS operationId, parameters_json AS stored FROM schedules").all(),
      flows: database.prepare("SELECT id, steps_json AS stored FROM flows").all(),
    };
  }

  /**
   * Put the placeholder where a row written before M29.1 still holds a secret in clear (M29.3).
   * Each change is `{ id, from, to, secrets }`, and a row is rewritten only while it still reads
   * `from`: one that changed after the pass read it is left for the next pass. One transaction,
   * and one audit entry with counts, never a value, when anything changed.
   *
   * An UPDATE leaves the old bytes behind, in the page's free space and in the WAL frames that
   * held the page before. secure_delete zeroes the first and a truncating checkpoint drops the
   * second, so the live file stops holding what its rows no longer say. A controller backup never
   * carried either: VACUUM INTO copies rows, not pages.
   */
  function maskStoredSecrets({ jobs = [], schedules = [], flows = [] } = {}) {
    const counts = { jobs: 0, schedules: 0, flows: 0, secrets: 0 };
    const tables = [["jobs", "parameters_json", jobs], ["schedules", "parameters_json", schedules], ["flows", "steps_json", flows]];
    if (!tables.some(([, , changes]) => changes.length)) return counts;
    const changedJobs = [];
    const secureDelete = Number(database.prepare("PRAGMA secure_delete").get().secure_delete);
    database.exec("PRAGMA secure_delete = ON");
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const [table, column, changes] of tables) {
          for (const { id, from, to, secrets } of changes) {
            if (!Number(database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`).run(to, id, from).changes)) continue;
            counts[table] += 1;
            counts.secrets += secrets;
            if (table === "jobs") changedJobs.push(id);
          }
        }
        if (counts.jobs + counts.schedules + counts.flows) recordAudit("stored-secrets.masked", { details: { ...counts } });
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* nothing of ours was open */ }
        throw error;
      }
    } finally {
      database.exec(`PRAGMA secure_delete = ${secureDelete === 2 ? "FAST" : secureDelete ? "ON" : "OFF"}`);
    }
    if (counts.jobs + counts.schedules + counts.flows) database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    for (const id of changedJobs) emitJobChanged(id);
    return counts;
  }

  return { listStoredParameters, maskStoredSecrets };
}
