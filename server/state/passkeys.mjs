import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit, findOwnerById: ReturnType<typeof import("./people.mjs").createPeopleStore>["findOwnerById"] }} context */
export function createPasskeyStore({ database, timestamp, recordAudit, findOwnerById }) {
  // ---- Passkeys (WebAuthn, M19.1) ------------------------------------------------------------
  function normalizePasskey(row) {
    return row ? {
      id: row.id, ownerId: row.owner_id, rpId: row.rp_id, publicKey: row.public_key,
      algorithm: row.algorithm, signCount: row.sign_count, transports: parseJson(row.transports, []),
      label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at ?? null,
    } : null;
  }

  function addPasskey({ id, ownerId, rpId, publicKey, algorithm, signCount = 0, transports = [], label }) {
    if (!findOwnerById(ownerId)) throw new Error("Account not found");
    if (database.prepare("SELECT 1 FROM passkeys WHERE id = ?").get(id)) throw new Error("This passkey is already registered");
    const at = timestamp();
    database.prepare("INSERT INTO passkeys (id, owner_id, rp_id, public_key, algorithm, sign_count, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ownerId, rpId, publicKey, algorithm, signCount, json(transports), label, at);
    recordAudit("passkey.registered", { actorId: ownerId, subjectId: ownerId, details: { label, rpId } });
    return normalizePasskey(database.prepare("SELECT * FROM passkeys WHERE id = ?").get(id));
  }

  function findPasskeyById(id) {
    return typeof id === "string" ? normalizePasskey(database.prepare("SELECT * FROM passkeys WHERE id = ?").get(id)) : null;
  }

  /** Every passkey for an owner (for the management list). Public key omitted; it is not needed there. */
  function listPasskeys(ownerId) {
    return database.prepare("SELECT * FROM passkeys WHERE owner_id = ? ORDER BY created_at ASC").all(ownerId)
      .map(normalizePasskey).map(({ publicKey: _publicKey, ...rest }) => rest);
  }

  function countPasskeys(ownerId) {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM passkeys WHERE owner_id = ?").get(ownerId).count);
  }

  /** Whether any account has a passkey, so the sign-in screen knows to offer that path. */
  function anyPasskeys() {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM passkeys").get().count) > 0;
  }

  function updatePasskeyUse(id, signCount) {
    database.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").run(signCount, timestamp(), id);
  }

  function renamePasskey(id, ownerId, label) {
    const changes = Number(database.prepare("UPDATE passkeys SET label = ? WHERE id = ? AND owner_id = ?").run(label, id, ownerId).changes);
    if (changes === 0) throw new Error("Passkey not found");
    recordAudit("passkey.renamed", { actorId: ownerId, subjectId: ownerId, details: { label } });
    return changes;
  }

  function deletePasskey(id, ownerId) {
    const key = findPasskeyById(id);
    const changes = Number(database.prepare("DELETE FROM passkeys WHERE id = ? AND owner_id = ?").run(id, ownerId).changes);
    if (changes === 0) throw new Error("Passkey not found");
    recordAudit("passkey.removed", { actorId: ownerId, subjectId: ownerId, details: { label: key?.label ?? null } });
    return changes;
  }

  return { addPasskey, findPasskeyById, listPasskeys, countPasskeys, anyPasskeys, updatePasskeyUse, renamePasskey, deletePasskey };
}
