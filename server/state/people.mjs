import { randomUUID } from "node:crypto";
import { digest, iso, json } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit, updateSetting: ReturnType<typeof import("./settings.mjs").createSettingsStore>["updateSetting"] }} context */
export function createPeopleStore({ database, now, timestamp, tokenBytes, recordAudit, updateSetting }) {
  function ownerCount() {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM owners").get().count);
  }

  function createBootstrapToken({ ttlMs = 15 * 60 * 1000 } = {}) {
    if (ownerCount() > 0) throw new Error("An owner already exists");
    const token = tokenBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    database.prepare("DELETE FROM bootstrap_tokens WHERE used_at IS NOT NULL OR expires_at <= ?").run(iso(createdAt));
    database.prepare("INSERT INTO bootstrap_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(digest(token), iso(createdAt), iso(expiresAt));
    return { token, expiresAt: iso(expiresAt) };
  }

  /** Could this token still be spent? Read-only: consumeBootstrapToken remains the real guard. */
  function bootstrapTokenUsable(token) {
    if (typeof token !== "string" || !token.length) return false;
    const entry = database.prepare("SELECT used_at, expires_at FROM bootstrap_tokens WHERE token_hash = ?").get(digest(token));
    return Boolean(entry && !entry.used_at && entry.expires_at > timestamp());
  }

  function consumeBootstrapToken(token, { username, passwordHash }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (ownerCount() > 0) throw new Error("An owner already exists");
      const entry = database.prepare("SELECT * FROM bootstrap_tokens WHERE token_hash = ?").get(digest(token));
      if (!entry || entry.used_at || entry.expires_at <= at) throw new Error("Bootstrap token is invalid or expired");
      const owner = { id: randomUUID(), username, role: "owner", createdAt: at };
      database.prepare("INSERT INTO owners (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
        .run(owner.id, owner.username, passwordHash, owner.createdAt);
      database.prepare("DELETE FROM bootstrap_tokens WHERE token_hash = ?").run(digest(token));
      database.prepare("INSERT INTO audit_events (id, type, actor_id, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), "owner.bootstrapped", owner.id, owner.id, json({ username }), at);
      database.exec("COMMIT");
      return owner;
    } catch (error) {
      // If BEGIN itself failed there is no transaction of ours to roll back, and rolling one back
      // would report the wrong error — or discard somebody else's.
      try { database.exec("ROLLBACK"); } catch { /* nothing of ours was open */ }
      throw error;
    }
  }

  function findOwnerByUsername(username) {
    const row = database.prepare("SELECT * FROM owners WHERE username = ?").get(username);
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role ?? "owner", createdAt: row.created_at } : null;
  }

  function findFirstOwner() {
    const row = database.prepare("SELECT * FROM owners ORDER BY created_at ASC LIMIT 1").get();
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role ?? "owner", createdAt: row.created_at } : null;
  }

  function findOwnerById(id) {
    const row = database.prepare("SELECT * FROM owners WHERE id = ?").get(id);
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role ?? "owner", createdAt: row.created_at } : null;
  }


  const accountRoles = new Set(["owner", "operator", "viewer"]);

  /** Additional people (M5.4): owner runs everything, operator stages and approves low/medium work, viewer only looks. */
  function createOwnerAccount({ username, passwordHash, role, createdBy }) {
    if (!accountRoles.has(role)) throw new Error("Role must be owner, operator, or viewer");
    if (findOwnerByUsername(username)) throw new Error("That user name is already taken");
    const at = timestamp();
    const account = { id: randomUUID(), username, role, createdAt: at };
    database.prepare("INSERT INTO owners (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(account.id, username, passwordHash, role, at);
    recordAudit("people.added", { actorId: createdBy, subjectId: account.id, details: { username, role } });
    return account;
  }

  function listOwners() {
    return database.prepare("SELECT id, username, role, created_at FROM owners ORDER BY created_at ASC").all().map((row) => ({ id: row.id, username: row.username, role: row.role ?? "owner", createdAt: row.created_at }));
  }

  function activeOwnerCount() {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM owners WHERE role = 'owner' OR role IS NULL").get().count);
  }

  function setOwnerRole(id, role, { actorId = null } = {}) {
    if (!accountRoles.has(role)) throw new Error("Role must be owner, operator, or viewer");
    const account = findOwnerById(id);
    if (!account) throw new Error("Account not found");
    if (account.role === "owner" && role !== "owner" && activeOwnerCount() <= 1) throw new Error("BoxPilot needs at least one owner");
    database.prepare("UPDATE owners SET role = ? WHERE id = ?").run(role, id);
    database.prepare("DELETE FROM sessions WHERE owner_id = ?").run(id);
    forgetTrustedDevices(id);
    recordAudit("people.role-changed", { actorId, subjectId: id, details: { username: account.username, from: account.role, to: role } });
    return { id: account.id, username: account.username, role, createdAt: account.createdAt };
  }

  /** Self-service password change; other sessions of the account are ended. */
  /** Forget every browser this account had marked trusted (used when its password or role changes). */
  function forgetTrustedDevices(ownerId) {
    // Read and write in one transaction. Node being single-threaded makes this safe today, but
    // that is incidental — the guarantee should be in the query, not in the runtime.
    return updateSetting("trustedDevices", [], (devices) => {
      if (!Array.isArray(devices) || !devices.length) return { value: devices, result: 0 };
      const kept = devices.filter((entry) => entry?.ownerId !== ownerId);
      return { value: kept, result: devices.length - kept.length };
    }, ownerId);
  }

  function setOwnerPassword(id, passwordHash, { keepSessionTokenHash = null } = {}) {
    const account = findOwnerById(id);
    if (!account) throw new Error("Account not found");
    database.prepare("UPDATE owners SET password_hash = ? WHERE id = ?").run(passwordHash, id);
    if (keepSessionTokenHash) database.prepare("DELETE FROM sessions WHERE owner_id = ? AND token_hash != ?").run(id, keepSessionTokenHash);
    else database.prepare("DELETE FROM sessions WHERE owner_id = ?").run(id);
    // A new password must also end password-free sign-in from a browser that was trusted before it.
    forgetTrustedDevices(id);
    recordAudit("people.password-changed", { actorId: id, subjectId: id, details: { username: account.username } });
    return { id, username: account.username };
  }

  /** Accounts are disabled, not deleted: their jobs and audit rows keep pointing at them. */
  function disableOwner(id, { actorId = null } = {}) {
    const account = findOwnerById(id);
    if (!account) throw new Error("Account not found");
    if (account.role === "owner" && activeOwnerCount() <= 1) throw new Error("BoxPilot needs at least one owner");
    database.prepare("UPDATE owners SET role = 'disabled' WHERE id = ?").run(id);
    database.prepare("DELETE FROM sessions WHERE owner_id = ?").run(id);
    forgetTrustedDevices(id);
    recordAudit("people.disabled", { actorId, subjectId: id, details: { username: account.username } });
    return { id: account.id, username: account.username, role: "disabled", createdAt: account.createdAt };
  }

  function createSession(ownerId, { ttlMs = 12 * 60 * 60 * 1000, address = null, userAgent = null, method = null } = {}) {
    const token = tokenBytes(32).toString("base64url");
    const csrfToken = tokenBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    database.prepare("INSERT INTO sessions (token_hash, id, owner_id, csrf_token, created_at, expires_at, last_seen_at, client_address, user_agent, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(digest(token), id, ownerId, csrfToken, iso(createdAt), iso(expiresAt), iso(createdAt), address, userAgent, method);
    return { token, csrfToken, expiresAt: iso(expiresAt), id };
  }

  function getSession(token) {
    if (typeof token !== "string" || token.length < 20) return null;
    const at = timestamp();
    /** @type {Record<string, any> | undefined} */
    const row = database.prepare(`
      SELECT sessions.*, owners.username, owners.role
      FROM sessions JOIN owners ON owners.id = sessions.owner_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(digest(token), at);
    if (!row) return null;
    if (!row.last_seen_at || Date.parse(at) - Date.parse(row.last_seen_at) > 60_000) database.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(at, digest(token));
    return {
      id: row.id,
      tokenHash: row.token_hash,
      owner: { id: row.owner_id, username: row.username, role: row.role ?? "owner" },
      csrfToken: row.csrf_token,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      elevatedUntil: row.elevated_until ?? null,
      // The address it was signed in from: a session answers only to that one (security.mjs).
      address: row.client_address ?? null,
    };
  }

  /** Move a live session's end to `expiresAt`, never earlier than it is now. */
  function renewSession(tokenHash, expiresAt) {
    const at = iso(expiresAt);
    database.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ? AND expires_at < ?").run(at, tokenHash, timestamp(), at);
    return database.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash)?.expires_at ?? null;
  }

  /** Every live session for an owner, newest activity first, for the session list (M19.4). */
  function listSessions(ownerId) {
    const at = timestamp();
    return database.prepare("SELECT id, created_at, expires_at, last_seen_at, client_address, user_agent, method, elevated_until FROM sessions WHERE owner_id = ? AND expires_at > ? ORDER BY last_seen_at DESC").all(ownerId, at).map((/** @type {Record<string, any>} */ row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      address: row.client_address ?? null,
      userAgent: row.user_agent ?? null,
      method: row.method ?? null,
      elevated: Boolean(row.elevated_until && Date.parse(row.elevated_until) > now().getTime()),
    }));
  }

  /** End one of an owner's sessions by its public id. Returns how many rows went (0 or 1). */
  function revokeSession(ownerId, id) {
    if (typeof id !== "string") return 0;
    return Number(database.prepare("DELETE FROM sessions WHERE owner_id = ? AND id = ?").run(ownerId, id).changes);
  }

  /** End every session for an owner except the one to keep. Returns how many were ended. */
  function revokeOtherSessions(ownerId, keepId) {
    return Number(database.prepare("DELETE FROM sessions WHERE owner_id = ? AND id IS NOT ?").run(ownerId, keepId).changes);
  }

  /** Mark a session as recently password-verified until `until` (ISO string or Date). Returns the new value or null if the session is gone. */
  function elevateSession(tokenHash, until) {
    const value = until instanceof Date ? iso(until) : until;
    if (typeof tokenHash !== "string" || typeof value !== "string") return null;
    const changes = Number(database.prepare("UPDATE sessions SET elevated_until = ? WHERE token_hash = ?").run(value, tokenHash).changes);
    return changes > 0 ? value : null;
  }

  function clearSessionElevation(tokenHash) {
    if (typeof tokenHash !== "string") return;
    database.prepare("UPDATE sessions SET elevated_until = NULL WHERE token_hash = ?").run(tokenHash);
  }

  function deleteSession(token) {
    if (typeof token !== "string") return;
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
  }

  function deleteExpiredSessions() {
    return Number(database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp()).changes);
  }

  return {
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
  };
}
