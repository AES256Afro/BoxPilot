/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit, findOwnerById: ReturnType<typeof import("./people.mjs").createPeopleStore>["findOwnerById"] }} context */
export function createRecoveryCodeStore({ database, timestamp, recordAudit, findOwnerById }) {
  // ---- Recovery codes ------------------------------------------------------------------------
  /** Replace an owner's recovery codes with a fresh hashed set. Returns how many were stored. */
  function replaceRecoveryCodes(ownerId, codeHashes, { actorId = null } = {}) {
    if (!findOwnerById(ownerId)) throw new Error("Account not found");
    const at = timestamp();
    const insert = database.prepare("INSERT INTO recovery_codes (code_hash, owner_id, created_at) VALUES (?, ?, ?)");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM recovery_codes WHERE owner_id = ?").run(ownerId);
      for (const hash of codeHashes) insert.run(hash, ownerId, at);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* nothing of ours was open */ }
      throw error;
    }
    recordAudit("recovery-codes.generated", { actorId: actorId ?? ownerId, subjectId: ownerId, details: { count: codeHashes.length } });
    return codeHashes.length;
  }

  /** How many unused recovery codes an owner has left. */
  function countRecoveryCodes(ownerId) {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM recovery_codes WHERE owner_id = ? AND used_at IS NULL").get(ownerId).count);
  }

  /**
   * Spend a recovery code: mark the matching unused row used, in one statement so a code cannot be
   * spent twice by a race. Returns the owner id it belonged to, or null.
   */
  function consumeRecoveryCode(codeHash) {
    if (typeof codeHash !== "string") return null;
    const row = database.prepare("SELECT owner_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL").get(codeHash);
    if (!row) return null;
    const changes = Number(database.prepare("UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(timestamp(), codeHash).changes);
    if (changes === 0) return null; // lost the race; another request just spent it
    recordAudit("recovery-code.used", { actorId: row.owner_id, subjectId: row.owner_id });
    return row.owner_id;
  }

  return { replaceRecoveryCodes, countRecoveryCodes, consumeRecoveryCode };
}
