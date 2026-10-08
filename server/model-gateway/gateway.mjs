/**
 * The model gateway's work, apart from its socket (M45.3, ADR-013). The gateway is the one process
 * that holds the Claude key; the web service asks it for a model call and gets the answer back,
 * never the key.
 *
 * It answers three requests, each one JSON line:
 *   { version: 1, id, op: "status" }
 *   { version: 1, id, op: "check" }                      the key works: Claude reads it, nothing is spent
 *   { version: 1, id, op: "chat", request, timeoutMs }   request: the harness's ChatRequest
 * and replies `{ version: 1, id, ok: true, result }` or `{ version: 1, id, ok: false, error, code }`.
 *
 * Before a call it reserves, in its own ledger, the most the call could cost (every token of the
 * prompt at the dearest input rate, every token it may write, and the fallback model's share where
 * one may finish the answer), and refuses the call when that could pass the monthly cap. After the
 * call the reservation becomes what the call did cost. Only the models it offers are called; a
 * model without a price could not be held to the cap.
 *
 * Nothing it logs carries what was asked or answered: the model, the tokens, the cost, the code.
 */
import { toAnthropicRequest } from "../../packages/harness/src/providers/anthropic.mjs";
import { anthropicPrices, priceFor } from "../../packages/harness/src/providers/anthropic-prices.mjs";
import { gatewayLimits, offeredModels } from "./terms.mjs";

export { gatewayLimits, offeredModels };

/** Failures Claude answered before any token was billed: the reservation goes back. */
const unbilled = new Set(["auth", "forbidden", "rate-limited", "overloaded", "bad-request", "not-found", "unreachable"]);

/** A tokens estimate that errs high: about three characters a token, where English runs nearer four. */
const tokensIn = (params) => Math.ceil(JSON.stringify({ system: params.system, messages: params.messages, tools: params.tools }).length / 3);

const dearest = Object.values(anthropicPrices).reduce((top, card) => (card.output > top.output ? card : top));

function cardFor(card, prompt) {
  return card.longPrompt && prompt > card.longPrompt.above ? card.longPrompt : card;
}

/** The most one call could cost, in dollars, or null when its model has no price. */
export function worstCaseUsd(params) {
  const own = priceFor(params.model);
  if (!own) return null;
  const prompt = tokensIn(params);
  const cost = (card) => {
    const price = cardFor(card, prompt);
    return (prompt * Math.max(price.input, price.cacheWrite) + params.max_tokens * price.output) / 1_000_000;
  };
  return Math.round((cost(own) + (params.fallbacks ? cost(dearest) : 0)) * 1_000_000) / 1_000_000;
}

const failed = (id, code, error, extra = {}) => ({ version: 1, id, ok: false, code, error, ...extra });

/**
 * `provider` is the Claude provider (null when no key is set), `ledger` the month's spend,
 * `settings()` what the owner set (`{ capUsd }`), read on every call so a new cap holds at once,
 * `check()` a request Claude answers without billing (it reads one model's details), rejecting with
 * a coded Error when the key is refused or Claude cannot be reached.
 */
export function createGateway({ provider, ledger, settings, check = null, log = () => {} }) {
  let running = 0;

  async function status(id) {
    const month = await ledger.current();
    const { capUsd = 0 } = await settings().catch(() => ({}));
    return { version: 1, id, ok: true, result: { connected: Boolean(provider), models: offeredModels, month: month.month, spentUsd: month.spentUsd, calls: month.calls, capUsd: Number(capUsd) || 0 } };
  }

  async function verify(id) {
    if (!provider || !check) return failed(id, "not-connected", "Claude is not connected: no API key is set");
    try {
      await check();
      log({ op: "check", ok: true });
      return { version: 1, id, ok: true, result: { ok: true } };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "error";
      log({ op: "check", code });
      return failed(id, code, String(error?.message ?? error).slice(0, 300), error?.status ? { status: error.status } : {});
    }
  }

  async function chat(id, message, signal) {
    if (!provider) return failed(id, "not-connected", "Claude is not connected: no API key is set");
    const request = message.request;
    if (!request || typeof request !== "object" || !offeredModels.includes(request.model)) return failed(id, "model", `The gateway calls only ${offeredModels.join(", ")}`);
    let params;
    try { params = toAnthropicRequest(request); } catch (error) { return failed(id, "bad-request", String(error.message).slice(0, 200)); }
    const atMost = worstCaseUsd(params);
    if (atMost === null) return failed(id, "model", `${request.model} has no price, so it cannot be held to the monthly cap`);
    if (running >= gatewayLimits.running) return failed(id, "busy", "The gateway is already making as many calls as it allows; try again shortly");
    running += 1;
    try {
      const { capUsd = 0 } = await settings().catch(() => ({}));
      const held = await ledger.reserve(atMost, capUsd);
      if (!held.ok) return failed(id, "budget", Number(capUsd) > 0 ? `This call could pass this month's cap of $${Number(capUsd).toFixed(2)} ($${held.spentUsd.toFixed(2)} spent)` : "No monthly cap is set, so Claude is not called", { spentUsd: held.spentUsd, capUsd: held.capUsd });
      const timeoutMs = Math.min(gatewayLimits.timeoutMs, Math.max(1_000, Number(message.timeoutMs) || gatewayLimits.defaultTimeoutMs));
      try {
        const result = await provider.chat(request, { signal, timeoutMs });
        const month = await ledger.settle(held, result.costUsd);
        log({ op: "chat", model: request.model, reason: result.reason, promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null, costUsd: result.costUsd, spentUsd: month.spentUsd });
        return { version: 1, id, ok: true, result };
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : signal?.aborted ? "abandoned" : "error";
        await ledger.settle(held, unbilled.has(code) ? 0 : null);
        log({ op: "chat", model: request.model, code });
        return failed(id, code, String(error?.message ?? error).slice(0, 300), error?.status ? { status: error.status } : {});
      }
    } finally {
      running -= 1;
    }
  }

  return {
    /** One request line, already parsed, and the signal that fires when its caller goes away. */
    async handle(message, { signal } = {}) {
      const id = typeof message?.id === "string" || typeof message?.id === "number" ? message.id : null;
      if (message?.version !== 1) return failed(id, "version", "The gateway speaks version 1");
      if (message.op === "status") return status(id);
      if (message.op === "check") return verify(id);
      if (message.op === "chat") return chat(id, message, signal);
      return failed(id, "op", "The gateway answers status, check and chat");
    },
  };
}
