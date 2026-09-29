import type { ReactNode } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { Button, riskOf, type ButtonVariant } from "../../ui";
import type { LibraryModel, RuntimeState } from "./api";
import { bytes, gibibytes, type RunnerDetail, type SetupStepId } from "./format";

/*
 * What stands between Agents being on and an agent answering (M37): Unsloth installed, the model
 * downloaded, the capped runner started. Each is its own registered operation, staged and approved
 * at its own tier. This says which are still missing, in that order, and chains them: the approval
 * dialog that finishes one offers the next as "Next", and nothing is staged until the owner presses
 * it. Turning Agents on opens the first; the page's header, the waiting runs and the Usage tab offer
 * whichever is missing now.
 */

export type { SetupStepId };

/**
 * Agents are on but the runner is not answering, so a run in the queue waits for it: why, in words,
 * and for the owner the step that starts it. Anyone else sees only the words.
 */
export interface RunnerWait { words: string; action: ReactNode }

export interface SetupStep {
  id: SetupStepId;
  /** The button's words: "Install Unsloth", "Download the model", "Start the runner". */
  label: string;
  operation: PendingOperation;
}

const usesUnsloth = (runtime: RuntimeState) => runtime.settings.driver === "unsloth" || runtime.settings.driver === "llama-server";
/** A unit that is up, or on its way up: starting it again would change nothing. */
export const unitUp = (active: string | null | undefined) => active === "active" || active === "activating" || active === "reloading";
export const modelParameters = (model: LibraryModel) => ({ repo: model.repo, file: model.file, projector: model.projector });

export function installStep(): SetupStep {
  return {
    id: "install", label: "Install Unsloth",
    operation: { operationId: "agents.runtime.install", title: "Install Unsloth for agents", parameters: {}, preview: <span>Unsloth's own installer, GGUF only, run as the runner's user into its own folder. About 2 GB.</span> },
  };
}

export function downloadStep(model: LibraryModel): SetupStep {
  return {
    id: "download", label: "Download the model",
    operation: {
      operationId: "agents.model.download", title: `Download ${model.title}`, parameters: modelParameters(model),
      preview: <span>{bytes(model.preview.bytes)} from huggingface.co, every byte checked; about {model.preview.fastMinutes} minutes on a fast connection, {model.preview.slowMinutes} on a slow one.</span>,
    },
  };
}

export function enableStep(runtime: RuntimeState): SetupStep {
  return {
    id: "enable", label: "Start the runner",
    operation: { operationId: "agents.runtime.enable", title: "Start the agents runner", parameters: {}, preview: <span>{runtime.caps.unit}: one processor at most, idle priority, {gibibytes(runtime.caps.memoryMaxBytes)}, this machine only.</span> },
  };
}

/**
 * The steps still missing, in order, or null when the runtime could not be read (a viewer never
 * reads it). The runner is started only while Agents are on: off, it would only sit idle.
 */
export function setupSteps(runtime: RuntimeState | null, { enabled }: { enabled: boolean }): SetupStep[] | null {
  const installed = runtime?.installed;
  if (!runtime || !installed) return null;
  const steps: SetupStep[] = [];
  if (usesUnsloth(runtime) && !installed.runtime?.installed) steps.push(installStep());
  // The model agents use, when it is one of the library's and is not downloaded yet.
  const model = usesUnsloth(runtime) ? runtime.library.find((entry) => entry.current) : undefined;
  if (model && !model.downloaded) steps.push(downloadStep(model));
  if (enabled && installed.service && !unitUp(installed.service.active)) steps.push(enableStep(runtime));
  return steps;
}

/** The steps from `from` on, each one's dialog offering the one after it once it has completed. */
export function chainSteps(steps: SetupStep[], from = 0): PendingOperation | null {
  return steps.slice(from).reduceRight<PendingOperation | null>((next, step) => ({ ...step.operation, ...(next ? { next } : {}) }), null);
}

/** What the verdict and the waiting runs say about a runner that is not answering. */
export function runnerDetail(runtime: RuntimeState | null, steps: SetupStep[] | null): RunnerDetail {
  return { silent: unitUp(runtime?.installed?.service?.active), missing: steps?.map((step) => step.id) ?? null };
}

/** The next missing step as a button, with its tier; pressing it opens the chain from there. */
export function SetupAction({ steps, onStart, variant = "primary" }: { steps: SetupStep[]; onStart: (operation: PendingOperation) => void; variant?: ButtonVariant }) {
  const first = steps[0];
  const chain = chainSteps(steps);
  if (!first || !chain) return null;
  return <Button variant={variant} risk={riskOf(first.operation.operationId)} onClick={() => onStart(chain)}>{first.label}</Button>;
}
