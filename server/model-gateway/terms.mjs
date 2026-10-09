/**
 * The model gateway's terms (M45.3), apart from the code that calls Claude, so the web service and
 * the root tasks can know them without loading the SDK: the models it calls and how much it takes.
 */

/** The models the owner may choose from (Settings), dearest first. */
export const offeredModels = Object.freeze(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

export const gatewayLimits = Object.freeze({ requestBytes: 2 * 1024 * 1024, running: 4, timeoutMs: 10 * 60_000, defaultTimeoutMs: 3 * 60_000 });
