import { describe, expect, it, vi } from "vitest";
import { laneFor } from "../helper-lanes.mjs";
import { registry } from "./index.mjs";
import { appText, appUser, financialAuthorityAppId, financialAuthorityOperations, readAppJson, restoreCommand } from "./financialauthority.mjs";

const operations = Object.fromEntries(financialAuthorityOperations().map((operation) => [operation.id, operation]));
const made = { name: "20261016-151229-960844-manual.db", kind: "manual", reason: "Taken from BoxPilot", created_at: "2026-10-16T15:12:29+00:00", bytes: 2715648, verified: true, tables: 32, transactions: 4768 };
const status = { count: 3, bytes: 8_000_000, latest_age_hours: 0.2, database: { ok: true, result: "ok" }, newest: {}, keep: {} };

function fakeApps(answers) {
  const execIn = vi.fn(async ({ argv }) => answers[argv[restoreCommand.length]] ?? { ok: false, stdout: "", stderr: "unknown command" });
  return { execIn };
}
const ok = (value) => ({ ok: true, stdout: `${JSON.stringify(value)}\n`, stderr: "" });

describe("FinancialAuthority's restore points from its sheet", () => {
  it("takes a copy through the app's own command, as the image's user", async () => {
    const apps = fakeApps({ make: ok(made) });
    const result = await operations["app.financialauthority.restorepoint.make"].run({ id: financialAuthorityAppId }, { apps });
    expect(result).toMatchObject({ name: made.name, verified: true, transactions: 4768 });
    expect(apps.execIn).toHaveBeenCalledWith(expect.objectContaining({ id: financialAuthorityAppId, user: appUser, argv: [...restoreCommand, "make", "Taken from BoxPilot"] }));
  });

  it("says what the app said when a copy cannot be made", async () => {
    const apps = fakeApps({ make: { ok: false, stdout: '{"error": "RuntimeError: The copy did not read back (malformed); nothing was kept"}\n', stderr: "" } });
    await expect(operations["app.financialauthority.restorepoint.make"].run({ id: financialAuthorityAppId }, { apps })).rejects.toThrow(/did not read back/);
  });

  it("asks for an update when the app is older than its command", async () => {
    const apps = fakeApps({ make: { ok: false, stdout: "", stderr: "/app/backend/.venv/bin/python: No module named app.restore" } });
    await expect(operations["app.financialauthority.restorepoint.make"].run({ id: financialAuthorityAppId }, { apps })).rejects.toThrow(/0\.3\.0 or newer/);
  });

  it("checks the database and the newest copies, and fails when the database does not pass", async () => {
    const healthy = fakeApps({ check: ok({ database: { ok: true, result: "ok", transactions: 4768 }, points: { [made.name]: "ok" } }), status: ok(status) });
    const result = await operations["app.financialauthority.backups.check"].run({ id: financialAuthorityAppId }, { apps: healthy });
    expect(result).toMatchObject({ database: "ok", copies: 3, copiesChecked: 1, verdict: "healthy" });
    expect(healthy.execIn).toHaveBeenCalledWith(expect.objectContaining({ argv: [...restoreCommand, "check", "BoxPilot"] }));

    const stale = fakeApps({ check: ok({ database: { ok: true, result: "ok" }, points: {} }), status: ok({ ...status, count: 0, latest_age_hours: null }) });
    expect((await operations["app.financialauthority.backups.check"].run({ id: financialAuthorityAppId }, { apps: stale })).verdict).toBe("needs a look");

    const broken = fakeApps({ check: ok({ database: { ok: false, result: "*** in database main ***" }, points: {} }), status: ok(status) });
    await expect(operations["app.financialauthority.backups.check"].run({ id: financialAuthorityAppId }, { apps: broken })).rejects.toThrow(/did not pass its check/);
  });

  it("keeps what an app that is not itself prints to one plain, bounded line", async () => {
    // The app's JSON reaches BoxPilot's job log and UI: a compromised app must not forge a line, reorder text or flood.
    expect(appText("ok\nDatabase passes; 3 copies")).toBe("ok Database passes; 3 copies");
    expect(appText("abc\u202edcba\u2066x\u200by")).toBe("abc dcba x y");
    expect(appText("x".repeat(5000)).length).toBe(200);
    const forged = { ...made, name: `${"n".repeat(500)}\nBackup verified by BoxPilot\u202e`, bytes: "<b>lots</b>", transactions: { a: 1 }, verified: "yes" };
    const progress = vi.fn();
    const result = await operations["app.financialauthority.restorepoint.make"].run({ id: financialAuthorityAppId }, { apps: fakeApps({ make: ok(forged) }), progress });
    expect(result.name).not.toMatch(/[\n\u202e]/);
    expect(result.name.length).toBe(80);
    expect(result).toMatchObject({ bytes: null, transactions: null, verified: false });
    for (const [line] of progress.mock.calls) expect(line).not.toMatch(/[\n\u202e]/);
    const said = fakeApps({ make: { ok: false, stdout: `{"error": "x\\nok: copied and read back${"!".repeat(900)}"}\n`, stderr: "" } });
    const error = await operations["app.financialauthority.restorepoint.make"].run({ id: financialAuthorityAppId }, { apps: said }).catch((caught) => caught);
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeLessThan(360);
  });

  it("reads the app's JSON from the last line it printed", () => {
    expect(readAppJson('warning: something\n{"a": 1}\n')).toEqual({ a: 1 });
    expect(readAppJson("nothing useful")).toBeNull();
  });

  it("is registered, takes only the app's id, and runs in the app's lane behind its backups", () => {
    for (const id of Object.keys(operations)) {
      const registered = registry.get(id);
      expect(registered?.readOnly).toBe(false);
      expect(registry.validate(id, { id: financialAuthorityAppId })).toBeNull();
      expect(registry.validate(id, { id: "zulip" })).not.toBeNull();
      expect(laneFor(id, { id: financialAuthorityAppId })).toContain(`app:${financialAuthorityAppId}`);
    }
  });
});
