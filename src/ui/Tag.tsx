import type { ReactNode } from "react";
import { riskCopy } from "./Button";
import { LockIcon } from "./icons";
import { cx, type RiskTier } from "./types";

/** Who can reach something: this machine only, the tailnet, the LAN, or anyone on the internet. */
export type Reach = "local" | "tailnet" | "lan" | "public";

const reachWords: Record<Reach, { short: string; long: string }> = {
  local: { short: "local", long: "Reachable from this server only" },
  tailnet: { short: "tailnet", long: "Reachable over the tailnet" },
  lan: { short: "LAN", long: "Reachable from the local network" },
  public: { short: "public", long: "Reachable from the internet" },
};

export type TagTone = "neutral" | "accent" | "info" | "good" | "warning" | "danger";

export interface TagProps {
  /** Words for a plain tag: a category, a filesystem, a protocol. */
  children?: ReactNode;
  tone?: TagTone;
  /**
   * A reach tag instead: LAN in amber (the local network can reach it), public in red, tailnet
   * and local plain. Its full meaning is its tooltip and is read after the word.
   */
  reach?: Reach;
  /** A tier tag instead: LOW, MED, HIGH (with a lock), for a row whose action is elsewhere. */
  tier?: RiskTier;
  title?: string;
  className?: string;
}

/**
 * A small label in mono (M33.8): what kind of thing a row is, who can reach it, or the tier of
 * what it would run. Colour is never the only sign: reach and tier are words.
 */
export function Tag({ children, tone = "neutral", reach, tier, title, className }: TagProps) {
  if (tier) {
    return (
      <span className={cx("ui-tag", "ui-tag--tier", `ui-tag--tier-${tier}`, className)} data-risk={tier} title={title ?? riskCopy[tier].description}>
        {tier === "high" && <LockIcon className="ui-tag__lock" />}
        {riskCopy[tier].short}
        <span className="ui-visually-hidden"> risk</span>
      </span>
    );
  }
  if (reach) {
    const words = reachWords[reach];
    return (
      <span className={cx("ui-tag", "ui-tag--reach", className)} data-reach={reach} title={title ?? words.long}>
        {words.short}
        <span className="ui-visually-hidden">{`: ${words.long.toLowerCase()}`}</span>
      </span>
    );
  }
  return <span className={cx("ui-tag", `ui-tag--${tone}`, className)} title={title}>{children}</span>;
}
