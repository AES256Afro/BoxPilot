/**
 * Every listening socket on the host, and the process holding each one, for the port check an app
 * runs before `compose up` (server/app-helper.mjs portCheck).
 *
 * A task rather than helper work: the helper runs with PrivateNetwork=true, where `ss` sees only its
 * own empty namespace. And a root task rather than the web service, which can list the sockets but
 * not whose they are: tailscaled, docker-proxy and the rest belong to root, and naming the holder is
 * the point ("taken on the tailnet address by Tailscale Serve", not "address already in use").
 * Read-only: it lists what is there and changes nothing.
 */
import { fixedRun } from "../exec.mjs";
import { parseListeners } from "../ports.mjs";

export const ssBinary = "/usr/bin/ss";

export async function hostListeners(_parameters = {}, { run = fixedRun } = {}) {
  const result = await run(ssBinary, ["-H", "-l", "-n", "-t", "-u", "-p"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (!result.ok) throw new Error(`ss could not list the listening sockets: ${String(result.stderr ?? "").trim().split("\n").slice(-2).join(" ") || `exit ${result.code ?? "?"}`}`);
  return { listeners: parseListeners(result.stdout) };
}
