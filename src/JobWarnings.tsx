/** Notices are recorded alongside a successful result and remain visible when its live log is gone. */
export function jobWarnings(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("warnings" in result) || !Array.isArray(result.warnings)) return [];
  return result.warnings.slice(0, 20).filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0).map((warning) => warning.slice(0, 2000));
}

export function JobWarnings({ result }: { result: unknown }) {
  const warnings = jobWarnings(result);
  return warnings.length > 0 ? <div className="notice warning-notice job-warning" role="status"><strong>Follow-up needed</strong><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null;
}
