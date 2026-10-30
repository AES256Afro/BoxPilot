import { Button, Notice } from "../../ui";
import type { AgentSummary, ModuleState } from "./api";
import { clockTime } from "./format";

/*
 * Why nothing can start (M48.7): Agents off, every agent paused or stopped by the kill switch, or
 * this one agent paused. The Test and Evaluation tabs used to say "Agents are off" for all four, and
 * let a paused agent be asked only to see the server refuse. Each says what is so and, for whoever
 * may, offers the resume on the spot.
 */

export interface PausedNoticeProps {
  module: Pick<ModuleState, "enabled" | "paused" | "pausedUntil" | "killedAt">;
  agent: Pick<AgentSummary, "name" | "paused" | "pausedUntil"> | null;
  /** What waits: "a question", "the evaluation". */
  what: string;
  /** Whether this person may pause and resume (the owner and operators), and whether they are the owner. */
  canPause: boolean;
  owner: boolean;
  onResumeAll?: () => void;
  onResumeAgent?: () => void;
}

/** Whether the notice has anything to say: nothing starts for this agent. */
export function isHeld(module: PausedNoticeProps["module"], agent: PausedNoticeProps["agent"]): boolean {
  return !module.enabled || module.paused || Boolean(agent?.paused);
}

export function PausedNotice({ module, agent, what, canPause, owner, onResumeAll, onResumeAgent }: PausedNoticeProps) {
  if (!module.enabled) return <Notice tone="info">Agents are off, so nothing runs. The owner turns them on at the top of this page.</Notice>;
  if (module.paused && module.killedAt) {
    return (
      <Notice tone="warning" title="The kill switch stopped every agent" action={owner && onResumeAll ? <Button onClick={onResumeAll}>Resume all</Button> : undefined}>
        Nothing starts until the owner resumes them{owner ? "" : "; only the owner can"}.
      </Notice>
    );
  }
  if (module.paused) {
    return (
      <Notice tone="warning" title={module.pausedUntil ? `Every agent is paused until ${clockTime(module.pausedUntil)}` : "Every agent is paused"} action={canPause && onResumeAll ? <Button onClick={onResumeAll}>Resume all</Button> : undefined}>
        {what[0].toUpperCase()}{what.slice(1)} waits until they are resumed{module.pausedUntil ? ", or until then" : ""}.
      </Notice>
    );
  }
  if (agent?.paused) {
    return (
      <Notice tone="warning" title={agent.pausedUntil ? `${agent.name} is paused until ${clockTime(agent.pausedUntil)}` : `${agent.name} is paused`} action={canPause && onResumeAgent ? <Button onClick={onResumeAgent}>Resume {agent.name}</Button> : undefined}>
        {what[0].toUpperCase()}{what.slice(1)} would be refused until it is resumed{agent.pausedUntil ? ", or until then" : ""}. The other agents run as usual.
      </Notice>
    );
  }
  return null;
}
