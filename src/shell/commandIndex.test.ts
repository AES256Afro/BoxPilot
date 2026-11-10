import { describe, expect, it } from "vitest";
import { navItems } from "../data";
import { viewFeatures } from "../pageCopy";
import { actionCommands, buildCommands, featureDetails, searchCommands, shellCommands } from "./commandIndex";

describe("the command bar's index", () => {
  it("finds Appearance by the words people look for it by, and opens Settings at that tab", () => {
    const commands = buildCommands([]);
    for (const words of ["appearance", "look", "dark mode", "wallpaper", "theme"]) {
      const found = searchCommands(commands, words).find((command) => command.id === "settings:appearance");
      expect(found, words).toMatchObject({ view: "settings", tab: "appearance", label: "Appearance" });
    }
  });

  // Words people type that used to find nothing. The first result is what Enter opens.
  it("finds a feature by the word someone would type for it, and opens its page at the right tab", () => {
    const commands = buildCommands([], actionCommands([], "owner"));
    const expected: Array<[string, { view?: string; tab?: string; shell?: string; label?: string }]> = [
      ["wifi", { view: "network", label: "Network" }],
      ["vpn", { view: "network", tab: "vpn" }],
      ["wireguard", { view: "network", tab: "vpn" }],
      ["shutdown", { view: "system", tab: "power" }],
      ["power off", { view: "system", tab: "power" }],
      ["power cut", { view: "system", tab: "power" }],
      ["notification", { view: "settings", tab: "notifications", label: "Notifications" }],
      ["passkey", { view: "settings", label: "Passkeys" }],
      ["2fa", { view: "settings", label: "Passkeys" }],
      ["recovery code", { view: "settings", label: "Recovery codes" }],
      ["activity", { shell: "activity", label: "Open Activity" }],
      ["sign out", { shell: "sign-out", label: "Sign out" }],
      ["logout", { shell: "sign-out" }],
      ["session", { view: "settings", label: "Sessions: where you're signed in" }],
      ["timezone", { view: "system", tab: "time" }],
      ["clock", { view: "system", tab: "time" }],
      ["address", { view: "network", label: "BoxPilot's address and HTTPS" }],
      ["ufw", { view: "firewall", label: "Firewall" }],
      ["cron", { view: "system", tab: "schedules", label: "Schedules" }],
      ["ssl", { view: "network" }],
      ["tls", { view: "network" }],
      ["version", { view: "system", tab: "updates", label: "BoxPilot update" }],
      ["help", { view: "repairs" }],
      ["push", { shell: "notifications", label: "Approvals on your phone" }],
      ["phone", { shell: "notifications" }],
      ["role", { view: "settings", tab: "people" }],
      ["invite", { view: "settings", tab: "people" }],
      ["sso", { view: "settings", tab: "sso" }],
      ["credentials", { view: "settings", tab: "credentials" }],
      ["secret", { view: "settings", tab: "credentials" }],
      ["heartbeat", { view: "settings", tab: "notifications", label: "Heartbeat" }],
      ["watchdog", { view: "system", tab: "power", label: "Watchdog" }],
      ["hardware", { view: "system", tab: "hardware" }],
      ["free space", { view: "system", tab: "housekeeping" }],
      ["clean", { view: "system", tab: "housekeeping" }],
      ["recycle", { view: "storage", tab: "sharing" }],
      ["smart", { view: "storage", tab: "drives" }],
      ["nas", { view: "storage", tab: "sharing" }],
      ["windows", { view: "storage", tab: "sharing" }],
      ["file sharing", { view: "storage", tab: "sharing", label: "File sharing" }],
      ["unattended", { view: "updates", label: "Automatic security updates" }],
      ["autoinstall", { view: "setup", tab: "new" }],
      ["fail2ban", { view: "firewall", tab: "bans" }],
      ["ups", { view: "system", tab: "power", label: "UPS monitoring" }],
    ];
    for (const [words, first] of expected) expect(searchCommands(commands, words)[0], words).toMatchObject(first);
  });

  // Enter runs the first result, and Sign out ends the session: only its own words put it first.
  it("puts Sign out first only when it was typed whole, and below everything else on the way there", () => {
    const commands = buildCommands([{ id: "signal", name: "Signal bridge", category: "Chat", installed: false, url: null }], actionCommands([], "owner"));
    for (const words of ["si", "sig", "sign", "out", "sign o", "log"]) {
      const found = searchCommands(commands, words);
      expect(found[0]?.shell, words).not.toBe("sign-out");
      const at = found.findIndex((command) => command.shell === "sign-out");
      if (at >= 0) expect(at, words).toBe(found.length - 1);
    }
    for (const words of ["sign out", "Sign Out", "logout", "log out", " sign  out "]) expect(searchCommands(commands, words)[0], words).toMatchObject({ shell: "sign-out" });
  });

  it("indexes Setup's features, though Setup is not in the navigation", () => {
    const setup = buildCommands([]).filter((command) => command.group === "Settings and features" && command.view === "setup");
    expect(setup.map((command) => command.label)).toEqual(viewFeatures.setup);
    expect(setup.every((command) => command.hint === "Setup" || command.hint.length > 0)).toBe(true);
  });

  it("keeps every detail on a feature its page still lists", () => {
    for (const [view, details] of Object.entries(featureDetails)) {
      for (const feature of Object.keys(details ?? {})) expect(viewFeatures[view as keyof typeof viewFeatures], `${view}: ${feature}`).toContain(feature);
    }
  });

  it("ranks a word chosen for a command above the same word met in a page's description", () => {
    const commands = buildCommands([]);
    // "version" is in more than one page's description; the feature it was written for comes first.
    expect(searchCommands(commands, "version")[0]).toMatchObject({ view: "system", tab: "updates" });
    // A page's description still finds the page.
    const described = navItems.find((item) => item.id === "today")!;
    expect(searchCommands(commands, described.label)[0]).toMatchObject({ view: "today" });
  });

  it("offers what the shell does itself among the actions", () => {
    expect(shellCommands().map((command) => [command.label, command.shell, command.group])).toEqual([
      ["Open Activity", "activity", "Actions"],
      ["Open notifications", "notifications", "Actions"],
      ["Approvals on your phone", "notifications", "Actions"],
      ["Sign out", "sign-out", "Actions"],
    ]);
  });

  it("finds publishing to the internet, which is a tab of an app's sheet, when that app is in the catalog", () => {
    const tunnel = { id: "cloudflared", name: "Cloudflare Tunnel", category: "Network", installed: true, url: null };
    const found = searchCommands(buildCommands([tunnel]), "publish internet")[0];
    expect(found).toMatchObject({ label: "Publish an app to the internet", view: "catalog", app: "cloudflared", sheet: "tunnel" });
    expect(searchCommands(buildCommands([]), "publish internet").some((command) => command.id === "catalog:publish")).toBe(false);
  });
});
