import { useEffect, useState } from "react";
import { Button } from "../../ui";

/**
 * Copy a value to the clipboard from a row (a client id), as the kit's CodeBlock does for a block.
 * A denied or unavailable clipboard says so, and the value stays on screen to copy by hand.
 * Local to Settings; worth promoting to src/ui as the kit's copy button.
 */
export function CopyText({ value, label = "Copy", name }: { value: string; label?: string; /** What is copied, for assistive technology: "Grafana's client id". */ name?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { setState("idle"); }, [value]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <>
      <Button variant="ghost" aria-label={name ? `${label} ${name}` : undefined} onClick={() => void copy()}>{state === "copied" ? "Copied" : label}</Button>
      {state === "failed" && <span role="status" className="settings-quiet">Copy unavailable. Select the text and copy it by hand.</span>}
    </>
  );
}
