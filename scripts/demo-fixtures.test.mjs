import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspections, scenarios, scenarioNames, freshRest, app } from "./boxpilot-demo.mjs";
import { operationModules } from "../server/ops/index.mjs";

/**
 * The demo is where every page gets looked at before it reaches a real server, so a page the demo
 * cannot show is a page nobody reviews. Worse than invisible: an operation with no fixture answers
 * `{}`, and an empty object is the exact shape that breaks code expecting a field to be there. Three
 * crashes reached a live server that way — the Logs page, the Repair Center, and the catalog's
 * configuration dialog — each on a screen that looked fine in the demo because it never rendered.
 *
 * So: whatever the interface asks for, the demo has to be able to answer.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full);
  }
  return files;
}

/** Operation ids the interface reads from: inspectOperation("x") and POSTs to /operations/x/{run,inspect}. */
async function operationsTheUiReads() {
  const ids = new Map(); // id -> the file that asks for it
  for (const file of await sourceFiles(path.join(root, "src"))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/inspectOperation<[^>]*>\("([a-z][\w.-]+)"\)/g)) ids.set(match[1], path.basename(file));
    for (const match of text.matchAll(/inspectOperation\("([a-z][\w.-]+)"\)/g)) ids.set(match[1], path.basename(file));
    for (const match of text.matchAll(/\/operations\/([a-z][\w.-]+)\/(?:run|inspect)/g)) ids.set(match[1], path.basename(file));
  }
  return ids;
}

describe("the demo can answer what the interface asks", () => {
  it("has a fixture for every read-only operation a page reads", async () => {
    const registered = new Map(operationModules.flatMap((build) => build()).map((operation) => [operation.id, operation]));
    const asked = await operationsTheUiReads();
    expect(asked.size).toBeGreaterThan(10); // the scan found something to check

    const missing = [];
    for (const [id, file] of asked) {
      const operation = registered.get(id);
      // Only read-only operations answer from the fixture table; the rest stage a job instead.
      if (!operation?.readOnly) continue;
      if (!(id in inspections)) missing.push(`${id} (read by ${file})`);
    }
    expect(missing, `these answer {} in the demo, which is the shape that breaks a page:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("gives the fields the interface actually reads", () => {
    // The check above catches a fixture that is missing. It cannot catch one that is present and
    // wrong, which has cost twice as much: `logs.sources` answered `{ sources: [...] }` when the
    // server returns `{ groups, units, containers }`, so the Logs page threw on a real machine
    // while looking healthy here. Fields are listed as they are relied on.
    const required = {
      "logs.sources": ["groups", "units", "containers", "dockerAvailable"],
      "host.snapshot.sources": ["sources", "mount"],
      "host.snapshot.describe": ["apps", "system", "artifact"],
      "app.config.inspect": ["compose", "env", "directory"],
      "app.models.inspect": ["available", "models"],
      "app.backup.protection": ["available", "apps"],
      "app.backups.inspect": ["backups", "directory"],
      "app.logs": ["lines"],
      "service.journal": ["lines", "unit"],
      "app.secrets": ["secrets"],
      "system.performance.inspect": ["cpu", "memory", "disks", "apps"],
      "docker.disk.inspect": ["images", "containers", "volumes"],
      "app.serve.inspect": ["available", "serves"],
      "users.inspect": ["users", "sshd", "sshActive"],
      "dns.names.inspect": ["available", "platform", "records", "apps"],
      "router.inspect": ["configured", "reachable", "host"],
      "router.leases": ["leases", "host"],
    };
    const wrong = [];
    for (const [id, fields] of Object.entries(required)) {
      const fixture = inspections[id];
      if (!fixture) { wrong.push(`${id}: no fixture`); continue; }
      const absent = fields.filter((field) => !(field in fixture));
      if (absent.length) wrong.push(`${id}: missing ${absent.join(", ")}`);
    }
    expect(wrong, "a fixture whose shape disagrees with the server teaches the tests the wrong thing").toEqual([]);
  });

  it("gives the fields the interface reads inside a list, not only at the top", () => {
    // Checking top-level keys is not enough: `app.backups.inspect` had its `backups` array, and
    // the entries in it were missing the field the dialog reads, which threw inside Array.some
    // and lost the whole dialog. The rows are what the interface actually walks over.
    const itemFields = {
      "app.backups.inspect": ["backups", ["artifact", "createdAt", "sizeBytes", "skippedVolumes", "skippedHostPaths"]],
      "app.backup.files": ["files", ["path", "sizeBytes"]],
      "host.snapshot.sources": ["sources", ["source", "root", "available", "snapshots"]],
      "app.models.inspect": ["models", ["name", "size", "bytes"]],
      "app.backup.protection": ["apps", ["id", "name", "protectable", "backups", "newestAt"]],
      "system.performance.inspect": ["apps", ["id", "state", "running", "cpuPercent", "memBytes"]],
      "users.inspect": ["users", ["name", "uid", "shell", "sudo", "keyCount"]],
      "dns.names.inspect": ["apps", ["id", "name", "port"]],
      "router.leases": ["leases", ["name", "address", "mac", "online", "reserved"]],
    };
    const wrong = [];
    for (const [id, [listKey, fields]] of Object.entries(itemFields)) {
      const list = inspections[id]?.[listKey];
      if (!Array.isArray(list)) { wrong.push(`${id}.${listKey}: not a list`); continue; }
      if (list.length === 0) { wrong.push(`${id}.${listKey}: empty, so nothing is exercised`); continue; }
      const absent = fields.filter((field) => !(field in list[0]));
      if (absent.length) wrong.push(`${id}.${listKey}[0]: missing ${absent.join(", ")}`);
    }
    expect(wrong, "the interface walks these rows; a row missing a field is a crash it cannot see here").toEqual([]);
  });

  it("names a real operation in every fixture, and never answers with nothing", () => {
    const registered = new Set(operationModules.flatMap((build) => build()).map((operation) => operation.id));
    const unknown = Object.keys(inspections).filter((id) => !registered.has(id));
    expect(unknown, "fixtures for operations that no longer exist").toEqual([]);

    const empty = Object.entries(inspections)
      .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
      .map(([id]) => id);
    expect(empty, "an empty fixture is no better than a missing one").toEqual([]);
  });
});

/**
 * The empty and broken worlds have to be the same shape as the lived-in one, or they teach exactly
 * the wrong lesson: the first hand-written pass at them blanked six pages, and every one of those
 * was the fixture being wrong rather than the page. A scenario that drops a key is not a harder
 * test, it is a different server.
 */
function shapeComplaints(expected, actual, path = "") {
  // A field the server genuinely returns as null is a real state, not a missing key.
  if (actual === null || expected === null) return [];
  if (Array.isArray(expected)) return Array.isArray(actual) ? [] : [`${path}: expected a list, got ${typeof actual}`];
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: expected an object, got ${actual === undefined ? "nothing" : typeof actual}`];
    const complaints = [];
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) complaints.push(`${path}.${key} is missing`);
      else complaints.push(...shapeComplaints(expected[key], actual[key], `${path}.${key}`));
    }
    for (const key of Object.keys(actual)) if (!(key in expected)) complaints.push(`${path}.${key} is not a field the server returns`);
    return complaints;
  }
  return [];
}

describe("the empty and broken worlds are the same server", () => {
  it.each(scenarioNames.filter((name) => name !== "default"))("%s keeps every fixture's shape", (name) => {
    const complaints = [];
    for (const [id, value] of Object.entries(scenarios[name])) {
      if (!(id in inspections)) { complaints.push(`${id}: not an operation the demo answers`); continue; }
      complaints.push(...shapeComplaints(inspections[id], value, id));
    }
    expect(complaints, `the ${name} scenario disagrees with the shape the interface is built against`).toEqual([]);
  });

  it("answers every operation in every scenario, not only the default one", () => {
    const missing = [];
    for (const name of scenarioNames) {
      const table = { ...inspections, ...scenarios[name] };
      for (const id of Object.keys(inspections)) if (!table[id]) missing.push(`${name}: ${id}`);
    }
    expect(missing).toEqual([]);
  });
});

/**
 * The REST routes needed the same guard the operations have, and for the same reason: rewriting
 * them by hand for the empty world invented a `firewall` key on `/inventory` that no route returns,
 * and reshaped `/firewall/overview` into something the page does not read. Neither showed up as a
 * crash — the page simply carried on reporting a firewall that was switched on.
 *
 * This asks the real routes rather than a second copy of what they are believed to return, because
 * a second copy is the thing that drifts.
 */
describe("the empty world's REST routes are the same routes", () => {
  it("rewrites each one into the shape it already had", async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    const body = (route, scenario) => fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
      headers: { referer: `http://127.0.0.1:${port}/?scenario=${scenario}` },
    }).then((response) => response.json());

    const complaints = [];
    try {
      for (const route of Object.keys(freshRest)) {
        const [lived, empty] = await Promise.all([body(route, "default"), body(route, "fresh")]);
        complaints.push(...shapeComplaints(lived, empty, route));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(complaints, "a rewritten route that changes shape is a different server, not an emptier one").toEqual([]);
  });
});
