import { describe, expect, it, vi } from "vitest";
import { aptAutoremove, aptInstall, aptRemove, aptTaskInternals, aptUnattendedSet, aptUpdate, aptUpgrade, validPackageList } from "./apt.mjs";

function fakeRun(versions = {}, { failApt = false } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary === "/usr/bin/dpkg-query") {
      const name = args[args.length - 1];
      return versions[name] ? { ok: true, stdout: `install ok installed\t${versions[name]}`, stderr: "" } : { ok: false, stdout: "", stderr: "not installed" };
    }
    if (binary === "/usr/bin/dpkg") return { ok: true, stdout: "", stderr: "" };
    if (binary === "/usr/bin/apt-get") {
      if (args[0] === "install" && args[1] === "--fix-broken") return { ok: true, stdout: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.", stderr: "" };
      if (failApt) return { ok: false, stdout: "", stderr: "E: Unable to locate package nope" };
      if (args[0] === "install") for (const name of args.filter((arg) => !arg.startsWith("-") && arg !== "install")) versions[name] = versions[name] ?? "1.0";
      if (args[0] === "remove" || args[0] === "purge") for (const name of args.filter((arg) => !arg.startsWith("-") && arg !== args[0])) delete versions[name];
      return { ok: true, stdout: "Reading package lists...\n1 upgraded, 2 newly installed, 0 to remove and 3 not upgraded.", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unknown binary" };
  });
}

describe("root apt tasks", () => {
  it("validates package lists strictly", () => {
    expect(validPackageList(["htop", "git"])).toBeNull();
    expect(validPackageList([])).toContain("at least 1");
    expect(validPackageList("htop")).toContain("array");
    expect(validPackageList(["htop", "htop"])).toContain("repeat");
    expect(validPackageList(["htop; rm -rf /"])).toContain("invalid package name");
    expect(validPackageList(["-o"])).toContain("invalid package name");
    expect(validPackageList(Array.from({ length: 51 }, (_, index) => `p${index}`))).toContain("at most 50");
  });

  it("parses apt summaries", () => {
    expect(aptTaskInternals.summarizeAptOutput("1 upgraded, 2 newly installed, 0 to remove and 3 not upgraded.")).toEqual({ upgraded: 1, newlyInstalled: 2, removed: 0, notUpgraded: 3 });
    expect(aptTaskInternals.summarizeAptOutput("nothing")).toBeNull();
  });

  it("updates, upgrades, installs, removes, and autoremoves with exact argument arrays", async () => {
    const versions = { htop: "3.0" };
    const run = fakeRun(versions);
    await expect(aptUpdate({}, { run })).resolves.toMatchObject({ updated: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["update"], expect.anything());

    await expect(aptUpgrade({ packages: null, refreshFirst: false }, { run })).resolves.toMatchObject({ upgraded: true, scope: "all", summary: { upgraded: 1 }, packageStateRepaired: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/dpkg", ["--configure", "-a"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "--fix-broken", "--yes"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["upgrade", "--yes", "--with-new-pkgs"], expect.anything());
    await expect(aptUpgrade({ packages: ["htop"], refreshFirst: false }, { run })).resolves.toMatchObject({ scope: "selected", before: { htop: "3.0" } });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "--yes", "--only-upgrade", "htop"], expect.anything());

    await expect(aptInstall({ packages: ["git"], refreshFirst: false }, { run })).resolves.toMatchObject({ installed: true, before: { git: null }, after: { git: "1.0" } });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", "git"], expect.anything());

    await expect(aptRemove({ packages: ["git"], purge: true }, { run })).resolves.toMatchObject({ removed: true, purged: true, after: { git: null } });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["purge", "--yes", "--auto-remove", "git"], expect.anything());

    await expect(aptAutoremove({}, { run })).resolves.toMatchObject({ autoremoved: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["autoremove", "--yes", "--purge"], expect.anything());
  });

  it("fails closed on invalid input and apt errors", async () => {
    await expect(aptInstall({ packages: ["bad name"] }, { run: fakeRun() })).rejects.toThrow("invalid package name");
    await expect(aptInstall({ packages: ["nope"], refreshFirst: false }, { run: fakeRun({}, { failApt: true }) })).rejects.toThrow("Unable to locate package");
    await expect(aptUpgrade({ packages: "htop" }, { run: fakeRun() })).rejects.toThrow("array");
  });
});

describe("root system tasks", () => {
  it("schedules a delayed reboot via systemd-run so the result can be reported first", async () => {
    const { systemReboot } = await import("./system.mjs");
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    await expect(systemReboot({ delaySeconds: 7 }, { run })).resolves.toEqual({ scheduled: true, inSeconds: 7 });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemd-run", ["--quiet", "--on-active", "7", "--unit", "boxpilot-reboot", "/usr/bin/systemctl", "reboot"], expect.anything());
    await expect(systemReboot({ delaySeconds: 99999 }, { run })).resolves.toMatchObject({ inSeconds: 5 });
    await expect(systemReboot({}, { run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "no dbus" })) })).rejects.toThrow("Could not schedule");
  });

  it("toggles unattended upgrades, installing the package only when missing", async () => {
    const written = {};
    const files = { writeFile: vi.fn(async (path, content) => { written[path] = content; }) };
    const run = fakeRun({});
    await expect(aptUnattendedSet({ enabled: true }, { run, files, exists: async () => false })).resolves.toMatchObject({ enabled: true, installedNow: true });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", "unattended-upgrades"], expect.anything());
    expect(written["/etc/apt/apt.conf.d/20auto-upgrades"]).toContain('APT::Periodic::Unattended-Upgrade "1"');

    const disableRun = fakeRun({});
    await expect(aptUnattendedSet({ enabled: false }, { run: disableRun, files, exists: async () => true })).resolves.toMatchObject({ enabled: false, installedNow: false });
    expect(disableRun).not.toHaveBeenCalledWith("/usr/bin/apt-get", expect.anything(), expect.anything());
    expect(written["/etc/apt/apt.conf.d/20auto-upgrades"]).toContain('APT::Periodic::Unattended-Upgrade "0"');
    await expect(aptUnattendedSet({ enabled: "yes" }, { run, files })).rejects.toThrow("true or false");
  });
});
