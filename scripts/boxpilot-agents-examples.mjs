#!/usr/bin/env node
/**
 * The agents' example book from the database, as training data (M46.3, docs/TRAINING.md). For a
 * server where the API is not at hand: reads BoxPilot's SQLite file read-only and writes the same
 * JSON Lines the owner's export does, this house's names replaced with stand-ins.
 *
 *   boxpilot-agents-examples.mjs list   <db>
 *   boxpilot-agents-examples.mjs export <db> [--agent NAME] [--cover N] [--no-seeds]
 *                                            [--host NAME ...] [--domain NAME ...] [--user NAME ...]
 *   boxpilot-agents-examples.mjs pairs  <db> [--agent NAME] [--host NAME ...] [--domain NAME ...] [--user NAME ...]
 *
 * `pairs` writes the preference pairs (M46.6): each thumbs down beside the approved example nearest
 * its request when their plans differ, for a DPO or ORPO stage after the fine-tune.
 *
 * Run it as the database's owner (`runuser -u boxpilot -- node scripts/boxpilot-agents-examples.mjs
 * export /var/lib/boxpilot/boxpilot.sqlite3 > examples.jsonl`). The host's own name and the accounts
 * in /etc/passwd are taken as the house's names; --host, --domain and --user add more.
 */
import { DatabaseSync } from "node:sqlite";
import { houseNames } from "../server/agents/cloud.mjs";
import { preferencePairs, toJsonl, trainingRecords } from "../server/agents/examples-export.mjs";
import { decodeVector } from "../server/agents/memory.mjs";

const [action, databasePath, ...rest] = process.argv.slice(2);
const values = (flag) => rest.flatMap((entry, index) => (entry === flag && rest[index + 1] !== undefined ? [rest[index + 1]] : []));
const parse = (value, fallback) => { try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; } };

function open(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  const agents = database.prepare("SELECT a.id, a.name, a.template, v.spec_json FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.version WHERE a.deleted_at IS NULL ORDER BY a.name").all()
    .map((row) => ({ id: row.id, name: row.name, template: row.template, spec: parse(row.spec_json, {}) }));
  const examplesOf = (agentId) => database.prepare("SELECT * FROM agent_examples WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC").all(agentId).map((row) => ({
    id: row.id, request: row.request, plan: parse(row.plan_json, []), intent: parse(row.intent_json, null), answer: row.answer ?? null, signal: row.signal, seed: String(row.source).startsWith("seed:"),
    route: row.route ?? null, model: row.model ?? null, createdAt: row.created_at,
  }));
  const vectors = new Map(database.prepare("SELECT item_id, vector FROM agent_vectors WHERE kind = 'example'").all().map((row) => [row.item_id, decodeVector(row.vector)]));
  // The thumbs down, each with what its planner understood (the intent step's input).
  const rejectedOf = (agentId) => database.prepare("SELECT f.run_id, f.note, r.question, r.kind FROM agent_feedback f JOIN agent_runs r ON r.id = f.run_id WHERE f.agent_id = ? AND f.verdict = 'down' ORDER BY f.given_at DESC").all(agentId)
    .filter((row) => ["ask", "manual", "eval", "schedule"].includes(row.kind))
    .map((row) => {
      const intent = parse(database.prepare("SELECT input_json FROM agent_run_steps WHERE run_id = ? AND kind = 'intent' AND state = 'done' ORDER BY seq LIMIT 1").get(row.run_id)?.input_json, null);
      const plan = parse(database.prepare("SELECT input_json FROM agent_run_steps WHERE run_id = ? AND kind = 'plan' ORDER BY seq LIMIT 1").get(row.run_id)?.input_json, null);
      return { id: row.run_id, request: String(row.question ?? "").replace(/\s+/g, " ").trim().slice(0, 300), understanding: intent && Array.isArray(plan) ? { ...intent, plan } : null, note: row.note ?? null, vector: null };
    })
    .filter((run) => run.request && run.understanding?.plan);
  return { agents, examplesOf, rejectedOf, vectors, close: () => database.close() };
}

try {
  if (!["list", "export", "pairs"].includes(action) || !databasePath) throw new Error("usage: boxpilot-agents-examples.mjs list|export|pairs <db> [--agent NAME] [--cover N] [--no-seeds] [--host H] [--domain D] [--user U]");
  const book = open(databasePath);
  try {
    if (action === "list") {
      for (const agent of book.agents) {
        const examples = book.examplesOf(agent.id);
        const seeds = examples.filter((example) => example.seed).length;
        process.stdout.write(`${agent.name.padEnd(28)} ${String(examples.length).padStart(4)} examples (${seeds} from the template, ${examples.length - seeds} approved)\n`);
      }
    } else {
      const wanted = values("--agent");
      const chosen = wanted.length ? book.agents.filter((agent) => wanted.includes(agent.name) || wanted.includes(agent.id)) : book.agents;
      if (wanted.length && !chosen.length) throw new Error(`No agent called ${wanted.join(", ")}`);
      const names = houseNames();
      const extra = { hosts: [...names.hosts, ...values("--host")], domains: [...names.domains, ...values("--domain")], users: [...names.users, ...values("--user")] };
      const cover = Number(values("--cover")[0]) > 0 ? Number(values("--cover")[0]) : null;
      const seeds = !rest.includes("--no-seeds");
      let total = 0;
      for (const agent of chosen) {
        const examples = book.examplesOf(agent.id).map((example) => ({ ...example, vector: book.vectors.get(example.id) ?? null }));
        const records = action === "pairs" ? preferencePairs({ agent, examples, rejected: book.rejectedOf(agent.id), names: extra }) : trainingRecords({ agent, examples, names: extra, cover, seeds });
        total += records.length;
        process.stdout.write(toJsonl(records));
      }
      process.stderr.write(`${total} ${action === "pairs" ? "pairs" : "records"} from ${chosen.length} ${chosen.length === 1 ? "agent" : "agents"}\n`);
    }
  } finally {
    book.close();
  }
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
