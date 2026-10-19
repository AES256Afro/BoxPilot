/**
 * Point Tailscale Serve at BoxPilot's socket instead of its loopback port (server/serve-socket.mjs
 * says why). Runs in the helper: `tailscale serve` changes need root.
 */
import { lstat, readFile } from "node:fs/promises";
import { webListenFromEnv } from "../env-file.mjs";
import { fixedRun } from "../exec.mjs";
import { isServeSocketTarget, serveSocketPath } from "../serve-socket.mjs";
import { parseServeStatus } from "../tailscale-serve.mjs";

const envPath = process.env.BOXPILOT_ENV_FILE ?? "/etc/boxpilot/boxpilot.env";
const tailscaleBinary = () => process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale";

/** The port a Serve target forwards to when it is a loopback HTTP address, else null. */
export function loopbackTargetPort(target) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(target)) ? String(target) : `http://${target}`);
    if (url.protocol !== "http:") return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!(host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))) return null;
    return url.port === "" ? 80 : Number(url.port);
  } catch { return null; }
}

export async function serveSocketMove({ run = fixedRun, log = null, socketPath = serveSocketPath(), files = { readFile, lstat } } = {}) {
  const socket = await files.lstat(socketPath).catch(() => null);
  if (!socket?.isSocket()) throw new Error(`BoxPilot is not listening on ${socketPath}. Restart BoxPilot after updating it, then try again.`);
  const { webPort } = webListenFromEnv(await files.readFile(envPath, "utf8").catch(() => ""));
  const status = async () => {
    const result = await run(tailscaleBinary(), ["serve", "status", "--json"], { timeout: 15_000 }).catch(() => null);
    if (!result?.ok) throw new Error("Could not read Tailscale Serve's settings; is Tailscale running?");
    return parseServeStatus(result.stdout);
  };
  const target = `unix:${socketPath}`;
  const before = await status();
  const ours = before.filter((serve) => loopbackTargetPort(serve.target) === webPort);
  if (!ours.length) {
    if (before.some((serve) => isServeSocketTarget(serve.target, socketPath))) return { moved: [], socket: socketPath, already: true };
    throw new Error(`Tailscale Serve does not forward to BoxPilot's port ${webPort}, so there is nothing to move.`);
  }
  const moved = [];
  try {
    for (const serve of ours) {
      const args = ["serve", "--bg", "--yes", `--https=${serve.port}`, target];
      log?.(`$ tailscale ${args.join(" ")}`, "stdout");
      const result = await run(tailscaleBinary(), args, { timeout: 60_000 });
      if (!result.ok) {
        const said = String(result.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
        throw new Error(/unix|socket|invalid|unsupported/i.test(said)
          ? `This version of Tailscale cannot forward to a socket. Update Tailscale, then try again. (${said})`
          : `tailscale serve failed: ${said || "is Tailscale running?"}`);
      }
      moved.push(serve);
    }
    const after = await status();
    const missing = ours.filter((serve) => !isServeSocketTarget(after.find((entry) => entry.port === serve.port)?.target, socketPath));
    if (missing.length) throw new Error(`Tailscale accepted the change but port ${missing.map((serve) => serve.port).join(", ")} does not forward to the socket; check tailscale serve status.`);
  } catch (error) {
    // Put back what was moved, so the tailnet address keeps reaching BoxPilot the way it did.
    for (const serve of moved) await run(tailscaleBinary(), ["serve", "--bg", "--yes", `--https=${serve.port}`, serve.target], { timeout: 60_000 }).catch(() => null);
    throw error;
  }
  log?.(`Tailscale Serve forwards to ${socketPath} on port ${ours.map((serve) => serve.port).join(", ")}`, "stdout");
  return { moved: ours.map((serve) => serve.port), socket: socketPath, already: false };
}
