/**
 * What Claude costs, in US dollars per million tokens, as Anthropic lists it. One file, so a price
 * change is one edit. A model that is not listed has no price: its cost is null, and a host that
 * holds runs to a dollar cap (BoxPilot's gateway, M45.3) refuses to start a run on it.
 *
 * The fallback models are listed because a declined request may be finished by one of them
 * (`fallbacks: "default"`), and that part of the answer is billed at its own model's price.
 *
 * Cache writes here are the five-minute kind (1.25 times input); an hour's cache costs twice input.
 */
export const pricesListedOn = "2026-10-08";

export const anthropicPrices = Object.freeze({
  "claude-opus-5-5": Object.freeze({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }),
  "claude-sonnet-5-5": Object.freeze({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
  // Haiku has two price cards, chosen by how long the prompt is.
  "claude-haiku-5-5": Object.freeze({ input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, longPrompt: Object.freeze({ above: 100_000, input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 }) }),
  "claude-opus-5": Object.freeze({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }),
  "claude-opus-4-8": Object.freeze({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }),
  "claude-sonnet-5": Object.freeze({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
});

/** The price card for a model id, with or without a date suffix; null when it is not listed. */
export function priceFor(model) {
  const id = String(model ?? "");
  return anthropicPrices[id] ?? anthropicPrices[id.replace(/-\d{8}$/, "")] ?? null;
}

const tokens = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

/**
 * What one attempt cost, from the usage the API reported for it, or null when the model has no
 * price. `usage` is the API's own: input, output, cache writes and cache reads, each in tokens.
 */
export function costOf(model, usage) {
  const card = priceFor(model);
  if (!card || !usage) return null;
  const input = tokens(usage.input_tokens);
  const output = tokens(usage.output_tokens);
  const written = tokens(usage.cache_creation_input_tokens);
  const read = tokens(usage.cache_read_input_tokens);
  const hour = Math.min(written, tokens(usage.cache_creation?.ephemeral_1h_input_tokens));
  const price = card.longPrompt && input + written + read > card.longPrompt.above ? card.longPrompt : card;
  const dollars = (input * price.input + output * price.output + (written - hour) * price.cacheWrite + hour * price.input * 2 + read * price.cacheRead) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
