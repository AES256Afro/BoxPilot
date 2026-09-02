import { constants as fsConstants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sshPasswordAuthSet, userAdd, userKeysImport, userSudoSet, validKeyLines } from "./users.mjs";

const ED_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKk3Fake0000000000000000000000000000000000 laptop";
const RSA_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCfake+key/lines== work";

function fakeFiles(contents = {}, { links = {}, owners = {}, directories = new Set() } = {}) {
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
    // Everything under a home is a plain file or directory owned by that user unless a test says
    // otherwise via `links` (path -> true) or `owners` (path -> uid).
    lstat: vi.fn(async (path) => {
      if (links[path]) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, uid: owners[path] ?? 1001 };
      if (!(path in written) && !(path in contents) && !directories.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const directory = directories.has(path);
      return { isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory, uid: owners[path] ?? 1001 };
    }),
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

describe("turning password logins off", () => {
  // One account with a real key in its authorized_keys, which is what makes the "no user has a
  // key" guard pass and the effective-configuration guard the one under test.
  const files = {
    readFile: async (target) => (target === "/etc/passwd" ? "owner:x:1000:1000::/home/owner:/bin/bash\n" : `${ED_KEY}\n`),
    writeFile: async () => {},
    unlink: async () => {},
  };
  const withKeys = (stdout) => vi.fn(async () => ({ ok: true, stdout, stderr: "" }));

  it("refuses when sshd would not accept a key either", async () => {
    // The account has a key, but the effective configuration ignores keys: turning passwords off
    // here removes the last way in over SSH.
    await expect(sshPasswordAuthSet({ enabled: false }, { run: withKeys("pubkeyauthentication no\npasswordauthentication yes\n"), files }))
      .rejects.toThrow(/key logins turned off/i);
  });

  it("refuses when the effective configuration cannot be read at all", async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: "", stderr: "sshd: no hostkeys available" }));
    await expect(sshPasswordAuthSet({ enabled: false }, { run, files })).rejects.toThrow(/Nothing was changed/);
  });
});


describe("importing keys into a home the user controls", () => {
  const users = { mallory: { uid: 1001, home: "/home/mallory" } };

  it("refuses when authorized_keys is a symbolic link, whatever it points at", async () => {
    // ~/.ssh/authorized_keys -> /etc/passwd: root would read /etc/passwd, write it back with the
    // keys appended, and chown it to mallory, who then gives themself uid 0.
    const run = fakeRun({ users });
    const files = fakeFiles({}, { links: { "/home/mallory/.ssh/authorized_keys": true }, directories: new Set(["/home/mallory/.ssh"]) });
    await expect(userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files })).rejects.toThrow(/symbolic link; refusing/);
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("refuses when .ssh itself is a symbolic link", async () => {
    // ~/.ssh -> /etc would have had install -d chown /etc to the user.
    const run = fakeRun({ users });
    const files = fakeFiles({}, { links: { "/home/mallory/.ssh": true } });
    await expect(userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files })).rejects.toThrow(/symbolic link; refusing/);
    expect(run).not.toHaveBeenCalledWith("/usr/bin/install", expect.anything(), expect.anything());
  });

  it("refuses a file the user does not own", async () => {
    const run = fakeRun({ users });
    const files = fakeFiles({ "/home/mallory/.ssh/authorized_keys": "" }, { owners: { "/home/mallory/.ssh/authorized_keys": 0 }, directories: new Set(["/home/mallory/.ssh"]) });
    await expect(userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files })).rejects.toThrow(/owned by uid 0/);
  });

  it("still imports into a plain, user-owned file, without following links at write time", async () => {
    const run = fakeRun({ users });
    const files = fakeFiles({ "/home/mallory/.ssh/authorized_keys": "" }, { directories: new Set(["/home/mallory/.ssh"]) });
    await userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files });
    const [, , options] = files.writeFile.mock.calls[0];
    expect(options.flag & fsConstants.O_NOFOLLOW).toBeTruthy();
    expect(run).toHaveBeenCalledWith("/usr/bin/chown", ["-h", "1001:1001", "/home/mallory/.ssh/authorized_keys"], expect.anything());
  });
});
