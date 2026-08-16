import { describe, expect, it, vi } from "vitest";
import { dnsAcceptanceInternals } from "../server/dns-acceptance.mjs";
import { agentInternals } from "./boxpilot-agent.mjs";

function task(type, checks, boundary = {}) {
  return {
    type,
    payload: {
      schemaVersion: 1,
      resolverAddress: "192.168.8.1",
      checkpointId: "checkpoint-one",
      checks: checks.map((check) => ({ id: check.id, protocol: check.protocol, name: check.name, type: "A", expectedRcode: check.expectedRcode, port: 53 })),
      boundary: { arbitraryCommand: false, arbitraryTarget: false, targetMustEqualNodeDefaultGateway: true, routerMutation: false, dnsCutover: false, dhcpMutation: false, clientSettingsMutation: false, modelAttestation: false, ...boundary },
    },
  };
}

describe("BoxPilot signed agent fixed task contracts", () => {
  it("runs the fixed Flint 2 query set without accepting a target from the operator", async () => {
    const queryDns = vi.fn(async (_resolver, check) => ({
      id: check.id, protocol: check.protocol, name: check.name, type: "A", expectedRcode: check.expectedRcode,
      rcode: check.expectedRcode, answers: check.requireAnswers ? 1 : 0, recursionAvailable: true, truncated: false, latencyMs: 2, passed: true,
    }));
    const resolveDefaultGateway = vi.fn(async () => "192.168.8.1");
    const result = await agentInternals.runFixedDnsChecks(task("dns.flint2-adguard.acceptance.v1", dnsAcceptanceInternals.flint2AdguardChecks), { queryDns, resolveDefaultGateway });
    expect(resolveDefaultGateway).toHaveBeenCalledOnce();
    expect(queryDns).toHaveBeenCalledTimes(4);
    expect(queryDns.mock.calls.map(([resolver, check]) => `${resolver}|${check.protocol}:${check.name}`)).toEqual([
      "192.168.8.1|udp:example.com", "192.168.8.1|tcp:example.com", "192.168.8.1|udp:example.net", "192.168.8.1|udp:boxpilot.invalid",
    ]);
    expect(result.every((check) => check.passed)).toBe(true);
  });

  it("rejects an altered Flint 2 check, missing checkpoint, or widened boundary before a query", async () => {
    const queryDns = vi.fn();
    const changed = task("dns.flint2-adguard.acceptance.v1", dnsAcceptanceInternals.flint2AdguardChecks);
    changed.payload.checks[0] = { ...changed.payload.checks[0], name: "operator.example" };
    const resolveDefaultGateway = vi.fn(async () => "192.168.8.1");
    await expect(agentInternals.runFixedDnsChecks(changed, { queryDns, resolveDefaultGateway })).rejects.toThrow("changed the fixed DNS check contract");
    const missingCheckpoint = task("dns.flint2-adguard.acceptance.v1", dnsAcceptanceInternals.flint2AdguardChecks);
    delete missingCheckpoint.payload.checkpointId;
    await expect(agentInternals.runFixedDnsChecks(missingCheckpoint, { queryDns, resolveDefaultGateway })).rejects.toThrow("local-gateway, no-write, and no-attestation boundary");
    const widened = task("dns.flint2-adguard.acceptance.v1", dnsAcceptanceInternals.flint2AdguardChecks, { routerMutation: true });
    await expect(agentInternals.runFixedDnsChecks(widened, { queryDns, resolveDefaultGateway })).rejects.toThrow("no-command and no-cutover boundary");
    const mismatch = task("dns.flint2-adguard.acceptance.v1", dnsAcceptanceInternals.flint2AdguardChecks);
    await expect(agentInternals.runFixedDnsChecks(mismatch, { queryDns, resolveDefaultGateway: vi.fn(async () => "192.168.8.254") })).rejects.toThrow("does not match this agent's local default gateway");
    expect(queryDns).not.toHaveBeenCalled();
  });

  it("parses only one fixed local default gateway on Linux and macOS", async () => {
    const linuxExec = vi.fn(async () => ({ stdout: JSON.stringify([{ dst: "default", gateway: "192.168.8.1", dev: "eno1" }]) }));
    await expect(agentInternals.detectDefaultIpv4Gateway({ platform: "linux", exec: linuxExec })).resolves.toBe("192.168.8.1");
    expect(linuxExec).toHaveBeenCalledWith("/usr/sbin/ip", ["-j", "-4", "route", "show", "default"], expect.objectContaining({ timeout: 3000 }));
    const macExec = vi.fn(async () => ({ stdout: "   route to: default\ndestination: default\n    gateway: 192.168.8.1\n  interface: en0\n" }));
    await expect(agentInternals.detectDefaultIpv4Gateway({ platform: "darwin", exec: macExec })).resolves.toBe("192.168.8.1");
    await expect(agentInternals.detectDefaultIpv4Gateway({ platform: "win32", exec: vi.fn() })).rejects.toThrow("only Linux and macOS");
  });
});
