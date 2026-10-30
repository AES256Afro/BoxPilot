/**
 * The agents runner's key, in the web process: issued into a root-readable file that systemd's
 * LoadCredential hands the runner, kept here only as its digest, and checked on every call the
 * runner makes. Part of the agents service (service.mjs), which hands it what it uses.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digestToken } from "./store.mjs";

/**
 * @param {{
 *   state: any, now: () => Date, audit: (type: string, entry: object) => void, tokenPath: string | null,
 *   runnerTokenKey: string,
 * }} deps
 */
export function createRunnerKey({ state, now, audit, tokenPath, runnerTokenKey }) {
  let issuing = null;   // the runner's key being issued, so two callers never make two keys

  function tokenFile() {
    return tokenPath ?? path.join(path.dirname(state.databasePath ?? path.join(os.tmpdir(), "boxpilot", "x")), "agents", "runner.token");
  }

  /**
   * The runner's key: a random value in a root-readable file (systemd's LoadCredential hands it over);
   * only its digest is kept. One issue at a time: turning Agents on starts one in the background, and
   * a second caller racing it would otherwise leave the file holding one key and the digest another.
   */
  function ensureRunnerToken({ rotate = false } = {}) {
    const next = (issuing ?? Promise.resolve()).then(() => issueRunnerToken({ rotate }));
    const settled = next.catch(() => null).then(() => { if (issuing === settled) issuing = null; });
    issuing = settled;
    return next;
  }

  async function issueRunnerToken({ rotate }) {
    const saved = state.getSetting?.(runnerTokenKey, null);
    if (saved?.hash && !rotate) return { issued: false, path: tokenFile() };
    const token = randomBytes(32).toString("base64url");
    const file = tokenFile();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    state.setSetting(runnerTokenKey, { hash: digestToken(token), issuedAt: now().toISOString() }, { updatedBy: null });
    audit("agents.runner.key-issued", { details: { rotated: Boolean(saved?.hash) } });
    return { issued: true, path: file };
  }

  function verifyRunnerToken(token) {
    const saved = state.getSetting?.(runnerTokenKey, null);
    if (!saved?.hash || typeof token !== "string" || token.length < 20 || token.length > 200) return false;
    const given = Buffer.from(digestToken(token));
    const expected = Buffer.from(saved.hash);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  return { ensureRunnerToken, verifyRunnerToken };
}
