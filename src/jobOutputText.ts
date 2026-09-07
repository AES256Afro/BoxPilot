export const maxDisplayedJobOutputChars = 256 * 1024;
export const hiddenOutputNotice = "[Earlier output is hidden to keep this view responsive.]\n";

/** Keep a bounded tail before concatenating, including unusually large stream fragments. */
export function jobOutputText(current: string, incoming: string, append = false): string {
  const old = append ? current.startsWith(hiddenOutputNotice) ? current.slice(hiddenOutputNotice.length) : current : "";
  const clipped = old.length + incoming.length > maxDisplayedJobOutputChars || (append && current.startsWith(hiddenOutputNotice));
  let tail = (old.slice(-maxDisplayedJobOutputChars) + incoming.slice(-maxDisplayedJobOutputChars)).slice(-maxDisplayedJobOutputChars);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return (clipped ? hiddenOutputNotice : "") + tail;
}
