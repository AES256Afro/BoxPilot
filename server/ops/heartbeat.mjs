/**
 * The heartbeat (M39.3, ADR-007): a bare request every few minutes to a dead man's switch the owner
 * chose, so something outside this server notices when it goes quiet. Off until the owner turns it
 * on; owner-only, because it sends something to a third party the owner picked. See server/heartbeat.mjs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineOperation } from "./registry.mjs";
import { dropInDirectory, dropInName, heartbeatCredential, heartbeatTimer, hostOf, intervalChoices, parseDropIn, parseTimerState, readStatus, validateHeartbeatUrl } from "../heartbeat.mjs";

const minutes = (count) => count * 60_000;
const systemctlBinary = () => process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";

/** Everything the Settings panel shows, and nothing that would let anyone send a heartbeat of their own. */
export async function inspectHeartbeat({ credentials, run, read = readFile, status = readStatus } = {}) {
  const [url, shown, dropIn, last] = await Promise.all([
    credentials.read(heartbeatCredential).catch(() => null),
    run(systemctlBinary(), ["show", heartbeatTimer, "--property=LoadState,UnitFileState,ActiveState"], { timeout: 15_000 }).catch(() => ({ ok: false, stdout: "" })),
    read(path.join(dropInDirectory, dropInName), "utf8").catch(() => ""),
    status(),
  ]);
  const timer = shown.ok ? parseTimerState(shown.stdout) : { installed: false, enabled: false, active: false };
  return {
    configured: Boolean(url),
    host: url ? hostOf(url) : null,
    installed: timer.installed,
    enabled: timer.enabled && timer.active,
    intervalMinutes: parseDropIn(dropIn),
    last,
    intervals: intervalChoices,
  };
}

export function heartbeatOperations() {
  return [
    defineOperation({
      // owner: it reads the credential store for the host the address goes to.
      id: "heartbeat.inspect", title: "Read the heartbeat", risk: "low", readOnly: true, minimumRole: "owner", timeoutMs: 30_000,
      description: "Whether the heartbeat is on, how often it pings, which host it pings, and how the last ping went. The address itself is never returned.",
      run: (_parameters, { credentials, run }) => inspectHeartbeat({ credentials, run }),
    }),
    defineOperation({
      id: "heartbeat.set", title: "Turn the heartbeat on or off", risk: "medium", minimumRole: "owner", timeoutMs: minutes(2),
      description: "On: saves the address you pasted as a root-only credential and has this server send a bare request to it every few minutes, so the dead man's switch you chose (healthchecks.io, or Healthchecks or Uptime Kuma on another machine) can alert your phone when the requests stop. Nothing about this server is sent: no name, no address, no status. The first ping goes at once. Off: stops the timer, and forgets the address if you ask.",
      parameters: { fields: {
        enabled: { type: "boolean" },
        url: { type: "string", secret: true, optional: true, maxLength: 2048, validate: (value) => validateHeartbeatUrl(value) },
        intervalMinutes: { type: "number", optional: true, validate: (value) => (intervalChoices.includes(value) ? null : `must be one of ${intervalChoices.join(", ")}`) },
        forget: { type: "boolean", optional: true },
      } },
      run: async (parameters, { credentials, runUnit, jobLog, progress }) => {
        if (parameters.enabled && parameters.forget) throw new Error("The address cannot be forgotten while the heartbeat is on");
        if (parameters.url) {
          await credentials.set({ name: heartbeatCredential, value: parameters.url });
          progress?.(`Saved the heartbeat address (${hostOf(parameters.url)}) as a root-only credential.`, "stdout");
        }
        if (parameters.enabled && !(await credentials.read(heartbeatCredential))) throw new Error("Paste the address your dead man's switch gave you first");
        const result = await runUnit.runTask("heartbeat.configure", { enabled: parameters.enabled, intervalMinutes: parameters.enabled ? parameters.intervalMinutes ?? 5 : null }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null });
        if (!parameters.enabled && parameters.forget) {
          await credentials.remove({ name: heartbeatCredential }).catch(() => null);
          progress?.("Forgot the heartbeat address.", "stdout");
        }
        return result;
      },
    }),
    defineOperation({
      id: "heartbeat.test", title: "Send a test heartbeat", risk: "low", minimumRole: "owner", timeoutMs: minutes(1),
      description: "Sends one heartbeat now, exactly as the timer does: a bare request to the saved address from boxpilot-heartbeat.service. Your dead man's switch should show it within a minute.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("heartbeat.ping", {}, { timeoutMs: 45_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}
