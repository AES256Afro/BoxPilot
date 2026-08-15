import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const defaultStateDirectory = process.platform === "linux" ? "/var/lib/boxpilot" : path.join(os.tmpdir(), "boxpilot");

function safeLimit(value) {
  const parsed = Number.parseInt(value ?? "50", 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
}

export function createAuditLog({
  stateDirectory = process.env.BOXPILOT_STATE_DIRECTORY ?? defaultStateDirectory,
  append = appendFile,
  read = readFile,
  makeDirectory = mkdir,
  checkAccess = access,
} = {}) {
  const resolvedStateDirectory = path.resolve(stateDirectory);
  const auditPath = path.join(resolvedStateDirectory, "audit.jsonl");

  async function record(type, details = {}) {
    await makeDirectory(resolvedStateDirectory, { recursive: true, mode: 0o700 });
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      ...details,
    };
    await append(auditPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
    return event;
  }

  async function list(limitInput) {
    const limit = safeLimit(limitInput);
    let persistent = false;
    try {
      await checkAccess(resolvedStateDirectory, fsConstants.W_OK);
      persistent = process.platform === "linux";
    } catch {
      persistent = false;
    }
    try {
      const contents = await read(auditPath, "utf8");
      const events = contents.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      return { available: true, persistent, events: events.slice(-limit).reverse() };
    } catch (error) {
      if (error.code === "ENOENT") return { available: true, persistent, events: [] };
      return { available: false, persistent, events: [], error: "Audit log is unavailable" };
    }
  }

  return { auditPath, record, list };
}

export function parseAuditLimit(value) {
  return safeLimit(value);
}
