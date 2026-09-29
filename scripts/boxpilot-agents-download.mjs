#!/usr/bin/env node
/**
 * Fetch or remove a model in the agents runner's Hugging Face cache (M37), as the runner's own user.
 * Started by the root tasks agents.model.download and agents.model.remove through runuser, so the
 * work that touches the runner's files runs with the runner's rights and no more. Progress goes to
 * stdout a line at a time; the last line is the result as JSON.
 *
 *   boxpilot-agents-download.mjs download <state-dir> '<{"repo","file","projector"}>'
 *   boxpilot-agents-download.mjs remove   <state-dir> '<{"repo","file","projector","current"}>'
 */
import { downloadModel, removeModel } from "../server/agents/download.mjs";

const [action, stateDir, raw] = process.argv.slice(2);
try {
  if (!["download", "remove"].includes(action) || !stateDir) throw new Error("usage: boxpilot-agents-download.mjs download|remove <state-dir> '<json>'");
  const parameters = JSON.parse(raw ?? "{}");
  const log = (line) => process.stdout.write(`${line}\n`);
  const result = action === "download" ? await downloadModel(parameters, { stateDir, log }) : await removeModel(parameters, { stateDir });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
  process.exitCode = 1;
}
