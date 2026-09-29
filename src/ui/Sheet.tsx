import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../useDialogFocus";
import { CloseIcon } from "./icons";
import { cx } from "./types";

export interface SheetProps {
  /** The sheet's heading and its name: "docker.service", "Share a folder". */
  title: ReactNode;
  /** A word above the title saying what kind of thing this is: "Journal", "New share". */
  kicker?: ReactNode;
  /** Closes it: Escape, the close button, and a press on the backdrop all call it. */
  onClose: () => void;
  children: ReactNode;
  /** Buttons at the foot, the main one last. Each with its tier. */
  footer?: ReactNode;
  /**
   * right: a drawer down the right edge, for detail beside the page (a unit's journal, a row's
   * settings). center: a dialog, for a short form. A phone draws both across the full width.
   */
  side?: "right" | "center";
  /** How wide: sm 26rem, md 36rem (the default), lg 52rem. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * A drawer or a dialog over the page (M33.8). It is modal: focus moves into it, Tab stays inside
 * (useDialogFocus), Escape closes it, and focus returns to what opened it. Render it only while it
 * is open. It is drawn over the whole page, so it takes the console's look from the page's root.
 */
export function Sheet({ title, kicker, onClose, children, footer, side = "right", size = "md", className }: SheetProps) {
  const ref = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useDialogFocus(ref);
  // The latest onClose, so a parent that passes a new function each render does not re-run this.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The innermost dialog closes first: another opened over this one handles its own Escape.
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(
    <div className={cx("ui-sheet-backdrop", `ui-sheet-backdrop--${side}`)} role="presentation" onMouseDown={() => close.current()}>
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx("ui-sheet", `ui-sheet--${side}`, `ui-sheet--${size}`, className)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ui-sheet__head">
          <div className="ui-sheet__heading">
            {kicker && <span className="ui-sheet__kicker">{kicker}</span>}
            <h2 id={titleId} className="ui-sheet__title">{title}</h2>
          </div>
          <button type="button" className="ui-sheet__close" aria-label="Close" onClick={() => close.current()}>
            <CloseIcon />
          </button>
        </header>
        <div className="ui-sheet__body">{children}</div>
        {footer && <footer className="ui-sheet__foot">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}
