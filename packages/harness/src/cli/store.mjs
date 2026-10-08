/**
 * The CLI's memory (M45.8): one SQLite file, by default `.harness/harness.db` in the working folder,
 * readable by its owner only. It keeps every run with its trace, the notes the agent saved for
 * later runs, and how fast each model has been, so the next run's pacing starts from what was
 * measured rather than a guess.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, folder TEXT NOT NULL, route TEXT, model TEXT, outcome TEXT,
  answer TEXT, degraded_reason TEXT, error TEXT, usage TEXT, taint TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT,
  state TEXT, body TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS speeds (
  model TEXT PRIMARY KEY, prompt_per_second REAL NOT NULL, generate_per_second REAL NOT NULL, samples INTEGER NOT NULL, updated_at TEXT NOT NULL
);
`;

const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parsed = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

const runOf = (row) => row && ({
  id: row.id, task: row.task, folder: row.folder, route: row.route, model: row.model, outcome: row.outcome, answer: row.answer,
  degradedReason: row.degraded_reason, error: row.error, usage: parsed(row.usage), taint: parsed(row.taint), startedAt: row.started_at, finishedAt: row.finished_at,
});

/**
 * @param {string} file the database file, or ":memory:"
 * @param {{ now?: () => number }} [options]
 */
export function openStore(file, { now = () => Date.now() } = {}) {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  if (file !== ":memory:") chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec(schema);
  const iso = () => new Date(now()).toISOString();
  const statements = {
    startRun: db.prepare("INSERT INTO runs (id, task, folder, route, started_at) VALUES (?, ?, ?, ?, ?)"),
    finishRun: db.prepare("UPDATE runs SET route = ?, model = ?, outcome = ?, answer = ?, degraded_reason = ?, error = ?, usage = ?, taint = ?, finished_at = ? WHERE id = ?"),
    nextSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM steps WHERE run_id = ?"),
    step: db.prepare("INSERT INTO steps (run_id, seq, kind, name, state, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    runs: db.prepare("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?"),
    run: db.prepare("SELECT * FROM runs WHERE id = ?"),
    runByPrefix: db.prepare("SELECT * FROM runs WHERE id LIKE ? ORDER BY started_at DESC LIMIT 2"),
    steps: db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY seq"),
    saveNote: db.prepare("INSERT INTO notes (title, body, run_id, created_at) VALUES (?, ?, ?, ?)"),
    notes: db.prepare("SELECT * FROM notes ORDER BY id DESC LIMIT ?"),
    speed: db.prepare("SELECT * FROM speeds WHERE model = ?"),
    saveSpeed: db.prepare("INSERT INTO speeds (model, prompt_per_second, generate_per_second, samples, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(model) DO UPDATE SET prompt_per_second = excluded.prompt_per_second, generate_per_second = excluded.generate_per_second, samples = speeds.samples + excluded.samples, updated_at = excluded.updated_at"),
  };

  return {
    file,
    /** A new run, before anything happens in it. */
    startRun({ task, folder, route }) {
      const id = randomUUID();
      statements.startRun.run(id, String(task), String(folder), route ?? null, iso());
      return id;
    },
    /** One step of a run's trace, in order. */
    step(runId, step) {
      const { seq } = statements.nextSeq.get(runId);
      statements.step.run(runId, seq, String(step.kind ?? "system"), step.name ?? null, step.state ?? null, JSON.stringify(step), iso());
      return seq;
    },
    finishRun(runId, result) {
      statements.finishRun.run(result.route ?? null, result.model ?? null, result.outcome, result.answer ?? null, result.degradedReason ?? null, result.error ?? null, json(result.usage), json(result.taint), iso(), runId);
    },
    listRuns(limit = 20) { return statements.runs.all(Math.max(1, Math.min(200, limit))).map(runOf); },
    /** A run by its id or the start of it (as `runs` prints it), with its trace; null when none or more than one match. */
    getRun(idOrPrefix) {
      const key = String(idOrPrefix ?? "").trim();
      let row = statements.run.get(key);
      if (!row && /^[0-9a-f-]{4,}$/i.test(key)) {
        const rows = statements.runByPrefix.all(`${key}%`);
        row = rows.length === 1 ? rows[0] : null;
      }
      if (!row) return null;
      return { ...runOf(row), steps: statements.steps.all(row.id).map((step) => ({ seq: step.seq, at: step.at, ...parsed(step.body) })) };
    },
    saveNote({ title, body, runId = null }) {
      const { lastInsertRowid } = statements.saveNote.run(String(title), String(body), runId, iso());
      return Number(lastInsertRowid);
    },
    /** Notes whose title or text holds every word of the query, newest first; the newest when there is no query. */
    searchNotes(query = "", limit = 5) {
      const words = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1).slice(0, 8);
      const all = statements.notes.all(500);
      const hits = words.length ? all.filter((note) => { const text = `${note.title}\n${note.body}`.toLowerCase(); return words.every((word) => text.includes(word)); }) : all;
      return hits.slice(0, limit).map((note) => ({ id: note.id, title: note.title, body: note.body, createdAt: note.created_at }));
    },
    /** What a model's speed was measured at, or null. */
    speedOf(model) {
      const row = statements.speed.get(String(model));
      return row ? { promptPerSecond: row.prompt_per_second, generatePerSecond: row.generate_per_second, samples: row.samples } : null;
    },
    saveSpeed(model, speed) {
      if (!(speed?.samples > 0) || !(speed.promptPerSecond > 0) || !(speed.generatePerSecond > 0)) return;
      statements.saveSpeed.run(String(model), speed.promptPerSecond, speed.generatePerSecond, speed.samples, iso());
    },
    close() { db.close(); },
  };
}
