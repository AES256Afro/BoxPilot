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
});
