import { useId, useState, type ReactNode } from "react";
import { TopBarSlot, useShellHost } from "../shell/TopBarSlot";
import { InfoIcon } from "./icons";
import { Facts } from "./Facts";
import { StatusChip } from "./StatusChip";
import { cx, type Status } from "./types";

export interface PageHeaderProps {
  /** The page's name and its one h1: "Services". Drawn after the server's name in the bar. */
  title: string;
  /** The verdict, said before anything else: { status: "danger", label: "2 failed" }. */
  status?: { status: Status; label: ReactNode };
  /** One sentence after the verdict, when the chip alone does not say it. Not a paragraph. */
  summary?: ReactNode;
  /** Facts in monospace after the verdict: "systemd 255 · 142 units · 3 timers". Put figures in <b>. */
  meta?: ReactNode;
  /** The page's own actions, each a Button with its `risk`. */
  actions?: ReactNode;
  /**
   * What the page is for, when someone asks: behind an info toggle, never above the facts. Keep it
   * to a few sentences; a longer explanation belongs to the assistant.
   */
  about?: ReactNode;
  /**
   * Host facts for the bar beside the name, on a wide screen only (Ops: kernel, uptime, version).
   * Anything a narrow screen must still show goes in `meta`.
   */
  barFacts?: ReactNode;
  /** The server's name in the bar; the shell's (the inventory's) when left out. */
  host?: string | null;
  /**
   * Where the name goes: the shell's bar, as every console page has it (the default), or here in
   * the page, for the gallery. Without a shell (a test) it is drawn in place either way.
   */
  placement?: "bar" | "inline";
  className?: string;
}

/**
 * The top of a console page (M33.8, ADR-004). The name sits in the compact bar as the Command
 * Center has it ("homebox / services"); under the bar comes one row: the verdict chip, a sentence
 * when needed, the facts in mono, and the page's actions with their tiers. Facts first: whatever
 * explains the page waits behind the info toggle.
 */
export function PageHeader({ title, status, summary, meta, actions, about, barFacts, host, placement = "bar", className }: PageHeaderProps) {
  const shellHost = useShellHost();
  const aboutId = useId();
  const [open, setOpen] = useState(false);
  const name = host ?? shellHost ?? "boxpilot";
  const toggle = about ? (
    <button type="button" className="ui-info-toggle" aria-expanded={open} aria-controls={aboutId} onClick={() => setOpen((value) => !value)}>
      <InfoIcon />
      <span className="ui-visually-hidden">About {title}</span>
    </button>
  ) : null;
  const explained = about ? <div id={aboutId} className="ui-page-header__about" hidden={!open}>{about}</div> : null;
  // With nothing else to say under the bar (a page not yet rebuilt), the toggle sits beside the
  // name, and the page starts with its own content rather than a row holding one button.
  const facts = status || summary || meta || actions;
  const crumb = (
    <div className="cc-crumb ui-crumb">
      <span className="cc-crumb__host">{name}</span>
      <span className="cc-crumb__sep" aria-hidden="true">/</span>
      <h1>{title}</h1>
      {!facts && toggle}
      {barFacts && <span className="cc-kv">{barFacts}</span>}
    </div>
  );
  return (
    <>
      {placement === "inline" ? crumb : <TopBarSlot inPlace>{crumb}</TopBarSlot>}
      {facts ? (
        <div className={cx("ui-page-header", className)}>
          <div className="ui-page-header__facts">
            {status && <StatusChip status={status.status} className="ui-page-header__verdict">{status.label}</StatusChip>}
            {summary && <p className="ui-page-header__summary">{summary}</p>}
            {meta && <Facts className="ui-page-header__meta">{meta}</Facts>}
          </div>
          <div className="ui-page-header__actions">
            {toggle}
            {actions}
          </div>
          {explained}
        </div>
      ) : explained}
    </>
  );
}