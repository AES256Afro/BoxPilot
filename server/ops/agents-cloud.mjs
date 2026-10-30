/**
 * Claude for the agents (M45.3, ADR-013): the owner's key, held by the model gateway alone, and the
 * monthly cap it holds every call to. The key and the cap live under /etc/boxpilot and the gateway
 * is a systemd unit, so each of these runs as a root task (server/tasks/model-gateway.mjs).
 *
 * Connecting is high: it hands the house's key to a process that spends money, so the owner types
 * the monthly cap they are agreeing to. The cap and disconnecting are medium. Whether Claude is
 * connected, and the cap, are recorded by the web process (index.mjs, operationRecordHooks).
 */
import { defineOperation } from "./registry.mjs";
import { anthropicKeyPattern, capProblem } from "../tasks/model-gateway.mjs";

const minutes = (count) => count * 60_000;
const capField = { type: "number", validate: (value) => capProblem(value) };

/** What the owner types to connect: the cap, as a sentence, so the spend is agreed to in words. */
export const connectConfirmation = (parameters) => `$${parameters.capUsd} a month`;

export function agentsCloudOperations() {
  return [
    defineOperation({
      id: "agents.cloud.connect", title: "Connect Claude", risk: "high", minimumRole: "owner", timeoutMs: minutes(3), runsRootTask: true,
      description: "Stores your Anthropic API key root-only for the model gateway, the one process that may use it, and starts the gateway. The key is checked with Claude first, which costs nothing; a key Claude refuses is not kept. Agents use Claude only where you allow it, and never past the monthly cap.",
      parameters: {
        exact: true,
        fields: {
          key: { type: "string", secret: true, maxLength: 420, pattern: anthropicKeyPattern },
          capUsd: capField,
        },
      },
      confirm: connectConfirmation,
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("model-gateway.connect", parameters, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.cloud.cap", title: "Change Claude's monthly cap", risk: "medium", minimumRole: "owner", timeoutMs: minutes(2), runsRootTask: true,
      description: "Sets the most Claude may cost in a calendar month. The gateway refuses a call that could pass it, from the next call on.",
      parameters: { exact: true, fields: { capUsd: capField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("model-gateway.cap", parameters, { timeoutMs: 30_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.cloud.disconnect", title: "Disconnect Claude", risk: "medium", minimumRole: "owner", timeoutMs: minutes(2), runsRootTask: true,
      description: "Stops the model gateway and deletes the key. Agents run on the local model only. This month's spend is kept.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("model-gateway.disconnect", {}, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
  ];
}
