import type { ViewName } from "./data";

/*
 * Whether running a failed thing again, as it was, can work (the usability pass, 2026-09-29).
 *
 * Home offered "Try again" on a failed "Reconnect a drive" for the backup share, and every try failed
 * the same way, because the error named a different fix. A failure is one of three kinds:
 *
 * - the same run can work once something outside BoxPilot changes (a drive plugged in, a NAS switched
 *   on, a folder let go): Try again stays, and the row says what to do first;
 * - the fix is somewhere else in BoxPilot (install a tool, free space, save a profile, use Reinstall):
 *   Try again would fail the same way, so the button opens that place instead;
 * - nothing will change it (the app has no data to back up): only Dismiss.
 *
 * Read from the error's words, which the server writes for the owner and which name the fix when there
 * is one. Anything not recognised keeps Try again: a transient failure is the common case.
 */

export interface RetryNext {
  /** The button's words: "Free up space". */
  label: string;
  view: ViewName;
  tab?: string;
}

export interface RetryAdvice {
  /** Whether the same run, again, can work. */
  retry: boolean;
  /** Where the fix is, when it is somewhere else in BoxPilot. */
  next?: RetryNext;
  /** What to do first, in the error's own words, when it says ("Check that it is plugged in…"). */
  instruction?: string;
}

interface Rule { test: RegExp; retry: boolean; next?: RetryNext }

const repair: RetryNext = { label: "Open Repair", view: "repairs" };
const shares: RetryNext = { label: "Open Shares", view: "storage", tab: "shares" };

/** Worst first: a rule that names another place wins over one that only says "check the device". */
const rules: Rule[] = [
  // Space: running out again is certain until something is cleared (Immich's backup on the unwell demo).
  { test: /no space left on device|disk (?:is )?full|not enough (?:free )?space/i, retry: false, next: { label: "Free up space", view: "system", tab: "housekeeping" } },
  // A port someone else holds (Dockge, 2026-09-29): Repair's port finding offers the choices.
  { test: /\bPort \d+(?:\/udp)? (?:is taken|is also claimed|is already in use)\b/, retry: false, next: repair },
  // A tool or a step that has to come first, named by the page it lives on.
  { test: /from (?:the )?Repair(?: Center)? first|use Reinstall in Repair|Docker Engine is not available/i, retry: false, next: repair },
  { test: /install it from the Backups page first|Generate the mirror key first/i, retry: false, next: { label: "Open Off-box", view: "backups", tab: "offbox" } },
  { test: /nothing to mirror yet/i, retry: false, next: { label: "Open Backups", view: "backups", tab: "server" } },
  { test: /install (?:it|cifs-utils|nfs-common) from the Storage page|cifs-utils is missing|nfs-common is missing/i, retry: false, next: shares },
  { test: /refused the credentials|share does not exist on that host/i, retry: false, next: shares },
  { test: /Save a VPN profile in the VPN section first/i, retry: false, next: { label: "Open VPN", view: "network", tab: "vpn" } },
  { test: /save it under Settings first/i, retry: false, next: { label: "Open Credentials", view: "settings", tab: "credentials" } },
  { test: /is not mounted, so there is nothing to \w+ yet|Reconnect the drive first|mount it first/i, retry: false, next: { label: "Open Storage", view: "storage" } },
  { test: /is already installed; use reconfigure or update|start or restart it instead/i, retry: false, next: { label: "Open App catalog", view: "catalog" } },
  // Nothing BoxPilot can change by running it again.
  { test: /has no data to back up|is already scheduled/i, retry: false },
];

/** The sentence that says what to do, when the error ends with one: "Check …", "Stop … and try again". */
const instructionPattern = /(?:^|[.;:!?]\s+)((?:Check|Stop|Close|Disconnect|Plug|Switch|Turn|Free|Make sure|Wait|Unplug|Connect)\b[^]*?[.!]?)$/i;

export function adviseRetry(error: string | null | undefined): RetryAdvice {
  const text = String(error ?? "").trim();
  if (!text) return { retry: true };
  const instruction = instructionPattern.exec(text)?.[1]?.trim();
  for (const rule of rules) {
    if (rule.test.test(text)) return { retry: rule.retry, ...(rule.next ? { next: rule.next } : {}), ...(instruction ? { instruction } : {}) };
  }
  return { retry: true, ...(instruction ? { instruction } : {}) };
}

/**
 * A failure said in a row that holds a line or two: the start of what went wrong and, when the error
 * ends by saying what to do, that - which a plain cut at 110 characters used to drop, leaving only a
 * "Try again" for a drive that was not plugged in.
 */
export function failureLine(prefix: string, error: string | null | undefined, limit = 150): string {
  const text = String(error ?? "").trim() || "no error was recorded";
  const { instruction } = adviseRetry(text);
  const cut = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s,:;.—-]+$/, "")}…`);
  if (!instruction || instruction.length >= text.length) return cut(`${prefix}${text}`, limit);
  const head = text.slice(0, text.length - instruction.length).replace(/[\s.;:!?]+$/, "");
  const room = Math.max(40, limit - instruction.length - 2);
  return `${cut(`${prefix}${head}`, room)}. ${cut(instruction, limit)}`;
}
