import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, chmod, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtFile, isDnsName, isIpv4, parseCertMeta, webTlsProvision } from "./web-tls.mjs";
import { fixedRun } from "../exec.mjs";

describe("name and address validation", () => {
  it("accepts real DNS names and IPv4 addresses, rejects the rest", () => {
    expect(isDnsName("boxpilot.lan")).toBe(true);
    expect(isDnsName("bigbox")).toBe(true);
    expect(isDnsName("a.b.c.example")).toBe(true);
    expect(isDnsName("bad_name")).toBe(false);
    expect(isDnsName("-nope.lan")).toBe(false);
    expect(isIpv4("192.168.50.20")).toBe(true);
    expect(isIpv4("256.1.1.1")).toBe(false);
    expect(isIpv4("1.2.3")).toBe(false);
  });
});

describe("the leaf extension file", () => {
  it("lists every name and address as a SAN and marks a server, non-CA certificate", () => {
    const text = buildExtFile({ dnsNames: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"] });
    expect(text).toContain("subjectAltName = DNS:boxpilot.lan, DNS:bigbox, IP:192.168.50.20");
    expect(text).toContain("basicConstraints = CA:FALSE");
    expect(text).toContain("extendedKeyUsage = serverAuth");
  });
  it("refuses to build with no names at all", () => {
    expect(() => buildExtFile({ dnsNames: [], ipAddresses: [] })).toThrow(/at least one/);
  });
});

describe("parsing openssl metadata", () => {
  it("pulls the SHA-256 fingerprint and expiry out of the x509 output", () => {
    const meta = parseCertMeta("sha256 Fingerprint=AA:BB:CC\nnotAfter=Sep  1 12:00:00 2027 GMT\n");
    expect(meta.fingerprint).toBe("AA:BB:CC");
    expect(meta.notAfter).toBe("Sep  1 12:00:00 2027 GMT");
  });
});

describe("provisioning against a mocked host", () => {
  function mockFiles(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
      store,
      readFile: async (p) => { if (store.has(p)) return store.get(p); const error = new Error("ENOENT"); error.code = "ENOENT"; throw error; },
      writeFile: async (p, text) => { store.set(p, text); },
      mkdir: async () => {},
      chmod: async () => {},
      rm: async (p) => { store.delete(p); },
    };
  }

  it("creates the CA when absent, issues a leaf, wires the env, opens the port, defers the restart", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "sha256 Fingerprint=11:22\nnotAfter=Jan  1 00:00:00 2027 GMT", stderr: "" }));
    const files = mockFiles({ "/etc/boxpilot/boxpilot.env": "BOXPILOT_HOST=0.0.0.0\n" });
    const result = await webTlsProvision(
      { names: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"], port: 8443 },
      { run, files, dir: "/etc/boxpilot/tls", envPath: "/etc/boxpilot/boxpilot.env" },
    );
    expect(result).toMatchObject({ names: ["boxpilot.lan", "bigbox"], port: 8443, restartScheduled: true });

    const calls = run.mock.calls.map(([binary, args]) => `${binary} ${(args ?? []).join(" ")}`);
    // The CA was generated and self-signed, then a leaf key, CSR and signature.
    expect(calls.some((c) => c.includes("ecparam") && c.includes("ca.key"))).toBe(true);
    expect(calls.some((c) => c.includes("req -x509") && c.includes("ca.crt"))).toBe(true);
    expect(calls.some((c) => c.includes("x509 -req") && c.includes("leaf.crt"))).toBe(true);
    // The key is handed to the web group, the HTTPS port opened, and the restart deferred.
    expect(calls.some((c) => c.startsWith("/bin/chown root:boxpilot"))).toBe(true);
    expect(calls.some((c) => c === "/usr/sbin/ufw allow 8443/tcp")).toBe(true);
    expect(calls.some((c) => c.includes("systemd-run") && c.includes("--on-active 5") && c.includes("restart boxpilot.service"))).toBe(true);

    const env = files.store.get("/etc/boxpilot/boxpilot.env");
    expect(env).toContain("BOXPILOT_TLS_CERT=/etc/boxpilot/tls/leaf.crt");
    expect(env).toContain("BOXPILOT_TLS_KEY=/etc/boxpilot/tls/leaf.key");
    expect(env).toContain("BOXPILOT_TLS_PORT=8443");
  });

  it("reuses an existing CA rather than regenerating it", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "sha256 Fingerprint=11:22\nnotAfter=x", stderr: "" }));
    const files = mockFiles({ "/etc/boxpilot/tls/ca.key": "KEY", "/etc/boxpilot/tls/ca.crt": "CERT" });
    await webTlsProvision({ names: ["boxpilot.lan"], ipAddresses: [] }, { run, files, dir: "/etc/boxpilot/tls", envPath: "/etc/boxpilot/boxpilot.env" });
    const calls = run.mock.calls.map(([binary, args]) => `${binary} ${(args ?? []).join(" ")}`);
    expect(calls.some((c) => c.includes("req -x509"))).toBe(false); // no new CA
    expect(calls.some((c) => c.includes("x509 -req"))).toBe(true); // but a new leaf
  });

  it("rejects bad names and addresses before touching the host", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    await expect(webTlsProvision({ names: [] }, { run })).rejects.toThrow(/at least one/);
    await expect(webTlsProvision({ names: ["bad_name"] }, { run })).rejects.toThrow(/valid DNS name/);
    await expect(webTlsProvision({ names: ["ok.lan"], ipAddresses: ["999.1.1.1"] }, { run })).rejects.toThrow(/valid IPv4/);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a failed restart schedule instead of pretending it applied", async () => {
    const run = vi.fn(async (binary) => (binary.includes("systemd-run") ? { ok: false, stdout: "", stderr: "dbus down" } : { ok: true, stdout: "sha256 Fingerprint=1\nnotAfter=x", stderr: "" }));
    const files = mockFiles({});
    await expect(webTlsProvision({ names: ["boxpilot.lan"] }, { run, files, dir: "/etc/boxpilot/tls", envPath: "/e" })).rejects.toThrow(/could not schedule the restart/);
  });
});

// A genuine end-to-end run: real OpenSSL builds a real CA and leaf in a temp dir, and we prove the
// leaf verifies against the CA and carries the SANs. Guards against argument mistakes a mock hides.
describe("provisioning end to end with real openssl", () => {
  it("produces a leaf that verifies against the CA and covers the names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boxpilot-tls-"));
    const envPath = path.join(dir, "boxpilot.env");
    await writeFile(envPath, "BOXPILOT_HOST=0.0.0.0\n");
    // Run real openssl (resolved from PATH); stub only the root-only side effects.
    const run = async (binary, args, options) => {
      if (binary.endsWith("openssl")) return fixedRun("openssl", args, options);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };
    const files = { readFile, writeFile, mkdir, chmod, rm };

    const result = await webTlsProvision(
      { names: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"], port: 8443 },
      { run, files, dir, envPath },
    );
    expect(result.leafFingerprint).toMatch(/^[0-9A-F:]+$/i);
    expect(result.caFingerprint).toMatch(/^[0-9A-F:]+$/i);

    // openssl verify exits 0 only if the chain is valid.
    const verify = await fixedRun("openssl", ["verify", "-CAfile", path.join(dir, "ca.crt"), path.join(dir, "leaf.crt")]);
    expect(verify.ok).toBe(true);
    expect(verify.stdout).toContain("OK");

    // The SANs made it into the certificate.
    const dump = await fixedRun("openssl", ["x509", "-in", path.join(dir, "leaf.crt"), "-noout", "-text"]);
    expect(dump.stdout).toContain("DNS:boxpilot.lan");
    expect(dump.stdout).toContain("DNS:bigbox");
    expect(dump.stdout).toContain("IP Address:192.168.50.20");

    // The temporary CSR and ext file are cleaned up; keys and certs remain.
    const left = await readdir(dir);
    expect(left).toContain("ca.crt");
    expect(left).toContain("leaf.key");
    expect(left).not.toContain("leaf.csr");
    expect(left).not.toContain("leaf.ext");
    await rm(dir, { recursive: true, force: true });
  });
});
