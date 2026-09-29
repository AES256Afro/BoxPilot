import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { cx } from "./types";

export interface CopyButtonProps {
  /** What goes on the clipboard. */
  value: string;
  /** The button's word: "Copy", "Copy id". */
  label?: string;
  /** What is copied, for assistive technology: "Grafana's client id" reads "Copy id Grafana's client id". */
  name?: string;
  className?: string;
}

/**
 * Copy one value from a row (a client id, a path), as CodeBlock does for a block (M33.14: Settings'
 * and Storage's copies, promoted). "Copied" only once the current value is on the clipboard: a
 * value that changes while a copy is under way leaves the button as it was. A clipboard that is
 * missing or refuses says so, and the value stays on screen to select by hand.
 */
export function CopyButton({ value, label = "Copy", name, className }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setState("idle");
    return () => { generation.current += 1; };
  }, [value]);
  const copy = async () => {
    const ticket = ++generation.current;
    setState("busy");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (ticket === generation.current) setState("copied");
    } catch {
      if (ticket === generation.current) setState("failed");
    }
  };
  return (
    <>
      <Button variant="ghost" className={cx("ui-copy", className)} aria-label={name ? `${label} ${name}` : undefined} busy={state === "busy"} onClick={() => void copy()}>
        {state === "copied" ? "Copied" : label}
      </Button>
      {state === "failed" && <span role="status" className="ui-copy__failed">Copy unavailable. Select the text and copy it by hand.</span>}
    </>
  );
}
