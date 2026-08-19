#!/usr/local/bin/node
/**
 * Generic root task runner, started as `boxpilot-run@<id>.service` by the BoxPilot helper.
 *
 * The helper writes /run/boxpilot/run/<id>.json (mode 0600, root) containing
 *   { task, parameters, approvedAt, timeoutMs }
 * then starts the template unit. This script runs the named task from server/tasks and writes
 * /run/boxpilot/run/<id>.result.json = { ok, task, result } | { ok: false, task, error }.
 * It refuses anything not in the task table, a malformed id, or a stale approval.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tasks } from "../server/tasks/index.mjs";

export const runDirectory = process.env.BOXPILOT_RUN_DIRECTORY ?? "/run/boxpilot/run";
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxApprovalAgeMs = 5 * 60 * 1000;

export function parseSpec(raw, now = new Date()) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Task spec is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task spec must be an object");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "approvedAt,parameters,task,timeoutMs") throw new Error("Task spec has unexpected fields");
  if (typeof value.task !== "string" || !Object.prototype.hasOwnProperty.call(tasks, value.task)) throw new Error("Task is not in the root task table");
  if (!value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters)) throw new Error("Task parameters must be an object");
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 24 * 60 * 60 * 1000) throw new Error("Task timeout is out of range");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30_000 || age > maxApprovalAgeMs) throw new Error("Task approval is stale");
  return value;
}

async function writeResult(id, payload) {
  const target = path.join(runDirectory, `${id}.result.json`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
}

export async function runTask(id, { now = () => new Date(), taskTable = tasks } = {}) {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Task id must be a UUID");
  const specPath = path.join(runDirectory, `${id}.json`);
  const spec = parseSpec(await readFile(specPath, "utf8"), now());
  const task = taskTable[spec.task];
  let payload;
  const timer = new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`Task ${spec.task} exceeded ${spec.timeoutMs} ms`)), spec.timeoutMs).unref?.());
  try {
    const result = await Promise.race([task(spec.parameters), timer]);
    payload = { ok: true, task: spec.task, result };
  } catch (error) {
    payload = { ok: false, task: spec.task, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await unlink(specPath).catch(() => {});
  }
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeResult(id, payload);
  return payload;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error("Usage: boxpilot-run.mjs <task-id>");
    process.exitCode = 64;
  } else {
    try {
      const payload = await runTask(process.argv[2]);
      if (payload.ok) console.log(`Task ${payload.task} completed`);
      else { console.error(`Task ${payload.task} failed: ${payload.error}`); process.exitCode = 1; }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
