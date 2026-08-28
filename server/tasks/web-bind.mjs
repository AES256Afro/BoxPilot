/**
 * Where the BoxPilot control plane listens (M18.1).
 *
 * By default the web service binds loopback and is reached over the tailnet through Tailscale
 * Serve, which is perfect away from home and invisible on the LAN. This lets the owner also serve
 * it on the network address, so a device that is not on the tailnet can reach it.
 *
 * It is safe: binding 0.0.0.0 is a superset of loopback, so the Serve path keeps working and the
 * owner cannot be locked out. The identity trust is unchanged — a LAN request is neither a tailnet
 * address nor a Serve-fronted loopback hop, so it earns no automatic Tailscale identity and must
 * present the password. The one honest cost, that the password crosses the LAN in the clear until
 * HTTPS-on-the-LAN lands, is stated to the owner rather than hidden.
 *
 * Root-side (writes /etc/boxpilot, opens the firewall, restarts the service). The restart is
 * scheduled a few seconds out so this task can report success before the web process it belongs to
 * goes down and comes back on the new bind.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

const envPath = process.env.BOXPILOT_ENV_FILE ?? "/etc/boxpilot/boxpilot.env";
const systemctl = "/usr/bin/systemctl";
const systemdRun = "/usr/bin/systemd-run";
const ufw = "/usr/sbin/ufw";
const loopback = "127.0.0.1";
const allInterfaces = "0.0.0.0";

/** Set or replace one KEY=value line in an env file's text, appending if absent. */
export function setEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}

/** The port the control plane listens on, from the env file or the default. */
function portFromEnv(text) {
  const match = /^BOXPILOT_PORT=(\d{1,5})$/m.exec(text);
  return match ? match[1] : "8787";
}

export async function webBindSet({ scope } = {}, { run = fixedRun, log = null, files = { readFile, writeFile } } = {}) {
  if (!["lan", "loopback"].includes(scope)) throw new Error("scope must be lan or loopback");
  const before = await files.readFile(envPath, "utf8").catch(() => "");
  const port = portFromEnv(before);
  const host = scope === "lan" ? allInterfaces : loopback;
  const after = setEnvValue(before, "BOXPILOT_HOST", host);
  log?.(`Setting the control plane to listen on ${host}:${port}`, "stdout");
  await files.writeFile(envPath, after);

  // Open (or close) the web port for the network, so binding it is not undone by the firewall.
  // Idempotent: ufw allow twice is a no-op, and delete of an absent rule is harmless.
  if (scope === "lan") await run(ufw, ["allow", `${port}/tcp`], { timeout: 30_000 }).catch(() => {});
  else await run(ufw, ["--force", "delete", "allow", `${port}/tcp`], { timeout: 30_000 }).catch(() => {});

  // Restart a few seconds out so the response returns first; 0.0.0.0 keeps loopback, so even if the
  // restart hiccups the Serve/tailnet path is unaffected.
  const scheduled = await run(systemdRun, ["--quiet", "--on-active", "5", "--unit", "boxpilot-rebind", systemctl, "restart", "boxpilot.service"], { timeout: 30_000 });
  if (!scheduled.ok) throw new Error(`Wrote the new bind but could not schedule the restart: ${scheduled.stderr || "systemd-run failed"}. Restart boxpilot.service to apply it.`);
  return { scope, host, port, restartScheduled: true };
}
