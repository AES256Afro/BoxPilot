import { useCallback, useState, type ReactNode } from "react";
import { readJson } from "../http";

/** "07:41", in the reader's own clock. */
const clockOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The health round's answer (M88): when it ran, and `fresh: false` when it was asked too soon and the last one stands. */
interface CheckAnswer { checkedAt?: unknown; fresh?: unknown }

interface CheckAgainOptions {
  /** With it, the click first asks the server for a health round now (it may reuse one just run). */
  csrfToken?: string;
  /** When the health alerts were last checked, as the watcher's own read says, until a click says newer. */
  healthCheckedAt?: string | null;
}

/**
 * "Check again" on Home, Ops and Today, and "Read again" in the looks, with something to show for
 * the click (the usability pass, 2026-09-29). The button says it is checking while the reads are
 * out. A click starts a health round on the server first (M88: re-reading the watcher's stored state
 * checked nothing, and the round runs every fifteen minutes), then reads every source again, with
 * `fresh` so Repair's scan looks at the drives again. Then a visible line says when this happened
 * and how old the health alerts are: "Checked 07:41 · health checked 07:30". It was visually hidden,
 * so an alert that stayed looked as if the click had done nothing.
 */
export function useCheckAgain(refresh: (options: { fresh: boolean }) => Promise<unknown>, { csrfToken, healthCheckedAt = null }: CheckAgainOptions = {}): { checking: boolean; run: () => void; said: ReactNode } {
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [roundAt, setRoundAt] = useState<string | null>(null);
  const run = useCallback(() => {
    setChecking(true);
    void (async () => {
      if (csrfToken) {
        try {
          const body = await readJson<CheckAnswer>(await fetch("/api/v1/settings/watch/check", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }));
          // `fresh: false` is a round run moments ago, reused: its time is the answer all the same.
          if (typeof body?.checkedAt === "string") setRoundAt(body.checkedAt);
        } catch {
          // A server that cannot start a round (or a role that may not) still has everything read again.
        }
      }
      try {
        await refresh({ fresh: true });
      } finally {
        setChecking(false);
        setCheckedAt(Date.now());
      }
    })();
  }, [csrfToken, refresh]);
  const health = [roundAt, healthCheckedAt].map((iso) => (iso ? Date.parse(iso) : Number.NaN)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const words = checkedAt !== null && !checking ? `Checked ${clockOf(checkedAt)}${health !== undefined ? ` · health checked ${clockOf(health)}` : ""}` : "";
  const said = <span className="check-again__said" role="status">{words}</span>;
  return { checking, run, said };
}
