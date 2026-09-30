import { useCallback, useState, type ReactNode } from "react";

/**
 * "Check again" on Home and "Read again" on Ops, with something to show for the click (the
 * usability pass, 2026-09-29). Both used to read every source again in the background and change
 * nothing on screen when nothing had changed on the server, so the click looked ignored. Now the
 * button says it is checking while the reads are out, and once they have all answered, a status
 * line says so to assistive technology as well.
 */
export function useCheckAgain(refresh: () => Promise<unknown>): { checking: boolean; run: () => void; said: ReactNode } {
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const run = useCallback(() => {
    setChecking(true);
    void refresh().finally(() => {
      setChecking(false);
      setCheckedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    });
  }, [refresh]);
  const said = <span className="ui-visually-hidden" role="status">{checkedAt && !checking ? `Checked again at ${checkedAt}.` : ""}</span>;
  return { checking, run, said };
}
