import { useEffect, useRef, useState } from "react";
import { takeOneTimeResult } from "../operations";
import { CopyButton, Notice } from "../ui";

/*
 * What a finished job shows once (M38): an operation's oneTimeFields, like Zulip's single-use link
 * to create an organization. The server never stored them with the job; it hands them to the person
 * who ran it the first time this asks, and never again. So this asks exactly once, even when the
 * dialog renders twice, and says plainly that the value will not be shown again.
 */

const fieldWords: Record<string, string> = { link: "Link", url: "Address", token: "Token", code: "Code" };
const isLink = (value: string) => /^https:\/\/[^\s]+$/.test(value);

export function OneTimeResult({ jobId, fields, csrfToken }: { jobId: string; fields: string[]; csrfToken: string }) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!asked.current) {
      asked.current = true;
      takeOneTimeResult(jobId, csrfToken)
        .then((answer) => { if (mounted.current) setValue(answer.value); })
        .catch((requestError: unknown) => { if (mounted.current) setError(requestError instanceof Error ? requestError.message : "It could not be read"); });
    }
    return () => { mounted.current = false; };
  }, [jobId, csrfToken]);

  if (error) return <Notice tone="warning" title="Shown once already">{error}</Notice>;
  if (!value) return <p className="approve-note" role="status">Reading what it made for you…</p>;
  return (
    <div className="approve-once" role="group" aria-label="Shown once">
      {fields.filter((field) => typeof value[field] === "string").map((field) => {
        const text = value[field] as string;
        return (
          <div key={field} className="approve-once__row">
            <span className="approve-once__label">{fieldWords[field] ?? field}</span>
            <code className="approve-once__value">{text}</code>
            <span className="approve-once__actions">
              <CopyButton value={text} name={fieldWords[field] ?? field} />
              {isLink(text) && <a className="ui-button ui-button--primary" href={text} target="_blank" rel="noreferrer"><span className="ui-button__label">Open</span></a>}
            </span>
          </div>
        );
      })}
      <p className="approve-note">Shown this once: BoxPilot did not keep it. Copy it or open it now.</p>
    </div>
  );
}
