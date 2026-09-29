import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../ui";

/*
 * Two small pieces the Network page needs that the kit does not have yet (M33.10), kept here until
 * a second page wants them: a Copy button for one value, and a link drawn as the kit's Button.
 */

/** Copies one value; a clipboard that refuses says so, and the value stays on screen to copy by hand. */
export function CopyValue({ value, label }: { value: string; /** What is copied, for its name: "Copy https://homebox…". */ label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const ticket = useRef(0);
  useEffect(() => { ticket.current += 1; setState("idle"); }, [value]);
  const copy = async () => {
    const mine = ++ticket.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (mine === ticket.current) setState("copied");
    } catch {
      if (mine === ticket.current) setState("failed");
    }
  };
  return (
    <>
      <Button variant="ghost" className="network-copy" aria-label={label} onClick={() => void copy()}>{state === "copied" ? "Copied" : "Copy"}</Button>
      {state === "failed" && <span role="status" className="network-copy__failed">Select it and copy by hand.</span>}
    </>
  );
}

/** A link that looks like a Button: a download, or a page elsewhere. It starts nothing on the server, so it has no tier. */
export function LinkButton({ href, children, download, external = false, variant = "secondary" }: { href: string; children: ReactNode; download?: string | boolean; external?: boolean; variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <a
      className={`ui-button ui-button--${variant} network-linkbutton`}
      href={href}
      download={download === true ? "" : download || undefined}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      <span className="ui-button__label">{children}</span>
    </a>
  );
}
