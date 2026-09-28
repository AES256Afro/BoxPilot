#!/usr/bin/env node
/**
 * Audit npm dependencies against a reviewed list of accepted advisories.
 *   node scripts/dependency-audit.mjs          # exit 1 on an untriaged or expired production advisory
 *
 * Production dependencies ship to every server and run as the web process, so an advisory in one
 * of them fails the run at moderate severity or above. Development dependencies never leave the
 * build machine: their advisories are reported as warnings, not failures.
 *
 * Triage (ROADMAP-V2 M29.4): when an advisory cannot be fixed yet (no patched release, or the
 * vulnerable path is unreachable here), add it to `.github/audit-triage.json` with the advisory
 * id, the package, why it is acceptable, the date it was reviewed and a date it expires. An expired
 * entry fails the run again, so an acceptance is a decision with a deadline, not a silence.
 * Entries that no longer match anything are reported so the list does not rot.
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
export const blockingSeverity = "moderate";

/** The advisories in an `npm audit --json` report, one entry per advisory id. */
export function advisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || !via) continue;
      const id = via.url?.match(/GHSA-[a-z0-9-]+/i)?.[0] ?? `npm-${via.source}`;
      if (!found.has(id)) found.set(id, { id, package: via.name, title: via.title, severity: via.severity, range: via.range, url: via.url });
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sort production advisories into blocking and accepted, flag expired and unused triage entries,
 * and list development-only advisories as warnings.
 */
export function evaluate({ production, all, triage, now = () => new Date() }) {
  const today = now().toISOString().slice(0, 10);
  const accepted = new Map((triage?.accepted ?? []).map((entry) => [entry.advisory, entry]));
  const productionAdvisories = advisories(production);
  const productionIds = new Set(productionAdvisories.map((advisory) => advisory.id));
  const result = { blocking: [], accepted: [], expired: [], belowThreshold: [], development: [], unused: [] };
  for (const advisory of productionAdvisories) {
    const entry = accepted.get(advisory.id);
    if (entry && entry.expires >= today) result.accepted.push({ ...advisory, entry });
    else if (entry) result.expired.push({ ...advisory, entry });
    else if ((severityRank[advisory.severity] ?? severityRank.critical) >= severityRank[blockingSeverity]) result.blocking.push(advisory);
    else result.belowThreshold.push(advisory);
  }
  result.development = advisories(all).filter((advisory) => !productionIds.has(advisory.id));
  const seen = new Set([...productionIds, ...result.development.map((advisory) => advisory.id)]);
  result.unused = [...accepted.values()].filter((entry) => !seen.has(entry.advisory));
  return result;
}

export function failed(result) {
  return result.blocking.length > 0 || result.expired.length > 0;
}

export function report(result) {
  const describe = (advisory) => `${advisory.id} ${advisory.package} (${advisory.severity}): ${advisory.title}${advisory.url ? ` ${advisory.url}` : ""}`;
  const lines = [];
  for (const advisory of result.blocking) lines.push(`BLOCKING    ${describe(advisory)}`);
  for (const advisory of result.expired) lines.push(`EXPIRED     ${describe(advisory)} — accepted until ${advisory.entry.expires}: review it again`);
  for (const advisory of result.accepted) lines.push(`accepted    ${describe(advisory)} — until ${advisory.entry.expires}: ${advisory.entry.reason}`);
  for (const advisory of result.belowThreshold) lines.push(`low         ${describe(advisory)}`);
  for (const advisory of result.development) lines.push(`dev only    ${describe(advisory)}`);
  for (const entry of result.unused) lines.push(`unused      ${entry.advisory} is in the triage list but no longer reported; remove it`);
  if (!lines.length) lines.push("No known advisories in production or development dependencies.");
  return lines;
}

function npmAudit(flags) {
  return new Promise((resolve, reject) => {
    // A fixed command line through the shell, so `npm` resolves to npm.cmd on Windows too.
    // npm exits non-zero whenever it finds anything; the JSON on stdout is the answer either way.
    exec(`npm audit --json ${flags}`.trim(), { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) return reject(new Error(`npm audit: ${parsed.error.summary ?? JSON.stringify(parsed.error)}`));
        resolve(parsed);
      } catch {
        reject(new Error(`npm audit returned no report${error ? `: ${stderr || error.message}` : ""}`));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const triage = JSON.parse(await readFile(path.join(root, ".github", "audit-triage.json"), "utf8"));
  const [production, all] = await Promise.all([npmAudit("--omit=dev"), npmAudit("")]);
  const result = evaluate({ production, all, triage });
  for (const line of report(result)) console.log(line);
  if (process.env.GITHUB_ACTIONS) {
    for (const advisory of [...result.development, ...result.belowThreshold]) console.log(`::warning::${advisory.id} in ${advisory.package}: ${advisory.title}`);
    for (const entry of result.unused) console.log(`::warning::${entry.advisory} is in .github/audit-triage.json but no longer reported; remove it`);
  }
  process.exitCode = failed(result) ? 1 : 0;
}
