import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit }} context */
export function createOidcClientStore({ database, timestamp, recordAudit }) {
  // ---- OIDC clients (M19.3) ------------------------------------------------------------------
  function normalizeOidcClient(row) {
    return row ? { id: row.id, name: row.name, redirectUris: parseJson(row.redirect_uris, []), createdAt: row.created_at, createdBy: row.created_by ?? null } : null;
  }

  function addOidcClient({ id, name, redirectUris, createdBy = null }) {
    const at = timestamp();
    database.prepare("INSERT INTO oidc_clients (id, name, redirect_uris, created_at, created_by) VALUES (?, ?, ?, ?, ?)").run(id, name, json(redirectUris), at, createdBy);
    recordAudit("oidc.client.registered", { actorId: createdBy, subjectId: id, details: { name } });
    return normalizeOidcClient(database.prepare("SELECT * FROM oidc_clients WHERE id = ?").get(id));
  }

  function getOidcClient(id) {
    return typeof id === "string" ? normalizeOidcClient(database.prepare("SELECT * FROM oidc_clients WHERE id = ?").get(id)) : null;
  }

  function listOidcClients() {
    return database.prepare("SELECT * FROM oidc_clients ORDER BY created_at ASC").all().map(normalizeOidcClient);
  }

  function removeOidcClient(id, { actorId = null } = {}) {
    const client = getOidcClient(id);
    const changes = Number(database.prepare("DELETE FROM oidc_clients WHERE id = ?").run(id).changes);
    if (changes === 0) throw new Error("Client not found");
    recordAudit("oidc.client.removed", { actorId, subjectId: id, details: { name: client?.name ?? null } });
    return changes;
  }

  return { addOidcClient, getOidcClient, listOidcClients, removeOidcClient };
}
