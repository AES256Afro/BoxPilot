import { Notice } from "./ui/Notice";
import "./shell/jobs.css";

/** Notices are recorded alongside a successful result and remain visible when its live log is gone. */
export function jobWarnings(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("warnings" in result) || !Array.isArray(result.warnings)) return [];
  return result.warnings.slice(0, 20).filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0).map((warning) => warning.slice(0, 2000));
}

/** What a job that finished asked the owner to look at afterwards (M33.13: the kit's warning notice). */
export function JobWarnings({ result }: { result: unknown }) {
  const warnings = jobWarnings(result);
  if (warnings.length === 0) return null;
  return (
    <Notice tone="warning" title="Follow-up needed" className="jobs-warnings">
      <ul className="jobs-warnings__list">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </Notice>
  );
}
