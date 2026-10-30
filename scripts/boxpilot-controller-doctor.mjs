#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { inspectControllerFiles, addControllerConnectivity } from "../server/controller-doctor.mjs";
import { createHelperClient } from "../server/helper-client.mjs";
import { inspectControllerDatabase } from "../server/controller-database-health.mjs";
import { summarizeDoctor } from "../server/controller-doctor.mjs";
import { defaultEnvPath, readWebEnv } from "../server/tasks/firewall.mjs";
import { localHealthUrl } from "../server/tasks/update.mjs";

export function formatDoctor(report) {
  const lines = ["BoxPilot controller doctor (read-only)", `Checked ${report.checkedAt}`, ""];
  for (const item of report.checks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.title}: ${item.detail}`);
    if (item.status !== "pass" && item.next) lines.push(`  Next: ${item.next}`);
  }
  lines.push("", `Doctor result: ${report.status}. ${report.counts.fail} failed, ${report.counts.unknown} unknown, ${report.counts.warning} warnings.`);
  return lines.join("\n");
}

/**
 * The web service's health, asked where it listens. Run with sudo, this process does not have the
 * service's environment, so the port and address come from its env file (BOXPILOT_PORT and
 * BOXPILOT_HOST here still win); it used to ask 8787 whatever the port, and call a healthy service
 * on another one down.
 */
export async function readWebHealth({ env = process.env, port = env.BOXPILOT_PORT, host = env.BOXPILOT_HOST, envPath = defaultEnvPath, readEnv, fetchImpl = fetch } = {}) {
  if (port === undefined || host === undefined) {
    const fromFile = await readWebEnv({ envPath, ...(readEnv ? { read: readEnv } : {}) });
    port ??= String(fromFile.webPort);
    host ??= fromFile.webHost;
  }
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid BoxPilot loopback port");
  if (!/^[A-Za-z0-9.:-]*$/.test(String(host))) throw new Error("Invalid BoxPilot host");
  const response = await fetchImpl(localHealthUrl({ webHost: String(host), webPort: port }), { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`Web health returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Web health returned no body");
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32 * 1024) throw new Error("Web health response exceeded its size limit");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runControllerDoctor({ inspect = inspectControllerFiles, includeDatabase = false, databaseProbe = inspectControllerDatabase, webProbe = readWebHealth, helperProbe = () => createHelperClient({ maxResponseBytes: 256 * 1024 }).request("system.runtime.inspect", {}, { timeoutMs: 5000 }) } = {}) {
  const [report, web, helper, database] = await Promise.all([inspect(), webProbe().then((value) => ({ value }), () => ({ error: "Web health endpoint did not return a valid response" })), helperProbe().then((value) => ({ value }), () => ({ error: "Helper did not answer this version's diagnostic request; use root or the service account to check protected socket access" })), includeDatabase ? databaseProbe() : null]);
  const connected = addControllerConnectivity(report, { web: web.value, helper: helper.value, webError: web.error, helperError: helper.error });
  if (!database) return connected;
  const checks = [...connected.checks, ...database.checks];
  return { ...connected, database, checks, ...summarizeDoctor(checks) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) console.log("Usage: node scripts/boxpilot-controller-doctor.mjs [--json] [--database]\nService, permissions, release, capacity and connectivity checks. --database adds a bounded SQLite read-only inspection without migrations or record contents. Run with sudo on the Ubuntu host for complete protected-path evidence.");
  else if (args.some((arg) => !["--json", "--database"].includes(arg))) { console.error("Unknown option. Use --help."); process.exitCode = 2; }
  else {
    try {
      const report = await runControllerDoctor({ includeDatabase: args.includes("--database") });
      console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctor(report));
      process.exitCode = report.counts.fail ? 1 : report.counts.unknown ? 2 : 0;
    } catch (error) { console.error(`Doctor could not finish: ${error.message}`); process.exitCode = 2; }
  }
}
