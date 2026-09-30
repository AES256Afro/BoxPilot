import { useEffect, type RefObject } from "react";

/** Contain keyboard focus while a modal is open, then return it to its opener. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const dialog = ref.current;
    if (!enabled || !dialog) return;
    // The page's body is no opener: it is what focus falls to once the button that opened this is gone.
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog.focus();
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')).filter((element) => {
      if (element.tabIndex < 0 || element.closest("[hidden], [inert]")) return false;
      for (let parent: HTMLElement | null = element; parent && parent !== dialog; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector("summary") !== element) return false;
      }
      return true;
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0]; const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      const active = document.activeElement;
      if (!dialog.contains(active) || active === dialog) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    const onFocus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      if (opener?.isConnected) { opener.focus(); return; }
      // What opened it is gone (a tab changed under it, a page opened at an app's sheet, a row that
      // was acted on): focus fell to the document, and the next Tab started at the top of the page.
      // The page's own content is the nearest sensible place, unless another dialog has taken over.
      if (document.querySelector('[aria-modal="true"]')) return;
      (document.getElementById("content") ?? document.querySelector<HTMLElement>("main"))?.focus({ preventScroll: true });
    };
  }, [ref, enabled]);
}
