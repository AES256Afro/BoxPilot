import { describe, expect, it, vi } from "vitest";
import { inspectControllerFiles, addControllerConnectivity } from "./controller-doctor.mjs";
const paths = { install: "/install", state: "/state", socket: "/socket", logs: "/logs" };
function fixture() {
  return {
    paths, platform: "linux", nodeVersion: "24.1.0", now: () => new Date(0),
    run: vi.fn(async (binary, args) => ({ ok: true, stdout: binary.endsWith("id") ? "1000" : `ActiveState=active\nSubState=running\nUser=${args[1] === "boxpilot.service" ? "boxpilot" : "root"}\nNRestarts=0` })),
    inspect: async (file) => ({ uid: file === "/state" ? 1000 : 0, gid: 1000, mode: file === "/state" ? 0o700 : file === "/socket" ? 0o660 : 0o750, size: 100, isSymbolicLink: () => false, isFile: () => file.startsWith("/install/"), isDirectory: () => ["/state", "/logs"].includes(file), isSocket: () => file === "/socket" }),
    read: async () => JSON.stringify({ version: "1.2.3" }), filesystem: async () => ({ bavail: 1024 ** 2, bsize: 4096, ffree: 10000, files: 20000 }),
  };
}
describe("independent controller health", () => {
  it("checks fixed metadata without reading credentials or database contents", async () => {
    const options = fixture(); options.read = vi.fn(options.read);
    const report = await inspectControllerFiles(options);
    expect(report.status).toBe("ready");
    expect(report.installedVersion).toBe("1.2.3");
    expect(options.read).toHaveBeenCalledTimes(1);
    expect(options.read).toHaveBeenCalledWith("/install/package.json", "utf8");
    expect(options.run.mock.calls.every(([binary]) => ["/usr/bin/id", "/usr/bin/systemctl"].includes(binary))).toBe(true);
  });
  it("identifies permissions drift, missing assets, low inodes and stopped services", async () => {
    const options = fixture(); const inspect = options.inspect; const run = options.run;
    options.inspect = async (file) => { if (file.endsWith("dist/index.html")) throw Object.assign(new Error(), { code: "ENOENT" }); const info = await inspect(file); return file === "/state" ? { ...info, mode: 0o777 } : info; };
    options.run = async (binary, args) => args[1] === "boxpilot.service" ? { ok: true, stdout: "ActiveState=failed\nSubState=failed\nUser=boxpilot" } : run(binary, args);
    options.filesystem = async () => ({ bavail: 200, bsize: 4096, ffree: 4, files: 20000 });
    const report = await inspectControllerFiles(options);
    expect(report.checks.filter((item) => item.status === "fail").map((item) => item.id)).toEqual(expect.arrayContaining(["web-service", "state-directory", "asset:dist/index.html", "free-space", "free-inodes"]));
    expect(report.status).toBe("needs-attention");
  });
  it("does not call unreadable protected metadata a permission defect", async () => {
    const options = fixture(); const inspect = options.inspect;
    options.inspect = async (file) => { if (file === "/socket") throw Object.assign(new Error(), { code: "EACCES" }); return inspect(file); };
    const report = await inspectControllerFiles(options);
    expect(report.checks.find((item) => item.id === "helper-socket").status).toBe("unknown");
    expect(report.status).toBe("incomplete");
  });
  it("keeps doctor evidence when Express is down and detects mixed versions", async () => {
    const base = await inspectControllerFiles(fixture());
    const mixed = addControllerConnectivity(base, { web: { product: "BoxPilot", status: "ok", version: "1.2.3" }, helper: { version: "1.2.2" } });
    expect(mixed.status).toBe("needs-attention");
    const offline = addControllerConnectivity(base, { helper: { version: "1.2.3" }, webError: "Express is down" });
    expect(offline.status).toBe("incomplete");
    expect(offline.checks.find((item) => item.id === "web-response").detail).toBe("Express is down");
    expect(offline.installedVersion).toBe("1.2.3");
  });
});
