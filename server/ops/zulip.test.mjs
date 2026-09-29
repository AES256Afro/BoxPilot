import { describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../catalog/index.mjs";
import { registry } from "./index.mjs";
import { readCreationLink, readRealms, zulipManagePy, zulipOperations } from "./zulip.mjs";

const operations = Object.fromEntries(zulipOperations().map((operation) => [operation.id, operation]));
const link = "https://homebox.tail1234.ts.net:8543/new/abcdefghij2345klmnopqrst";
// What generate_realm_creation_link prints: Django's colours around the link.
const printed = `\u001b[32;1mPlease visit the following secure single-use link to register your \u001b[0m\n\u001b[32;1mnew Zulip organization:\u001b[0m\u001b[0m\n\n\u001b[32;1m    \u001b[1;92m${link}\u001b[0m\u001b[0m\n\n`;
const noRealms = "id    string_id            name                           domain                                            \n--    ---------            ----                           ------                                            \n1     zulipinternal        System bot realm               https://homebox.tail1234.ts.net:8543                \n";

function fakeApps(answers) {
  const execIn = vi.fn(async ({ argv }) => answers[argv[1]] ?? { ok: false, stdout: "", stderr: "unknown command" });
  return { execIn };
}

describe("Zulip's organization link", () => {
  it("reads the link out of the colours, and the organizations out of list_realms", () => {
    expect(readCreationLink(printed)).toBe(link);
    expect(readCreationLink("no link here")).toBeNull();
    expect(readRealms(noRealms)).toEqual([]);
    expect(readRealms(`${noRealms}2     ''                   Our house                      https://homebox.tail1234.ts.net:8543\n`)).toEqual([{ id: 2, stringId: "", name: "Our house", url: "https://homebox.tail1234.ts.net:8543" }]);
    // A deactivated organization is printed in red and does not count.
    expect(readRealms(`${noRealms}\u001b[31;1m3     old                  Old one                        https://old.homebox.tail1234.ts.net:8543\u001b[0m\n`)).toEqual([]);
  });

  it("runs manage.py as the zulip user, returns the link and never writes it to the job's log", async () => {
    const apps = fakeApps({ list_realms: { ok: true, stdout: noRealms, stderr: "" }, generate_realm_creation_link: { ok: true, stdout: printed, stderr: "" } });
    const lines = [];
    const result = await operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps, progress: (line) => lines.push(line) });
    expect(result).toEqual({ link, expiresInDays: 7, host: "homebox.tail1234.ts.net:8543" });
    expect(apps.execIn.mock.calls.map(([call]) => [call.id, call.user, call.argv])).toEqual([
      ["zulip", "zulip", [zulipManagePy, "list_realms"]],
      ["zulip", "zulip", [zulipManagePy, "generate_realm_creation_link"]],
    ]);
    expect(lines.join("\n")).not.toContain("/new/");
  });

  it("refuses when Zulip already has an organization, and says where to sign in", async () => {
    const apps = fakeApps({ list_realms: { ok: true, stdout: `${noRealms}2     ''                   Our house                      https://homebox.tail1234.ts.net:8543\n`, stderr: "" } });
    await expect(operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps })).rejects.toThrow("Zulip already has an organization, Our house: sign in at https://homebox.tail1234.ts.net:8543.");
    expect(apps.execIn).toHaveBeenCalledTimes(1);
  });

  it("says why when Zulip cannot answer, without its output", async () => {
    const apps = fakeApps({ list_realms: { ok: false, stdout: "secret-looking stdout", stderr: "django.db.utils.OperationalError: connection refused\n" } });
    await expect(operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps })).rejects.toThrow("Asking Zulip for its organizations failed: django.db.utils.OperationalError: connection refused");
    const noLink = fakeApps({ list_realms: { ok: true, stdout: noRealms, stderr: "" }, generate_realm_creation_link: { ok: true, stdout: "Something else", stderr: "" } });
    await expect(operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps: noLink })).rejects.toThrow("printed no link");
  });

  it("is the owner's, medium risk, for Zulip only, and its link is shown once", () => {
    const operation = registry.get("app.zulip.organization.link");
    expect(operation).toMatchObject({ risk: "medium", minimumRole: "owner", readOnly: false, oneTimeFields: ["link"] });
    expect(registry.validate("app.zulip.organization.link", { id: "zulip" })).toBeNull();
    expect(registry.validate("app.zulip.organization.link", { id: "mattermost" })).toMatch(/must be one of zulip/);
    expect(registry.validate("app.zulip.organization.link", { id: "zulip", extra: 1 })).toMatch(/does not accept/);
  });
});

describe("actions a manifest puts on an app's sheet", () => {
  it("name registered operations that take only the app's id", async () => {
    const { manifests } = await loadCatalog();
    const declared = manifests.flatMap((manifest) => manifest.actions.map((action) => ({ app: manifest.id, action })));
    expect(declared.length).toBeGreaterThan(0);
    for (const { app, action } of declared) {
      const operation = registry.get(action.operation);
      expect(operation, `${app}: ${action.operation}`).toBeTruthy();
      expect(operation.readOnly).toBe(false);
      expect(registry.validate(action.operation, { id: app }), `${app}: ${action.operation}`).toBeNull();
    }
  });
});
