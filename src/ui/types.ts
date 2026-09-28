export type { RiskTier } from "../operations";

/**
 * How something is doing. `unknown` is for anything BoxPilot could not read or has not checked:
 * it is drawn grey, hollow and dashed, and never green (M28.5).
 */
export type Status = "good" | "warning" | "danger" | "neutral" | "unknown";

export const STATUSES: readonly Status[] = ["good", "warning", "danger", "neutral", "unknown"];

/** Comfortable is Home's density, compact is Ops'. Set with data-density on a container. */
export type Density = "comfortable" | "compact";

/** The words a status is read out as when nothing more specific is given. */
export const statusWords: Record<Status, string> = {
  good: "Healthy",
  warning: "Needs a look",
  danger: "Not working",
  neutral: "No change",
  unknown: "Not known",
};

/** Joins class names, skipping the empty ones. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
