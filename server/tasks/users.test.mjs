import { describe, expect, it, vi } from "vitest";
import { sshPasswordAuthSet, userAdd, userKeysImport, userSudoSet, validKeyLines } from "./users.mjs";

const ED_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKk3Fake0000000000000000000000000000000000 laptop";
const RSA_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCfake+key/lines== work";

function fakeFiles(contents = {}) {
  const written = {};
  const removed = [];
  return {
    written,
    removed,
    readFile: vi.fn(async (path) => {
      if (path in written) return written[path];
      if (path in contents) return contents[path];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    writeFile: vi.fn(async (path, content) => { written[path] = content; }),
    unlink: vi.fn(async (path) => { removed.push(path); delete written[path]; }),
  };
}

/** run() fake with a small user database; records every invocation. */
function fakeRun({ users = {}, sudoMembers = [], failSshdTest = false } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary === "/usr/bin/getent" && args[0] === "passwd") {
      const entry = users[args[1]];
      return entry ? { ok: true, stdout: `${args[1]}:x:${entry.uid}:${entry.uid}::${entry.home}:/bin/bash`, stderr: "" } : { ok: false, code: 2, stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/getent" && args[0] === "group") return { ok: true, stdout: `sudo:x:27:${sudoMembers.join(",")}`, stderr: "" };
    if (binary === "/usr/sbin/useradd") { users[args.at(-1)] = { uid: 1001, home: `/home/${args.at(-1)}` }; return { ok: true, stdout: "", stderr: "" }; }
    if (binary === "/usr/sbin/sshd" && args[0] === "-t") return failSshdTest ? { ok: false, stdout: "", stderr: "Bad configuration option" } : { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}

describe("root user and SSH tasks", () => {
  it("filters key text down to valid public key lines", () => {
    expect(validKeyLines(`${ED_KEY}\n\n# comment\ngarbage\n${RSA_KEY}\n`)).toEqual([ED_KEY, RSA_KEY]);
    expect(validKeyLines("ssh-ed25519 not*base64 x")).toEqual([]);
  });

  it("creates a locked-password user and imports GitHub keys in one task", async () => {
    const users = {};
    const run = fakeRun({ users });
    const files = fakeFiles();
    const result = await userAdd({ username: "alex", githubUser: "alex-gh" }, { run, files, fetchKeys: async () => `${ED_KEY}\n` });
    expect(result).toMatchObject({ username: "alex", passwordLoginDisabled: true, importedKeys: { added: 1, total: 1 } });
    expect(run).toHaveBeenCalledWith("/usr/sbin/useradd", ["--create-home", "--shell", "/bin/bash", "alex"], expect.anything());
    expect(files.written["/home/alex/.ssh/authorized_keys"]).toContain(ED_KEY);
  });

  it("refuses to add an existing user or a malformed name", async () => {
    const run = fakeRun({ users: { alex: { uid: 1001, home: "/home/alex" } } });
    await expect(userAdd({ username: "alex" }, { run, files: fakeFiles() })).rejects.toThrow("already exists");
    await expect(userAdd({ username: "Bad Name" }, { run, files: fakeFiles() })).rejects.toThrow("Username");
  });

  it("imports pasted keys without duplicating existing ones", async () => {
    const run = fakeRun({ users: { alex: { uid: 1001, home: "/home/alex" } } });
    const files = fakeFiles({ "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n` });
    const result = await userKeysImport({ username: "alex", keys: `${ED_KEY}\n${RSA_KEY}\n` }, { run, files });
    expect(result).toMatchObject({ added: 1, total: 2, source: "pasted" });
    expect(files.written["/home/alex/.ssh/authorized_keys"]).toBe(`${ED_KEY}\n${RSA_KEY}\n`);
  });

  it("guards sudo membership changes", async () => {
    const run = fakeRun({ users: { alex: { uid: 1001, home: "/home/alex" } }, sudoMembers: ["alex"] });
    await expect(userSudoSet({ username: "alex", sudo: false }, { run })).rejects.toThrow("only sudo user");
    await expect(userSudoSet({ username: "root", sudo: false }, { run })).rejects.toThrow("root");
    const grant = fakeRun({ users: { pat: { uid: 1002, home: "/home/pat" } }, sudoMembers: ["alex"] });
    await expect(userSudoSet({ username: "pat", sudo: true }, { run: grant })).resolves.toEqual({ username: "pat", sudo: true, changed: true });
    expect(grant).toHaveBeenCalledWith("/usr/sbin/usermod", ["-aG", "sudo", "pat"], expect.anything());
  });

  it("refuses to disable SSH password login when nobody has a key", async () => {
    const run = fakeRun();
    const files = fakeFiles({ "/etc/passwd": "root:x:0:0::/root:/bin/bash\nalex:x:1001:1001::/home/alex:/bin/bash\n" });
    await expect(sshPasswordAuthSet({ enabled: false }, { run, files })).rejects.toThrow("No user has an SSH key");
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).toBeUndefined();
  });

  it("disables password login through a validated drop-in and reloads ssh", async () => {
    const run = fakeRun();
    const files = fakeFiles({
      "/etc/passwd": "root:x:0:0::/root:/bin/bash\nalex:x:1001:1001::/home/alex:/bin/bash\n",
      "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n`,
    });
    await expect(sshPasswordAuthSet({ enabled: false }, { run, files })).resolves.toMatchObject({ passwordAuthentication: false });
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).toContain("PasswordAuthentication no");
    expect(run).toHaveBeenCalledWith("/usr/sbin/sshd", ["-t"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["reload-or-restart", "ssh.service"], expect.anything());
  });

  it("rolls the drop-in back when sshd rejects the configuration", async () => {
    const run = fakeRun({ failSshdTest: true });
    const files = fakeFiles({
      "/etc/passwd": "alex:x:1001:1001::/home/alex:/bin/bash\n",
      "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n`,
    });
    await expect(sshPasswordAuthSet({ enabled: false }, { run, files })).rejects.toThrow("nothing was changed");
    expect(files.removed).toContain("/etc/ssh/sshd_config.d/00-boxpilot.conf");
    expect(run).not.toHaveBeenCalledWith("/usr/bin/systemctl", ["reload-or-restart", "ssh.service"], expect.anything());
  });
});
