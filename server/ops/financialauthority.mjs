/**
 * FinancialAuthority (catalog/financialauthority.yaml): its own restore points, managed from its sheet.
 * App-specific because the app keeps copies of its database for its own undo (before every import, daily,
 * on request), and only the app can make one consistently while it runs: it uses SQLite's online backup and
 * reads each copy back before it counts. BoxPilot's ordinary app backup still archives the app's data; these
 * operations ask the app, through its own command (`python -m app.restore`, JSON out), for a copy now and for
 * a check of the database and its copies. Restoring a copy stays in the app, where the owner signs in and
 * confirms; restoring an archive is BoxPilot's own app restore.
 */
import { defineOperation } from "./registry.mjs";

export const financialAuthorityAppId = "financialauthority";
/** The image's user and its Python; the app's working directory is the image's WORKDIR. */
export const appUser = "app";
export const restoreCommand = ["/app/backend/.venv/bin/python", "-m", "app.restore"];

const minutes = (count) => count * 60_000;

/** The JSON object the app's command printed last; null when it printed none. */
export function readAppJson(stdout) {
  const lines = String(stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{") || line.startsWith("["));
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // not the line we want
    }
  }
  return null;
}

/** Why the app's command failed, in a sentence: its own error, or the end of what it printed. */
function failure(result, what) {
  if (result?.timedOut) return new Error(`${what} did not finish in time; FinancialAuthority may be busy. Try again in a minute.`);
  const said = readAppJson(result?.stdout);
  if (said?.error) return new Error(`${what} failed: ${String(said.error).slice(0, 300)}`);
  const tail = String(result?.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? "";
  if (/No module named app\.restore/.test(tail)) return new Error(`${what} needs FinancialAuthority 0.3.0 or newer; update it from its card first.`);
  return new Error(`${what} failed${tail ? `: ${tail.slice(0, 300)}` : ""}`);
}

async function runApp(apps, args, what, timeoutMs) {
  const result = await apps.execIn({ id: financialAuthorityAppId, user: appUser, argv: [...restoreCommand, ...args], timeoutMs });
  const out = result.ok ? readAppJson(result.stdout) : null;
  if (!result.ok || !out || out.error) throw failure(result, what);
  return out;
}

const hours = (value) => (value === null || value === undefined ? null : Number(value));

export function financialAuthorityOperations() {
  const parameters = { exact: true, fields: { id: { type: "string", enum: [financialAuthorityAppId] } } };
  return [
    defineOperation({
      // low: it adds a copy beside the others and changes nothing the app holds.
      id: "app.financialauthority.restorepoint.make", title: "Take a FinancialAuthority restore point", risk: "low", minimumRole: "operator", timeoutMs: minutes(5),
      description: "Asks FinancialAuthority to copy its whole database now with SQLite's online backup while it runs, read the copy back, and keep it with its own restore points (the app keeps its newest ten taken this way). Put a copy back from the app's Settings > Backups. BoxPilot's own backup of the app is separate and unchanged.",
      parameters,
      run: async (_parameters, { apps, progress }) => {
        progress?.("Asking FinancialAuthority for a copy of its database", "stdout");
        const made = await runApp(apps, ["make", "Taken from BoxPilot"], "Taking a restore point", minutes(4));
        progress?.(`Copied and read back: ${made.name}`, "stdout");
        return { name: made.name, bytes: made.bytes, verified: Boolean(made.verified), transactions: made.transactions ?? null, createdAt: made.created_at };
      },
    }),
    defineOperation({
      // low: it reads the database and the newest copies, and writes only the app's note of when it was checked.
      id: "app.financialauthority.backups.check", title: "Check FinancialAuthority's database and restore points", risk: "low", minimumRole: "operator", timeoutMs: minutes(5),
      description: "Has SQLite check every page of FinancialAuthority's live database and of its three newest restore points, reports how many copies the app keeps, how much space they take and how old the newest is, and leaves a note in the app of when it was checked. Fails when the database does not pass.",
      parameters,
      run: async (_parameters, { apps, progress }) => {
        progress?.("Checking the live database and the newest copies", "stdout");
        const checked = await runApp(apps, ["check", "BoxPilot"], "Checking the database", minutes(4));
        const status = await runApp(apps, ["status"], "Reading the restore points", minutes(1));
        const database = checked.database ?? {};
        if (!database.ok) throw new Error(`FinancialAuthority's database did not pass its check: ${String(database.result ?? "no answer").slice(0, 200)}. Its newest copy and BoxPilot's archive are still there; restore from the app's Settings > Backups or from the app's card.`);
        const points = Object.entries(checked.points ?? {});
        const bad = points.filter(([, result]) => result !== "ok").map(([name]) => name);
        const age = hours(status.latest_age_hours);
        const stale = age === null || age > 48;
        progress?.(`Database passes; ${status.count} copies, newest ${age === null ? "none" : `${age} hours old`}`, "stdout");
        return {
          database: "ok", transactions: database.transactions ?? null, copies: status.count ?? 0, bytes: status.bytes ?? 0, newestAgeHours: age,
          copiesChecked: points.length, copiesFailing: bad, verdict: bad.length || stale ? "needs a look" : "healthy",
          note: bad.length ? `${bad.length} of the newest copies did not read back: ${bad.join(", ")}` : stale ? "No copy in the last two days; the app makes one daily and before each import." : "Database and newest copies read back.",
        };
      },
    }),
  ];
}
