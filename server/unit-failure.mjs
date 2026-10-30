/**
 * Why a oneshot unit that `systemctl start` reported as failed actually failed.
 *
 * `systemctl start` waits for a oneshot and exits non-zero whether the script ran and decided to
 * fail or the process died before the script executed a line. The libvirt foundation helper told the
 * owner the service had "failed and requested automatic rollback" when node had dumped core in V8's
 * isolate setup under a sandbox directive it could not live with (`Result: core-dump`,
 * `status=5/TRAP`): nothing had run, so nothing had been rolled back. systemd keeps the distinction
 * in three unit properties; a helper reads them after a failed start so its error says which it was.
 */

export const unitFailureProperties = Object.freeze(["Result", "ExecMainCode", "ExecMainStatus"]);

/** The `systemctl show` arguments that ask for the three properties, one `-p` each. */
export function unitFailureShowArgs(unit) {
  return ["show", unit, ...unitFailureProperties.flatMap((property) => ["-p", property])];
}

/**
 * The three properties from a `systemctl show` answer, or null when one is missing or not a number.
 *
 * `ExecMainCode` is how the main process ended: 1 exited, 2 killed by a signal, 3 dumped core, and 0
 * while it has not ended. `ExecMainStatus` is the exit status for 1 and the signal number for 2 and 3.
 *
 * @param {string} stdout
 * @returns {{ result: string, code: number, status: number } | null}
 */
export function parseUnitFailure(stdout) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const numeric = /^\d{1,9}$/;
  if (!values.Result || !numeric.test(values.ExecMainCode ?? "") || !numeric.test(values.ExecMainStatus ?? "")) return null;
  return { result: values.Result, code: Number(values.ExecMainCode), status: Number(values.ExecMainStatus) };
}

/**
 * One sentence on why `unit` failed, for the error a helper throws after a failed `systemctl start`.
 *
 * - `core-dump` (ExecMainCode 3): the process died before the script ran, with the signal; `unchanged`
 *   says what that leaves untouched.
 * - `exit-code` (ExecMainCode 1): the script spoke, so `fallback` keeps its wording, with the status.
 * - `timeout` and `signal` get a sentence each.
 * - Anything else, or a show that cannot be read, is `fallback`: what the helper said before.
 *
 * @param {{ run: (binary: string, args: string[], options?: { timeout?: number }) => Promise<{ ok: boolean, stdout?: string }>, systemctlBinary: string, unit: string, subject: string, fallback?: string, unchanged?: string | null }} options
 * @returns {Promise<string>}
 */
export async function unitFailureMessage({ run, systemctlBinary, unit, subject, fallback = `${subject} failed`, unchanged = null }) {
  let shown;
  try {
    shown = await run(systemctlBinary, unitFailureShowArgs(unit), { timeout: 10_000 });
  } catch {
    return fallback;
  }
  const failure = shown?.ok ? parseUnitFailure(shown.stdout) : null;
  if (!failure) return fallback;
  if (failure.result === "core-dump" && failure.code === 3) return `${subject}'s process died (signal ${failure.status}) before the script ran${unchanged ? `; ${unchanged}` : ""}`;
  if (failure.result === "exit-code" && failure.code === 1) return `${fallback} (exit status ${failure.status})`;
  if (failure.result === "timeout") return `${subject} ran out of time and systemd stopped it before it finished`;
  if (failure.result === "signal" && failure.code === 2) return `${subject}'s process was killed by signal ${failure.status} before it finished`;
  return fallback;
}
