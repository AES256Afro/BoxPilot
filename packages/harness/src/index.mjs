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
export { fallbackCodes, fallsBack, moveAfterPlan, routerDefaults, routes, secondOpinion, startRoute } from "./router.mjs";
export { createStandIns, hideRequest, showResult } from "./safety/stand-ins.mjs";
export { createRedactor, redactionRules, redactPrivateKeys, redactSecretBlocks, redactText } from "./safety/redaction.mjs";
export { createOpenAiCompatibleProvider, thinkingOff } from "./providers/openai-compatible.mjs";
export { createFakeProvider } from "./providers/fake.mjs";
export { createOpenAiClient, readTimings, streamLimits } from "./providers/openai-client.mjs";
export { createEndpointGuard, isLocalAddress, isLocalName, isLoopbackAddress, normalizeEndpoint, readBounded } from "./providers/local-endpoint.mjs";
export { boxAttribute, boxLine, detectInjection, readsAs, sanitizeUntrusted, stripWrapperBlocks, untrustedNotice, wrapFinding, wrapNote, wrapToolOutput, wrapperTagNames } from "./safety/guard.mjs";
export { checkCitations } from "./check/citations.mjs";
export { claimsOf, correctionMessages, correctionSystem, entitiesIn, evidenceFor, scopeOf, unsureNote, valuesIn, verifyAnswer } from "./check/verify.mjs";
export { answerFormat, readStructuredAnswer } from "./core/answer.mjs";
export { clipToolOutput, createSpeed, paceDefaults, promptChars } from "./core/pace.mjs";
export { createModelSession } from "./core/session.mjs";
export { act, answerNowNote, checkAnswer, modelStep, stripToolMarkup } from "./core/loop.mjs";
export { checkInput, createToolbox, defineTool, toolKinds } from "./core/tools.mjs";
export { runDefaults, runTask, toolsAnswer } from "./core/run.mjs";
