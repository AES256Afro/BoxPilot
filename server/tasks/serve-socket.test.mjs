import { describe, expect, it, vi } from "vitest";
import { loopbackTargetPort, serveSocketMove } from "./serve-socket.mjs";

const socketPath = "/run/boxpilot-web/serve.sock";
const files = (isSocket = true) => ({ readFile: async () => "BOXPILOT_PORT=8787\n", lstat: async () => ({ isSocket: () => isSocket }) });

/** A tailscale CLI whose Serve table starts as `table` (https port → target). */
function tailscale(table, { refuse = null, plain = [] } = {}) {
  const serve = new Map(Object.entries(table).map(([port, target]) => [Number(port), target]));
  const run = vi.fn(async (_binary, args) => {
    if (args[1] === "status") return { ok: true, stdout: JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((port) => [String(port), plain.includes(port) ? { HTTP: true } : { HTTPS: true }])), Web: Object.fromEntries([...serve].map(([port, target]) => [`box.tail1234.ts.net:${port}`, { Handlers: { "/": { Proxy: target } } }])) }), stderr: "" };
    const schemeFlag = args.find((arg) => /^--https?=/.test(arg));
    if (plain.includes(Number(schemeFlag.split("=")[1])) !== schemeFlag.startsWith("--http=")) return { ok: false, stdout: "", stderr: `wrong scheme ${schemeFlag}` };
    const port = Number(schemeFlag.split("=")[1]);
    const target = args.at(-1);
    if (refuse && target.startsWith("unix:") && refuse(port)) return { ok: false, stdout: "", stderr: "invalid proxy target: unix sockets not supported" };
    serve.set(port, target);
    return { ok: true, stdout: "", stderr: "" };
  });
  return { run, serve };
}

describe("moving Tailscale Serve to the socket", () => {
  it("reads which loopback targets are BoxPilot's port", () => {
    expect(loopbackTargetPort("http://127.0.0.1:8787")).toBe(8787);
    expect(loopbackTargetPort("localhost:8787")).toBe(8787);
    expect(loopbackTargetPort("http://192.168.1.5:8787")).toBeNull();
    expect(loopbackTargetPort("https://127.0.0.1:8787")).toBeNull();
    expect(loopbackTargetPort(`unix:${socketPath}`)).toBeNull();
  });

  it("moves every Serve entry for BoxPilot's port and leaves the apps' entries alone", async () => {
    const { run, serve } = tailscale({ 443: "http://127.0.0.1:8787", 8123: "http://127.0.0.1:8123" });
    expect(await serveSocketMove({ run, socketPath, files: files() })).toEqual({ moved: [443], socket: socketPath, already: false });
    expect(serve.get(443)).toBe(`unix:${socketPath}`);
    expect(serve.get(8123)).toBe("http://127.0.0.1:8123");
    // Run again, nothing left to move.
    expect(await serveSocketMove({ run, socketPath, files: files() })).toMatchObject({ moved: [], already: true });
  });

  it("accepts the socket written back as a URL", async () => {
    // Tailscale may report the target as unix:///run/… rather than as it was typed.
    const { run, serve } = tailscale({ 443: "http://127.0.0.1:8787" });
    const reportsUrl = vi.fn(async (binary, args) => {
      const result = await run(binary, args);
      if (args[1] === "status") return { ...result, stdout: result.stdout.replaceAll(`unix:${socketPath}`, `unix://${socketPath}`) };
      return result;
    });
    expect(await serveSocketMove({ run: reportsUrl, socketPath, files: files() })).toMatchObject({ moved: [443], already: false });
    expect(serve.get(443)).toBe(`unix:${socketPath}`);
    expect(await serveSocketMove({ run: reportsUrl, socketPath, files: files() })).toMatchObject({ already: true });
  });

  it("keeps a plain HTTP entry plain", async () => {
    const { run, serve } = tailscale({ 80: "http://127.0.0.1:8787" }, { plain: [80] });
    expect(await serveSocketMove({ run, socketPath, files: files() })).toMatchObject({ moved: [80] });
    expect(serve.get(80)).toBe(`unix:${socketPath}`);
    expect(run).toHaveBeenCalledWith(expect.anything(), ["serve", "--bg", "--yes", "--http=80", `unix:${socketPath}`], expect.anything());
  });

  it("puts back what it moved when Tailscale cannot forward to a socket, and says to update it", async () => {
    const { run, serve } = tailscale({ 443: "http://127.0.0.1:8787", 8443: "http://127.0.0.1:8787" }, { refuse: (port) => port === 8443 });
    await expect(serveSocketMove({ run, socketPath, files: files() })).rejects.toThrow("cannot forward to a socket. Update Tailscale");
    expect(serve.get(443)).toBe("http://127.0.0.1:8787");
    expect(serve.get(8443)).toBe("http://127.0.0.1:8787");
  });

  it("refuses before touching Serve when BoxPilot is not on the socket, or Serve does not forward to it", async () => {
    const { run } = tailscale({ 443: "http://127.0.0.1:8787" });
    await expect(serveSocketMove({ run, socketPath, files: files(false) })).rejects.toThrow("not listening on /run/boxpilot-web/serve.sock");
    expect(run).not.toHaveBeenCalled();
    const other = tailscale({ 443: "http://127.0.0.1:9000" });
    await expect(serveSocketMove({ run: other.run, socketPath, files: files() })).rejects.toThrow("does not forward to BoxPilot's port 8787");
  });
});
