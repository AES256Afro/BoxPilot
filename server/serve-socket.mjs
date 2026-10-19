/**
 * A Unix socket Tailscale Serve can proxy to instead of the loopback port.
 *
 * Behind Serve every request arrives from loopback carrying the caller's tailnet address and login,
 * and BoxPilot believes those headers because Serve put them there. But anything on this machine
 * can open the loopback port and write the same headers: an app on the host network (Home
 * Assistant, Plex) included. Such an app is opened through Serve on this same hostname, so it is
 * also sent BoxPilot's cookies (cookies do not care about ports) and Serve's headers naming the
 * owner: everything it needs to replay a session or claim a Tailscale sign-in through loopback.
 *
 * A socket in a directory only BoxPilot's user (and root, which tailscaled runs as) can open is out
 * of reach of a container, host network or not. When Serve proxies to it, forwarded headers are
 * believed there and no longer on the loopback port (identity.mjs).
 */
import { createServer } from "node:http";
import { chmod, lstat, rm, stat } from "node:fs/promises";
import path from "node:path";

export const defaultServeSocket = "/run/boxpilot-web/serve.sock";

export function serveSocketPath(env = process.env) {
  return env.BOXPILOT_SERVE_SOCKET || defaultServeSocket;
}

/** Whether this request came in over the Serve socket rather than a TCP port. */
export function viaServeSocket(request) {
  return request?.socket?.boxpilotServeSocket === true;
}

/**
 * Listen on the socket with the same app as the TCP listener. Every connection is marked, and reads
 * as loopback to code that looks at the peer address, which is what Serve over the loopback port
 * looked like. Skipped (null) when the socket's directory does not exist: a development checkout,
 * or a unit without RuntimeDirectory=boxpilot-web.
 */
export async function startServeSocketListener(app, { socketPath = serveSocketPath(), log = console } = {}) {
  const directory = path.dirname(socketPath);
  const folder = await stat(directory).catch(() => null);
  if (!folder?.isDirectory()) return null;
  // A socket left by the last run is replaced; anything else at that path is not ours to remove.
  const existing = await lstat(socketPath).catch(() => null);
  if (existing && !existing.isSocket()) {
    log.warn?.(`Not listening on ${socketPath}: something other than a socket is there`);
    return null;
  }
  if (existing) await rm(socketPath, { force: true });
  const server = createServer(app);
  server.on("connection", (socket) => {
    Object.defineProperty(socket, "boxpilotServeSocket", { value: true });
    Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(socketPath, 0o600).catch(() => {});
  return server;
}
