import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./types";

export interface CodeBlockProps {
  /** The text, shown exactly: output, a journal, a config file, a command. */
  children: string;
  /** What it is, in the bar above it and as its name for assistive technology: "Journal for docker.service". */
  label: string;
  /** Offers a Copy button in the bar. On by default. */
  copy?: boolean;
  /**
   * Keep the newest line in view as text arrives, as a terminal does (a followed log). Only while
   * the view is at the bottom: once someone scrolls up to read, it stays put and offers "Jump to
   * newest" until they scroll back down.
   */
  follow?: boolean;
  /** Break long lines instead of scrolling sideways. On by default; turn it off for aligned columns. */
  wrap?: boolean;
  /** Shown when there is no text: "No entries". */
  empty?: ReactNode;
  /** More in the bar, after the label: a line count, the time it was read, a button. */
  meta?: ReactNode;
  /** The tallest it grows before scrolling, as a CSS length. */
  maxHeight?: string;
  className?: string;
}

/**
 * Text shown exactly, in mono, with a bar that names it and a Copy button (M33.8). The block
 * scrolls itself, never the page, and is one tab stop so the keyboard can scroll it. A clipboard
 * that refuses says so, and the text stays selectable to copy by hand.
 */

/** How near the bottom, in px, still counts as reading the newest line. */
const followSlack = 24;
const nearBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= followSlack;

export function CodeBlock({ children, label, copy = true, follow = false, wrap = true, empty, meta, maxHeight, className }: CodeBlockProps) {
  const pre = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  // Whether the view is at the newest line. Scrolling up to read lets go of it (M89): every chunk
  // used to pull the view back to the bottom, mid-sentence, while a failing install streamed.
  const [pinned, setPinned] = useState(true);
  const [wasFollowing, setWasFollowing] = useState(follow);
  if (wasFollowing !== follow) { setWasFollowing(follow); if (follow) setPinned(true); }
  useEffect(() => { if (follow && pinned && pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [children, follow, pinned]);
  const onScroll = () => { if (follow && pre.current) setPinned(nearBottom(pre.current)); };
  // An instant jump, not a smooth one: nothing moves on its own for someone who asked for less motion,
  // and the keyboard lands on the text it brought into view.
  const jumpToNewest = () => {
    if (pre.current) { pre.current.scrollTop = pre.current.scrollHeight; pre.current.focus(); }
    setPinned(true);
  };
  useEffect(() => { setCopied("idle"); }, [children]);
  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(children);
      setCopied("copied");
      window.setTimeout(() => setCopied((current) => (current === "copied" ? "idle" : current)), 2_000);
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className={cx("ui-code", !wrap && "ui-code--nowrap", className)}>
      <div className="ui-code__bar">
        <span className="ui-code__label">{label}</span>
        {meta && <span className="ui-code__meta">{meta}</span>}
        {follow && !pinned && <button type="button" className="ui-code__copy ui-code__jump" onClick={jumpToNewest}>Jump to newest</button>}
        {copy && (
          <button type="button" className="ui-code__copy" onClick={() => void onCopy()} disabled={!children}>
            {copied === "copied" ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {copied === "failed" && <p className="ui-code__note" role="status">The clipboard is not available here. Select the text and copy it by hand.</p>}
      <pre ref={pre} className="ui-code__text" tabIndex={0} aria-label={label} onScroll={onScroll} style={maxHeight ? { maxHeight } : undefined}>
        {children || <span className="ui-code__empty">{empty ?? "Nothing to show."}</span>}
      </pre>
    </div>
  );
}
