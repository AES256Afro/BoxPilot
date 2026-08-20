import { describe, expect, it, vi } from "vitest";
import { dockerLoggingDefaults, mergeDockerLoggingDefaults, rewriteHostsFile, rewriteSysctlDropIn, setHostname, setLocale, setSwappiness, setTimezone } from "./system.mjs";

function fakeFiles(contents = {}) {
  const written = {};
  return {
    written,
    readFile: vi.fn(async (path) => {
      if (path in written) return written[path];
      if (path in contents) return contents[path];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    writeFile: vi.fn(async (path, content) => { written[path] = content; }),
  };
}

const okRun = () => vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));

describe("root system tasks", () => {
  it("rewrites the 127.0.1.1 hosts entry in place and appends when missing", () => {
    expect(rewriteHostsFile("127.0.0.1\tlocalhost\n127.0.1.1\toldname\n\n::1 ip6-localhost\n", "newname"))
      .toBe("127.0.0.1\tlocalhost\n127.0.1.1\tnewname\n\n::1 ip6-localhost\n");
    expect(rewriteHostsFile("127.0.0.1\tlocalhost\n", "newname")).toBe("127.0.0.1\tlocalhost\n127.0.1.1\tnewname\n");
  });

  it("sets the hostname via hostnamectl and updates /etc/hosts", async () => {
    const files = fakeFiles({ "/etc/hostname": "oldname\n", "/etc/hosts": "127.0.0.1 localhost\n127.0.1.1\toldname\n" });
    const run = okRun();
    await expect(setHostname({ hostname: "shiny-box" }, { run, files })).resolves.toEqual({ hostname: "shiny-box", previous: "oldname" });
    expect(run).toHaveBeenCalledWith("/usr/bin/hostnamectl", ["set-hostname", "shiny-box"], expect.anything());
    expect(files.written["/etc/hosts"]).toContain("127.0.1.1\tshiny-box");
  });

  it("rejects invalid hostnames before touching the system", async () => {
    const run = okRun();
    await expect(setHostname({ hostname: "Bad Name" }, { run, files: fakeFiles() })).rejects.toThrow("Hostname");
    await expect(setHostname({ hostname: "-leading" }, { run, files: fakeFiles() })).rejects.toThrow("Hostname");
    expect(run).not.toHaveBeenCalled();
  });

  it("sets the time zone only when the zoneinfo file exists", async () => {
    const run = okRun();
    await expect(setTimezone({ timezone: "Europe/Berlin" }, { run, exists: async () => true })).resolves.toEqual({ timezone: "Europe/Berlin" });
    expect(run).toHaveBeenCalledWith("/usr/bin/timedatectl", ["set-timezone", "Europe/Berlin"], expect.anything());
    await expect(setTimezone({ timezone: "Europe/Nowhere" }, { run, exists: async () => false })).rejects.toThrow("not installed");
    await expect(setTimezone({ timezone: "../etc/passwd" }, { run, exists: async () => true })).rejects.toThrow("IANA");
  });

  it("replaces a managed sysctl line without disturbing other settings", () => {
    expect(rewriteSysctlDropIn("", "vm.swappiness", 10)).toBe("# Managed by BoxPilot (System page). Other lines are preserved.\nvm.swappiness = 10\n");
    expect(rewriteSysctlDropIn("net.core.somaxconn = 1024\nvm.swappiness=60\n", "vm.swappiness", 10))
      .toBe("net.core.somaxconn = 1024\nvm.swappiness = 10\n");
  });

  it("sets only generated locales", async () => {
    const run = vi.fn(async (binary) => (binary === "/usr/bin/locale" ? { ok: true, stdout: "C\nC.utf8\nen_US.utf8\n", stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    await expect(setLocale({ locale: "en_US.utf8" }, { run })).resolves.toMatchObject({ locale: "en_US.utf8" });
    expect(run).toHaveBeenCalledWith("/usr/sbin/update-locale", ["LANG=en_US.utf8"], expect.anything());
    await expect(setLocale({ locale: "xx_XX.utf8" }, { run })).rejects.toThrow("not generated");
    await expect(setLocale({ locale: "bad locale" }, { run })).rejects.toThrow("invalid");
  });

  it("merges docker logging defaults without clobbering other daemon.json keys", async () => {
    expect(mergeDockerLoggingDefaults("")).toEqual({ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true });
    expect(mergeDockerLoggingDefaults('{"dns": ["1.1.1.1"], "log-opts": {"labels": "app"}}')).toEqual({
      dns: ["1.1.1.1"], "log-driver": "json-file", "log-opts": { labels: "app", "max-size": "10m", "max-file": "3" }, "live-restore": true,
    });
    expect(() => mergeDockerLoggingDefaults("not json")).toThrow("invalid JSON");

    const written = {};
    const files = { readFile: vi.fn(async () => { throw new Error("ENOENT"); }), writeFile: vi.fn(async (path, content) => { written[path] = content; }) };
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    await expect(dockerLoggingDefaults({}, { run, files })).resolves.toMatchObject({ applied: true });
    expect(JSON.parse(written["/etc/docker/daemon.json"])).toMatchObject({ "live-restore": true });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["restart", "docker.service"], expect.anything());
  });

  it("persists swappiness and applies it live", async () => {
    const files = fakeFiles();
    const run = okRun();
    await expect(setSwappiness({ value: 15 }, { run, files })).resolves.toMatchObject({ swappiness: 15 });
    expect(files.written["/etc/sysctl.d/99-boxpilot.conf"]).toContain("vm.swappiness = 15");
    expect(run).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-w", "vm.swappiness=15"], expect.anything());
    await expect(setSwappiness({ value: 101 }, { run, files })).rejects.toThrow("between 0 and 100");
    await expect(setSwappiness({ value: 1.5 }, { run, files })).rejects.toThrow("between 0 and 100");
  });
});
