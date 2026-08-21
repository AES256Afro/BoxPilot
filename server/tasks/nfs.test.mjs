import { describe, expect, it, vi } from "vitest";
import { nfsApply, parseExports, renderExports, validateNfsConfig } from "./nfs.mjs";

function fakeRun({ exportfsFails = false } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("exportfs") && args[0] === "-ra") return exportfsFails ? { ok: false, stdout: "", stderr: "exportfs: /srv/x does not exist" } : { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("exportfs")) return { ok: true, stdout: "/srv/media   100.64.0.0/10(rw,sync,all_squash)\n", stderr: "" };
    if (binary.endsWith("/ip")) return { ok: true, stdout: JSON.stringify([{ dst: "default", gateway: "192.168.1.1", dev: "eno1" }, { dst: "192.168.1.0/24", dev: "eno1", scope: "link" }, { dst: "172.17.0.0/16", dev: "docker0", scope: "link" }, { dst: "100.64.0.5", dev: "tailscale0", scope: "link" }]), stderr: "" };
    if (binary.endsWith("/ss")) return { ok: true, stdout: "LISTEN 0 64 0.0.0.0:2049 0.0.0.0:*\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}
function fakeFiles({ existing = null, ownerUid = 1000 } = {}) {
  const state = { exports: existing, written: {} };
  return {
    state,
    readFile: vi.fn(async () => { if (state.exports === null) throw new Error("ENOENT"); return state.exports; }),
    writeFile: vi.fn(async (path, content) => { state.written[path] = content; if (path === "/etc/exports.d/boxpilot.exports") state.exports = content; }),
    rename: vi.fn(async (from, to) => { state.written[to] = state.written[from]; if (to === "/etc/exports.d/boxpilot.exports") state.exports = state.written[to]; }),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isDirectory: () => true, uid: ownerUid, gid: ownerUid })),
    access: vi.fn(async () => {}),
  };
}

describe("nfs tasks", () => {
  it("validates and renders exports squashed to the folder owner", () => {
    expect(validateNfsConfig({ exports: [{ path: "/srv/media", readOnly: true }] })).toBeNull();
    expect(validateNfsConfig({ scope: "world" })).toContain("scope");
    expect(validateNfsConfig({ exports: [{ path: "/etc" }] })).toContain("system locations");
    expect(validateNfsConfig({ exports: [{ path: "/srv/a" }, { path: "/srv/a/" }] })).toContain("twice");
    const text = renderExports({ scope: "lan", lanSubnets: ["192.168.1.0/24"], exports: [{ path: "/srv/media/", readOnly: true }, { path: "/srv/shared" }], owners: { "/srv/media": { uid: 1000, gid: 1000 } } });
    expect(text).toContain('"/srv/media" 100.64.0.0/10(ro,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000) 192.168.1.0/24(ro,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)');
    expect(text).toContain('"/srv/shared" 100.64.0.0/10(rw,sync,no_subtree_check,all_squash,anonuid=65534,anongid=65534) 192.168.1.0/24(rw,');
    const parsed = parseExports(text);
    expect(parsed.managed).toBe(true);
    expect(parsed.exports).toEqual([
      { path: "/srv/media", readOnly: true, clients: ["100.64.0.0/10", "192.168.1.0/24"] },
      { path: "/srv/shared", readOnly: false, clients: ["100.64.0.0/10", "192.168.1.0/24"] },
    ]);
    expect(parseExports("/export *(rw)\n")).toEqual({ managed: false, exports: [{ path: "/export", readOnly: false, clients: ["*"] }] });
  });

  it("applies exports: writes nfs.conf.d, re-exports, starts the server, and verifies listening", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    const result = await nfsApply({ scope: "lan", exports: [{ path: "/srv/media", readOnly: true }] }, { run, files });
    expect(result).toMatchObject({ applied: true, scope: "lan", exports: ["/srv/media"], clients: ["100.64.0.0/10", "192.168.1.0/24"], listening: ["0.0.0.0:2049"] });
    expect(files.state.written["/etc/nfs.conf.d/boxpilot.conf"]).toContain("[nfsd]\nvers3=n\nvers4=y");
    expect(files.state.exports).toContain('"/srv/media" 100.64.0.0/10(ro,');
    const calls = run.mock.calls.map(([binary, args]) => `${binary.split("/").at(-1)} ${args.join(" ")}`);
    expect(calls).toContain("systemctl enable --now nfs-server");
    expect(calls).toContain("exportfs -ra");
    const tailnetOnly = await nfsApply({ scope: "tailscale", exports: [{ path: "/srv/x" }] }, { run: fakeRun(), files: fakeFiles() });
    expect(tailnetOnly.clients).toEqual(["100.64.0.0/10"]);
  });

  it("restores the previous exports when exportfs rejects them, and refuses without the server", async () => {
    const files = fakeFiles({ existing: "# Managed by BoxPilot\n\"/srv/old\" 100.64.0.0/10(rw)\n" });
    await expect(nfsApply({ exports: [{ path: "/srv/x" }] }, { run: fakeRun({ exportfsFails: true }), files })).rejects.toThrow("restored the previous file");
    expect(files.state.exports).toContain("/srv/old");
    const missing = fakeFiles();
    missing.access = vi.fn(async () => { throw new Error("ENOENT"); });
    await expect(nfsApply({ exports: [] }, { run: fakeRun(), files: missing })).rejects.toThrow("not installed");
  });
});
