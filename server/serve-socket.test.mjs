import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { isServeSocketTarget, startServeSocketListener, viaServeSocket } from "./serve-socket.mjs";

const cleanup = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const app = (request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ viaSocket: viaServeSocket(request), remote: request.socket.remoteAddress }));
};
const ask = (socketPath) => new Promise((resolve, reject) => {
  const sent = httpRequest({ socketPath, path: "/", headers: { "x-forwarded-for": "100.67.166.49" } }, (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve(JSON.parse(body)));
  });
  sent.on("error", reject);
  sent.end();
});

describe("the Tailscale Serve socket", () => {
  it.skipIf(onWindows)("marks what arrives on it, reads as loopback, and is open to its owner alone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-serve-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = path.join(directory, "serve.sock");
    // A socket the last run left behind is replaced (a crash leaves the file; here it is still open).
    const stale = await startServeSocketListener(app, { socketPath });
    cleanup.push(() => new Promise((resolve) => stale.close(() => resolve())));
    const server = await startServeSocketListener(app, { socketPath });
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    expect(await ask(socketPath)).toEqual({ viaSocket: true, remote: "127.0.0.1" });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(viaServeSocket({ socket: { remoteAddress: "127.0.0.1" } })).toBe(false);
  });

  it.skipIf(onWindows)("does nothing without its directory, and leaves alone a file that is not a socket", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-serve-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    expect(await startServeSocketListener(app, { socketPath: path.join(directory, "missing", "serve.sock") })).toBeNull();
    const notSocket = path.join(directory, "serve.sock");
    await writeFile(notSocket, "keep me");
    expect(await startServeSocketListener(app, { socketPath: notSocket, log: { warn: () => {} } })).toBeNull();
    expect((await stat(notSocket)).isFile()).toBe(true);
  });
});

describe("naming the Serve socket as a proxy target", () => {
  it("matches the socket however tailscale writes it, and nothing else", () => {
    const socket = "/run/boxpilot-web/serve.sock";
    expect(isServeSocketTarget(`unix:${socket}`, socket)).toBe(true);
    expect(isServeSocketTarget(`unix://${socket}`, socket)).toBe(true);
    expect(isServeSocketTarget("unix:/run/boxpilot-web/../boxpilot-web/serve.sock", socket)).toBe(true);
    expect(isServeSocketTarget("unix:/run/other/serve.sock", socket)).toBe(false);
    expect(isServeSocketTarget("http://127.0.0.1:8787", socket)).toBe(false);
    expect(isServeSocketTarget(null, socket)).toBe(false);
  });
});
