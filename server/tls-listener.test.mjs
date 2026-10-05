import { describe, expect, it, vi } from "vitest";
import { startTlsListener } from "./tls-listener.mjs";

const quietLog = { warn: () => {}, log: () => {} };

describe("the optional HTTPS listener", () => {
  it("does nothing when no certificate is configured", () => {
    const createServer = vi.fn();
    const server = startTlsListener({}, { env: {}, createServer, log: quietLog });
    expect(server).toBeNull();
    expect(createServer).not.toHaveBeenCalled();
  });

  it("starts a TLS server with the configured certificate and port", () => {
    const listen = vi.fn((_port, _host, cb) => cb?.());
    const on = vi.fn();
    const createServer = vi.fn(() => ({ listen, on }));
    const readFile = vi.fn((p) => (p.endsWith(".crt") ? "CERT" : "KEY"));
    const app = {};
    const server = startTlsListener(app, {
      host: "0.0.0.0",
      env: { BOXPILOT_TLS_CERT: "/tls/leaf.crt", BOXPILOT_TLS_KEY: "/tls/leaf.key", BOXPILOT_TLS_PORT: "8443" },
      readFile, createServer, log: quietLog,
    });
    expect(server).not.toBeNull();
    expect(createServer).toHaveBeenCalledWith({ cert: "CERT", key: "KEY" }, app);
    expect(listen).toHaveBeenCalledWith(8443, "0.0.0.0", expect.any(Function));
  });

  it("returns null and warns when the certificate cannot be read, rather than throwing", () => {
    const createServer = vi.fn();
    const warn = vi.fn();
    const readFile = vi.fn(() => { throw new Error("EACCES"); });
    const server = startTlsListener({}, {
      env: { BOXPILOT_TLS_CERT: "/tls/leaf.crt", BOXPILOT_TLS_KEY: "/tls/leaf.key" },
      readFile, createServer, log: { warn, log: () => {} },
    });
    expect(server).toBeNull();
    expect(createServer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be read"));
  });

  it("survives a listener error without throwing", () => {
    let errorHandler;
    const server = { listen: (_p, _h, cb) => cb?.(), on: (event, handler) => { if (event === "error") errorHandler = handler; } };
    const onError = vi.fn();
    startTlsListener({}, {
      env: { BOXPILOT_TLS_CERT: "/c", BOXPILOT_TLS_KEY: "/k" },
      readFile: () => "X", createServer: () => server, log: quietLog, onError,
    });
    expect(() => errorHandler(new Error("EADDRINUSE"))).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  // A hand-edited BOXPILOT_TLS_PORT that is no port made listen() throw at once, before any "error"
  // event, and index.mjs runs this at load: the whole web service crash-looped, HTTP too (sweep 5).
  it.each(["", "abc", "70000", "-1", "0"])("falls back to 8443 for a TLS port of %j instead of throwing", (value) => {
    const listen = vi.fn((port, _host, cb) => {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("ERR_SOCKET_BAD_PORT");
      cb?.();
    });
    const warn = vi.fn();
    const server = startTlsListener({}, {
      env: { BOXPILOT_TLS_CERT: "/c", BOXPILOT_TLS_KEY: "/k", BOXPILOT_TLS_PORT: value },
      readFile: () => "X", createServer: () => ({ listen, on: () => {} }), log: { warn, log: () => {} },
    });
    expect(server).not.toBeNull();
    expect(listen).toHaveBeenCalledWith(8443, "127.0.0.1", expect.any(Function));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is not a port"));
  });

  it("takes the port the way the env file gives it, a comment and all", () => {
    const listen = vi.fn((_port, _host, cb) => cb?.());
    startTlsListener({}, {
      env: { BOXPILOT_TLS_CERT: "/c", BOXPILOT_TLS_KEY: "/k", BOXPILOT_TLS_PORT: "9443   # https" },
      readFile: () => "X", createServer: () => ({ listen, on: () => {} }), log: quietLog,
    });
    expect(listen).toHaveBeenCalledWith(9443, "127.0.0.1", expect.any(Function));
  });

  it("returns null rather than throwing when listen itself throws", () => {
    const close = vi.fn();
    const warn = vi.fn();
    const server = startTlsListener({}, {
      env: { BOXPILOT_TLS_CERT: "/c", BOXPILOT_TLS_KEY: "/k" },
      readFile: () => "X", createServer: () => ({ listen: () => { throw new Error("EACCES"); }, on: () => {}, close }), log: { warn, log: () => {} },
    });
    expect(server).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP is still serving"));
  });
});
