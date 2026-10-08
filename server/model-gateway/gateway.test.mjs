// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toAnthropicRequest } from "../../packages/harness/src/providers/anthropic.mjs";
import { fakeClaude, fixture } from "../../packages/harness/test/anthropic-wire.mjs";
import { createGateway, gatewayLimits, worstCaseUsd } from "./gateway.mjs";
import { createLedger } from "./ledger.mjs";

/*
 * The model gateway (M45.3): the only process holding the Claude key answers status and chat,
 * holds every call to the monthly cap from its own ledger, calls only the models it offers, and
 * logs nothing of what was asked or answered.
 */

const request = {
  model: "claude-opus-5-5",
  messages: [{ role: "system", content: "You read the server's facts." }, { role: "user", content: "How full is the media drive on nas-attic?" }],
  maxTokens: 512,
};

function memoryLedger(spentUsd = 0) {
  let text = JSON.stringify({ month: "2026-10", spentUsd, calls: 0 });
  return createLedger({ file: "/spend.json", now: () => Date.parse("2026-10-08T12:00:00Z"), read: async () => text, write: async (_file, next) => { text = next; } });
}

function gateway({ script = [fixture("answer")], capUsd = 10, spentUsd = 0, provider } = {}) {
  const logs = [];
  const ledger = memoryLedger(spentUsd);
  const wire = fakeClaude(script);
  const made = createGateway({ provider: provider === undefined ? createAnthropicProvider({ client: wire.client }) : provider, ledger, settings: async () => ({ capUsd }), log: (entry) => logs.push(entry) });
  return { gateway: made, ledger, logs, wire };
}

describe("the gateway's status", () => {
  it("says whether a key is set, what may be called, and the month so far", async () => {
    expect((await gateway({ spentUsd: 1.25 }).gateway.handle({ version: 1, id: 1, op: "status" })).result).toEqual({ connected: true, models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], month: "2026-10", spentUsd: 1.25, calls: 0, capUsd: 10 });
    expect((await gateway({ provider: null }).gateway.handle({ version: 1, id: 2, op: "status" })).result.connected).toBe(false);
    expect(await gateway().gateway.handle({ version: 2, id: 3, op: "status" })).toMatchObject({ ok: false, code: "version" });
    expect(await gateway().gateway.handle({ version: 1, id: 4, op: "keys" })).toMatchObject({ ok: false, code: "op" });
  });
});

describe("checking the key", () => {
  it("says the key works when Claude reads it, and why not when it does not, spending nothing", async () => {
    const ledger = memoryLedger();
    const works = createGateway({ provider: { id: "anthropic", kind: "remote", chat: async () => ({}) }, ledger, settings: async () => ({ capUsd: 10 }), check: async () => ({}) });
    expect(await works.handle({ version: 1, id: 1, op: "check" })).toEqual({ version: 1, id: 1, ok: true, result: { ok: true } });
    const refused = createGateway({ provider: { id: "anthropic", kind: "remote", chat: async () => ({}) }, ledger, settings: async () => ({ capUsd: 10 }), check: async () => { throw Object.assign(new Error("Claude refused the API key"), { code: "auth", status: 401 }); } });
    expect(await refused.handle({ version: 1, id: 2, op: "check" })).toMatchObject({ ok: false, code: "auth", status: 401 });
    expect(await createGateway({ provider: null, ledger, settings: async () => ({}) }).handle({ version: 1, id: 3, op: "check" })).toMatchObject({ ok: false, code: "not-connected" });
    expect((await ledger.current()).spentUsd).toBe(0);
  });
});

describe("a call through the gateway", () => {
  it("answers on the contract and counts what it cost, logging none of what was said", async () => {
    const { gateway: made, ledger, logs } = gateway();
    const reply = await made.handle({ version: 1, id: "a", op: "chat", request });
    expect(reply).toMatchObject({ ok: true, id: "a", result: { content: "The media drive is 68% full.", reason: "stop" } });
    expect((await ledger.current()).spentUsd).toBe(reply.result.costUsd);
    expect(JSON.stringify(logs)).not.toMatch(/media drive|nas-attic|server's facts/);
    expect(logs[0]).toMatchObject({ op: "chat", model: "claude-opus-5-5", reason: "stop", costUsd: reply.result.costUsd });
  });

  it("is refused without a key, for a model it does not offer, and when it could pass the cap", async () => {
    expect(await gateway({ provider: null }).gateway.handle({ version: 1, id: 1, op: "chat", request })).toMatchObject({ ok: false, code: "not-connected" });
    expect(await gateway().gateway.handle({ version: 1, id: 2, op: "chat", request: { ...request, model: "claude-opus-4-8" } })).toMatchObject({ ok: false, code: "model" });
    const near = gateway({ spentUsd: 9.9 });
    expect(await near.gateway.handle({ version: 1, id: 3, op: "chat", request })).toMatchObject({ ok: false, code: "budget", spentUsd: 9.9, capUsd: 10 });
    expect(near.wire.requests).toHaveLength(0);
    expect(await gateway({ capUsd: 0 }).gateway.handle({ version: 1, id: 4, op: "chat", request })).toMatchObject({ ok: false, code: "budget", error: expect.stringMatching(/No monthly cap/) });
  });

  it("gives the reservation back when Claude refused before billing, and keeps it when it may have billed", async () => {
    const refusedKey = gateway({ script: [{ status: 401, type: "authentication_error" }] });
    expect(await refusedKey.gateway.handle({ version: 1, id: 1, op: "chat", request })).toMatchObject({ ok: false, code: "auth", status: 401 });
    expect((await refusedKey.ledger.current()).spentUsd).toBe(0);
    const broken = gateway({ script: [{ status: 500, type: "api_error" }] });
    expect(await broken.gateway.handle({ version: 1, id: 2, op: "chat", request })).toMatchObject({ ok: false, code: "api" });
    expect((await broken.ledger.current()).spentUsd).toBe(worstCaseUsd(toAnthropicRequest(request)));
  });

  it("makes no more calls at once than it allows", async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const slow = { id: "anthropic", kind: "remote", chat: async () => { await waiting; return { content: "ok", toolCalls: [], reason: "stop", usage: null, costUsd: 0.01 }; } };
    const { gateway: made } = gateway({ provider: slow, capUsd: 100 });
    const calls = Array.from({ length: gatewayLimits.running }, (_, index) => made.handle({ version: 1, id: index, op: "chat", request }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await made.handle({ version: 1, id: "extra", op: "chat", request })).toMatchObject({ ok: false, code: "busy" });
    release();
    expect((await Promise.all(calls)).every((reply) => reply.ok)).toBe(true);
  });
});

describe("the most a call could cost", () => {
  it("prices every prompt token at the dearer input rate and every token it may write, plus a fallback's share", () => {
    const opus = toAnthropicRequest(request);
    const haiku = toAnthropicRequest({ ...request, model: "claude-haiku-5-5" });
    expect(opus.fallbacks).toBe("default");
    expect(haiku).not.toHaveProperty("fallbacks");
    // Opus writes 16,000 tokens at $20 a million at most, and a fallback on Opus 5 another 16,000 at $25.
    expect(worstCaseUsd(opus)).toBeGreaterThan(0.72);
    expect(worstCaseUsd(haiku)).toBeLessThan(0.01);
    expect(worstCaseUsd({ ...opus, model: "claude-unknown" })).toBeNull();
  });
});
