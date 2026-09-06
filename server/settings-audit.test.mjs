import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every setting BoxPilot records must have something that reads it.
 *
 * Three silent failures in one week had the same shape: a verdict was recorded and shown to nobody.
 * The kill-switch drill result sat unread for a month; the health-alert state was read by one route
 * that filtered out the half that mattered; the data-sweep outcome existed only in the database.
 * A setting nobody reads is not a record, it is a place for a fact to disappear into. This walks
 * the source and fails when a key is written and never read - by a literal getSetting, by a local
 * wrapper such as identity.mjs's setting(), or through a settingKey constant.
 */
function sources(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) { if (entry !== "node_modules") out.push(...sources(full)); continue; }
    if (/\.(mjs|ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

const files = [...sources("server"), ...sources("scripts"), ...sources("src")].map((file) => [file, readFileSync(file, "utf8")]);

const written = new Map();
const read = new Set();
for (const [file, text] of files) {
  // Keys held in constants: const settingKey = "x"; then setSetting(settingKey, ...) / getSetting(settingKey, ...)
  const constants = new Map([...text.matchAll(/const (\w+) = "([^"]+)";/g)].map((match) => [match[1], match[2]]));
  const record = (key) => written.set(key, [...(written.get(key) ?? []), file]);
  // setSetting and updateSetting both persist; the record hooks in index.mjs fold results through the latter.
  for (const match of text.matchAll(/(?:setSetting|updateSetting)\(\s*"([^"]+)"/g)) record(match[1]);
  for (const match of text.matchAll(/(?:setSetting|updateSetting)\(\s*(\w+)\s*,/g)) if (constants.has(match[1])) record(constants.get(match[1]));
  for (const match of text.matchAll(/getSetting\??\.?\(\s*"([^"]+)"/g)) read.add(match[1]);
  for (const match of text.matchAll(/getSetting\??\.?\(\s*(\w+)\s*[,)]/g)) if (constants.has(match[1])) read.add(constants.get(match[1]));
  // Module-local wrappers that forward a key to getSetting - identity.mjs has setting(), links() and
  // logins() - read too: every literal handed to such a wrapper counts.
  const wrappers = [...text.matchAll(/function (\w+)\((\w+)[^)]*\)\s*\{[^}]*getSetting\(\s*\2\b/g)].map((match) => match[1]);
  const forwarding = [...text.matchAll(/function (\w+)\((\w+)[^)]*\)\s*\{[^}]*\b(?:setting|links|logins)\(\s*\2\b/g)].map((match) => match[1]);
  for (const name of [...wrappers, ...forwarding]) for (const match of text.matchAll(new RegExp(`\\b${name}\\(\\s*"([^"]+)"`, "g"))) read.add(match[1]);
}

describe("recorded settings", () => {
  it("are all read by something", () => {
    const orphans = [...written.keys()].filter((key) => !read.has(key)).sort();
    expect(orphans, `written but never read: ${orphans.map((key) => `${key} (${written.get(key).join(", ")})`).join("; ")}`).toEqual([]);
  });

  it("include the ones this week's incidents were about, read by a route the pages fetch", () => {
    for (const key of ["healthAlertsState", "appDataUsageLastRun", "killSwitchDrills", "appBackupVerifications"]) {
      expect(written.has(key), `${key} is no longer written`).toBe(true);
      const routeReads = files.some(([file, text]) => file.startsWith("server/routes/") && new RegExp(`getSetting\\??\\.?\\(\\s*"${key}"`).test(text));
      expect(routeReads, `${key} is not read by any route`).toBe(true);
    }
  });
});
