/**
 * The agent harness (M45, docs/HARNESS.md). It imports nothing from the host it runs in: a test
 * holds this package to Node's own modules, its own files and the dependencies it declares.
 *
 * Claude's provider is imported on its own, from `@boxpilot/harness/anthropic`, so a host that
 * never calls Claude never loads its SDK.
 */
export { assistantTurn, checkMessage, messagesFor } from "./messages.mjs";
export { defineProvider, readChatResult, resultLimits } from "./provider.mjs";
export { strictSchema } from "./schema.mjs";
export { createOpenAiCompatibleProvider } from "./providers/openai-compatible.mjs";
export { createFakeProvider } from "./providers/fake.mjs";
