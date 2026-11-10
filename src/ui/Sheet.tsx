import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
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
  /**
   * For a sheet that is one form: the body and the foot are drawn inside a <form>, so Enter in a
   * field does what the main button does. Give that button type="submit" (and no onClick); while it
   * is disabled Enter does nothing, as the browser has it. A sheet that draws its own <form> and
   * points a button at it with form= leaves this out.
   */
  onSubmit?: () => void;
  /**
   * false for a sheet that is read more than filled in, whose first input is a filter or a search
   * (Activity, the notifications, an app's sheet): focus stays on the sheet, and a phone does not
   * raise its keyboard over the list. A touch device never has its first field focused either way.
   */
  focusFirstField?: boolean;
  className?: string;
}

/** Where typing starts in a sheet: its first field that takes any, never a button. */
const firstField = ':is(input:not([type="hidden"], [type="button"], [type="submit"], [type="reset"]), textarea, select):not([disabled])';

/** A device pointed at with a finger: focusing a field there raises the keyboard over the sheet. */
const touchFirst = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && Boolean(window.matchMedia("(pointer: coarse)")?.matches);

/**
 * A drawer or a dialog over the page (M33.8). It is modal: focus moves into it (to its first field, when it has one), Tab stays inside
 * (useDialogFocus), Escape closes it, and focus returns to what opened it. Render it only while it
 * is open. It is drawn over the whole page, so it takes the console's look from the page's root.
 */
export function Sheet({ title, kicker, onClose, children, footer, side = "right", size = "md", onSubmit, focusFirstField = true, className }: SheetProps) {
  const ref = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useDialogFocus(ref);
  // Focus goes to the sheet's first field, so typing starts there and the first Tab is not Close.
  // Once, as it opens: a field that appears or is enabled later does not pull focus from where it is.
  // A sheet with no field keeps focus on the sheet itself; so does one that asks for that, and every
  // sheet on a touch device, where focus in a field is a keyboard over half the screen.
  useEffect(() => {
    if (!focusFirstField || touchFirst()) return;
    const field = [...(bodyRef.current?.querySelectorAll<HTMLElement>(firstField) ?? [])].find((element) => !element.closest("[hidden], [inert]"));
    field?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
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
  // A stray click outside a sheet with a form in it used to throw the typing away (M50): the backdrop
  // closes only a sheet with nothing typed in it; Escape and the close button always do.
  const backdrop = () => {
    const fields = [...(ref.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input") ?? [])];
    const typed = fields.some((field) => !["checkbox", "radio", "hidden", "submit", "button", "file", "range", "color"].includes(field.type) && field.value !== "");
    if (!typed) close.current();
  };
  return createPortal(
    <div className={cx("ui-sheet-backdrop", `ui-sheet-backdrop--${side}`)} role="presentation" onMouseDown={backdrop}>
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
        {onSubmit ? (
          <form className="ui-sheet__form" onSubmit={(event: FormEvent) => { event.preventDefault(); submit.current?.(); }}>
            <div ref={bodyRef} className="ui-sheet__body">{children}</div>
            {footer && <footer className="ui-sheet__foot">{footer}</footer>}
          </form>
        ) : (
          <>
            <div ref={bodyRef} className="ui-sheet__body">{children}</div>
            {footer && <footer className="ui-sheet__foot">{footer}</footer>}
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
