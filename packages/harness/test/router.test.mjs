// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fallsBack, moveAfterPlan, secondOpinion, startRoute } from "../src/index.mjs";

/*
 * The router's rules (M45.4): where a run starts, when an auto run moves to the remote model after
 * its plan, when a local answer gets a second opinion, and which remote failures fall back.
 */

const up = { ok: true, reason: null };
const down = { ok: false, reason: "The monthly cap is spent" };

describe("where a run starts", () => {
  it("keeps a local agent local, whatever the remote model can do", () => {
    expect(startRoute({ route: "local", remote: up })).toEqual({ start: "local", mayMove: false, reason: null });
  });

  it("starts a remote agent there when it may take the run, and locally with the reason when not", () => {
    expect(startRoute({ route: "remote", remote: up })).toEqual({ start: "remote", mayMove: false, reason: null });
    expect(startRoute({ route: "remote", remote: down })).toEqual({ start: "local", mayMove: false, reason: "The monthly cap is spent" });
  });

  it("starts an auto agent locally, free to move only when the remote model may take the run", () => {
    expect(startRoute({ route: "auto", remote: up })).toEqual({ start: "local", mayMove: true, reason: null });
    expect(startRoute({ route: "auto", remote: down })).toEqual({ start: "local", mayMove: false, reason: "The monthly cap is spent" });
  });

  it("starts a second opinion on the remote model, and an unknown route locally", () => {
    expect(startRoute({ route: "local", remote: up, secondOpinion: true }).start).toBe("remote");
    expect(startRoute({ route: "elsewhere", remote: up }).start).toBe("local");
  });
});

describe("moving after the plan", () => {
  const sure = { read: true, confidence: 0.9, changes: false };

  it("stays local when the plan was read, sure, changes nothing, and the work fits", () => {
    expect(moveAfterPlan({ plan: sure, promptTokens: 2_000, contextTokens: 8_192 })).toEqual({ move: false, why: null, reason: null });
    expect(moveAfterPlan({ plan: null })).toEqual({ move: false, why: null, reason: null });
  });

  it("moves when the local model could not plan, with a reason a person reads", () => {
    expect(moveAfterPlan({ localProblem: "model-unavailable" })).toMatchObject({ move: true, why: "local-failed", reason: "The local model could not start" });
    expect(moveAfterPlan({ localProblem: "model-error" })).toMatchObject({ move: true, why: "local-failed" });
    // Out of time or the day's model time: the remote model is held to the same clock.
    expect(moveAfterPlan({ localProblem: "timeout", plan: sure }).move).toBe(false);
    expect(moveAfterPlan({ localProblem: "budget", plan: sure }).move).toBe(false);
  });

  it("moves when the work is past the share of the local context it reads well", () => {
    expect(moveAfterPlan({ plan: sure, promptTokens: 6_600, contextTokens: 8_192 })).toMatchObject({ move: true, why: "context", reason: expect.stringMatching(/6600 tokens.*8192-token context/) });
    expect(moveAfterPlan({ plan: sure, promptTokens: 6_500, contextTokens: 8_192 }).move).toBe(false);
    expect(moveAfterPlan({ plan: sure, promptTokens: 6_600, contextTokens: 8_192, contextShare: 0.9 }).move).toBe(false);
  });

  it("moves on a plan it could not read, an unsure plan, and a plan that proposes a change", () => {
    expect(moveAfterPlan({ plan: { read: false } }).why).toBe("plan-unread");
    expect(moveAfterPlan({ plan: { read: true, confidence: 0.3 } })).toMatchObject({ why: "unsure", reason: "The local model was unsure of its plan (confidence 0.3)" });
    expect(moveAfterPlan({ plan: { read: true, confidence: 0.3 }, unsureBelow: 0.2 }).move).toBe(false);
    expect(moveAfterPlan({ plan: { read: true, confidence: null } }).move).toBe(false);
    expect(moveAfterPlan({ plan: { ...sure, changes: true } }).why).toBe("changes");
  });

  it("gives the first reason that holds", () => {
    expect(moveAfterPlan({ plan: { read: true, confidence: 0.1, changes: true }, promptTokens: 9_000, contextTokens: 8_192 }).why).toBe("context");
  });
});

describe("a second opinion", () => {
  it("is asked for an answer cut short or one that did not match its tools", () => {
    expect(secondOpinion({ outcome: "degraded", degradedReason: "timeout" })).toEqual({ ask: true, reason: "The local model's answer was cut short (timeout)" });
    expect(secondOpinion({ outcome: "completed", check: { unsure: true, mismatches: 0 } }).ask).toBe(true);
    expect(secondOpinion({ outcome: "completed", check: { unsure: false, mismatches: 2 } }).ask).toBe(true);
  });

  it("is not asked for a good answer, a failure, a question back, or a second opinion", () => {
    expect(secondOpinion({ outcome: "completed", check: { unsure: false, mismatches: 0 } }).ask).toBe(false);
    expect(secondOpinion({ outcome: "completed" }).ask).toBe(false);
    expect(secondOpinion({ outcome: "failed" }).ask).toBe(false);
    expect(secondOpinion({ outcome: "completed", clarify: true, check: { unsure: true } }).ask).toBe(false);
    expect(secondOpinion({ outcome: "degraded", secondOpinion: true }).ask).toBe(false);
  });
});

describe("falling back", () => {
  it("goes on locally when the remote model is gone, busy, out of money or refuses the key", () => {
    for (const code of ["gateway-down", "not-connected", "budget", "unreachable", "overloaded", "rate-limited", "auth", "api"]) expect(fallsBack(code), code).toBe(true);
  });

  it("does not when the request was malformed or the call ran out of time", () => {
    for (const code of ["bad-request", "timeout", "abandoned", null, undefined]) expect(fallsBack(code), String(code)).toBe(false);
  });
});
