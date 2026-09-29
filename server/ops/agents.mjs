/**
 * The agents runtime's operations (M37). Agents themselves never run an operation: these are the
 * owner's, from the Agents section, each approved at its own tier - installing Unsloth, starting or
 * stopping the capped runner, downloading a model, switching to it, removing one - and the reads the
 * section and the agents' tools make through the helper.
 *
 * Downloads and installs need the network and root, so they run in boxpilot-run@ (server/tasks/
 * agents.mjs). Switching the model is a check here that it is downloaded whole; the choice itself
 * is recorded by the web process (index.mjs, operationRecordHooks), where the runner reads it.
 */
import { defineOperation } from "./registry.mjs";
import { agentsPaths, checkDownloaded, inspectRuntime } from "../agents/host.mjs";
import { ggufPattern, repoPattern } from "../agents/models.mjs";
import { createPiholeReader } from "../agents/pihole.mjs";

const minutes = (count) => count * 60_000;
const modelFields = {
  repo: { type: "string", maxLength: 80, pattern: repoPattern },
  file: { type: "string", maxLength: 160, pattern: ggufPattern },
  projector: { type: "string", maxLength: 160, pattern: ggufPattern, optional: true, nullable: true },
};

export function agentsOperations() {
  return [
    defineOperation({
      // operator (ADR-003): it lists what the runner's state holds, as root. It runs nothing from there.
      id: "agents.runtime.inspect", title: "Read the agents runtime", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 45_000,
      description: "Whether Unsloth is installed, whether the capped runner unit is running, and which models are downloaded. Nothing is changed.",
      run: (_parameters, { run }) => inspectRuntime({ run }),
    }),
    defineOperation({
      id: "agents.runtime.install", title: "Install the agents runtime (Unsloth)", risk: "medium", minimumRole: "owner", timeoutMs: minutes(45), maxTimeoutMs: minutes(180),
      description: "Installs Unsloth (GGUF only, no PyTorch) into /var/lib/boxpilot-agents/unsloth with Unsloth's own installer, run as the unprivileged boxpilot-agents user rather than root, and the OpenMP library its llama.cpp needs. Downloads about 2 GB. The installer takes Unsloth's newest release; BoxPilot says when that is not the one it was measured with. Nothing is started.",
      run: (_parameters, { runUnit, jobLog, timeScale = 1 }) => runUnit.runTask("agents.install", {}, { timeoutMs: Math.round(minutes(44) * timeScale), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.runtime.enable", title: "Start the agents runner", risk: "medium", minimumRole: "owner", timeoutMs: minutes(3),
      description: "Enables and starts boxpilot-agents.service: the capped runner (four processors at most, idle priority, 8 GB of memory, loopback only). It starts the model server only when an agent runs, and stops it after an hour with nothing to do.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("agents.enable", {}, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.runtime.disable", title: "Stop the agents runner", risk: "low", timeoutMs: minutes(3),
      description: "Stops and disables boxpilot-agents.service, and with it any model it was running. Agents stay as they are and wait until it is started again.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("agents.disable", {}, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.model.download", title: "Download a model for agents", risk: "medium", minimumRole: "owner", timeoutMs: minutes(60), maxTimeoutMs: minutes(240),
      description: "Downloads one of Unsloth's Qwen GGUF models, and its vision projector, from huggingface.co into the runner's model cache, as the runner's own user. Every byte is checked against the SHA-256 Hugging Face publishes; space is checked first. The model in use is not changed.",
      parameters: { fields: modelFields },
      run: (parameters, { runUnit, jobLog, timeScale = 1 }) => runUnit.runTask("agents.model.download", parameters, { timeoutMs: Math.round(minutes(59) * timeScale), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.model.switch", title: "Switch the agents' model", risk: "medium", minimumRole: "owner", timeoutMs: 30_000,
      description: "Uses a downloaded model for the next agent run. The model in use stays downloaded, to switch back to.",
      parameters: { fields: modelFields },
      run: (parameters) => checkDownloaded(parameters, { paths: agentsPaths }),
    }),
    defineOperation({
      id: "agents.model.remove", title: "Remove a downloaded model", risk: "medium", minimumRole: "owner", timeoutMs: minutes(2),
      description: "Deletes a downloaded model and its vision projector to free the space. The model agents use now cannot be removed.",
      parameters: { fields: { ...modelFields, current: { type: "string", maxLength: 260, optional: true, nullable: true } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("agents.model.remove", parameters, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "agents.connector.sync", title: "Bring documents in from Notion or Slack", risk: "low", minimumRole: "owner", timeoutMs: minutes(10),
      description: "Reads the pages a Notion integration can see, or the last week of the Slack channels named, with a read-only token saved as a named credential, and brings their text into the agents' learning library. Nothing is written to Notion or Slack, and who wrote a Slack message is left out.",
      parameters: {
        exact: true,
        fields: {
          connector: { type: "string", enum: ["notion", "slack"] },
          credentialName: { type: "string", pattern: /^[a-z][a-z0-9-]{0,31}$/ },
          channels: { type: "array", optional: true, validate: (value) => (value.length <= 10 && value.every((channel) => typeof channel === "string" && /^[CG][A-Z0-9]{6,20}$/.test(channel)) ? null : "up to ten Slack channel ids") },
        },
      },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("agents.connector.sync", parameters, { timeoutMs: minutes(9), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      // operator (ADR-003): it reads Pi-hole's own databases through root Docker access.
      id: "app.pihole.inspect", title: "Read Pi-hole's numbers", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Where Pi-hole runs (a BoxPilot app, another container, or the host), whether it is blocking, and network-wide counts for the last day: queries, blocked, each upstream, the blocklists' age and the most blocked domains. Never which device asked for what. Nothing is changed.",
      run: (_parameters, { run, apps }) => createPiholeReader({ run, apps }).inspect(),
    }),
  ];
}
