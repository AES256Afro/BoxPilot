import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext} context */
export function createSettingsStore({ database, timestamp }) {
  /**
   * Read a setting, transform it, and write it back atomically. Used where the transform depends
   * on what is already there, so two writers cannot each read the old value.
   */
  function updateSetting(key, fallback, transform, updatedBy = null) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const { value, result } = transform(getSetting(key, fallback));
      setSetting(key, value, { updatedBy });
      database.exec("COMMIT");
      return result;
    } catch (error) {
      // If BEGIN itself failed there is no transaction of ours to roll back, and rolling one back
      // would report the wrong error — or discard somebody else's.
      try { database.exec("ROLLBACK"); } catch { /* nothing of ours was open */ }
      throw error;
    }
  }

  function getSetting(key, fallback = null) {
    const row = database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  function setSetting(key, value, { updatedBy = null } = {}) {
    database.prepare("INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(key, json(value), updatedBy, timestamp());
    return value;
  }

  return { getSetting, setSetting, updateSetting };
}
