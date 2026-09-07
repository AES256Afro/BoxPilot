import { useEffect, useRef, useState } from "react";

/** A denied or unavailable clipboard leaves a visible manual-copy path. */
export default function CopyButton({ value, label = "Copy", ariaLabel, className = "text-button" }: { value: string; label?: string; ariaLabel?: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setStatus("idle"); return () => { generation.current += 1; }; }, [value]);
  const copy = async () => {
    const ticket = ++generation.current;
    setStatus("busy");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (ticket === generation.current) setStatus("copied");
    } catch {
      if (ticket === generation.current) setStatus("failed");
    }
  };
  return <>
    <button className={className} type="button" aria-label={ariaLabel} disabled={status === "busy"} onClick={() => void copy()}>{status === "copied" ? "Copied" : status === "busy" ? "Copying..." : label}</button>
    {status === "failed" && <span role="status" className="copy-feedback">Copy unavailable. Select the text and copy it manually.</span>}
  </>;
}
