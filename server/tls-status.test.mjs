import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSubjectAltNames, readTlsStatus } from "./tls-status.mjs";
import { fixedRun } from "./exec.mjs";

describe("parsing subject alternative names", () => {
  it("splits DNS names from IP addresses", () => {
    expect(parseSubjectAltNames("DNS:boxpilot.lan, DNS:bigbox, IP Address:192.168.50.20"))
      .toEqual({ dnsNames: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"] });
    expect(parseSubjectAltNames("")).toEqual({ dnsNames: [], ipAddresses: [] });
  });
});

describe("reading the certificate state", () => {
  it("reports not provisioned when there is no leaf, without throwing", async () => {
    const status = await readTlsStatus({ dir: "/nonexistent/tls" });
    expect(status.provisioned).toBe(false);
    expect(typeof status.port).toBe("number");
  });

  it("reads names, fingerprint and expiry from a real certificate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boxpilot-tlsstatus-"));
    const key = path.join(dir, "leaf.key");
    const crt = path.join(dir, "leaf.crt");
    await fixedRun("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    // A self-signed leaf is enough to exercise the reader; SANs via -addext.
    await fixedRun("openssl", [
      "req", "-x509", "-new", "-nodes", "-key", key, "-days", "10", "-out", crt,
      "-subj", "/CN=boxpilot.lan",
      "-addext", "subjectAltName=DNS:boxpilot.lan,DNS:bigbox,IP:192.168.50.20",
    ]);
    await writeFile(path.join(dir, "ca.crt"), await fixedRun("openssl", ["x509", "-in", crt]).then((r) => r.stdout));

    const status = await readTlsStatus({ dir });
    expect(status.provisioned).toBe(true);
    expect(status.names).toEqual(expect.arrayContaining(["boxpilot.lan", "bigbox"]));
    expect(status.ipAddresses).toContain("192.168.50.20");
    expect(status.fingerprint).toMatch(/^[0-9A-F:]+$/i);
    expect(status.notAfter).toBeTruthy();
    await rm(dir, { recursive: true, force: true });
  });
});
