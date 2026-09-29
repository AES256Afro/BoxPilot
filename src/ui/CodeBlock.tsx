import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./types";

export interface CodeBlockProps {
  /** The text, shown exactly: output, a journal, a config file, a command. */
  children: string;
  /** What it is, in the bar above it and as its name for assistive technology: "Journal for docker.service". */
  label: string;
  /** Offers a Copy button in the bar. On by default. */
  copy?: boolean;
  /** Keep the newest line in view as text arrives, as a terminal does (a followed log). */
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
export function CodeBlock({ children, label, copy = true, follow = false, wrap = true, empty, meta, maxHeight, className }: CodeBlockProps) {
  const pre = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [children, follow]);
  useEffect(() => { setCopied("idle"); }, [children]);
  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(children);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className={cx("ui-code", !wrap && "ui-code--nowrap", className)}>
      <div className="ui-code__bar">
        <span className="ui-code__label">{label}</span>
        {meta && <span className="ui-code__meta">{meta}</span>}
        {copy && (
          <button type="button" className="ui-code__copy" onClick={() => void onCopy()} disabled={!children}>
            {copied === "copied" ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {copied === "failed" && <p className="ui-code__note" role="status">The clipboard is not available here. Select the text and copy it by hand.</p>}
      <pre ref={pre} className="ui-code__text" tabIndex={0} aria-label={label} style={maxHeight ? { maxHeight } : undefined}>
        {children || <span className="ui-code__empty">{empty ?? "Nothing to show."}</span>}
      </pre>
    </div>
  );
}
