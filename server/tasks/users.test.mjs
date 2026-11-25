import { describe, expect, it, vi } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { accessFacts, authorizedKeyPaths, keyAdmins, keyOnlyRefusal, lockedAccounts, parseEffectiveSshd, readSudoers, sshPasswordAuthSet, userAdd, userKeysImport, userLock, userRemove, userSudoSet, userUnlock, validKeyLines } from "./users.mjs";

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
function fakeRun({ users = {}, sudoMembers = [], failSshdTest = false, keyFiles = {}, asUser = [] } = {}) {
  const run = vi.fn(async (binary, args, options) => {
    if (binary === "/usr/bin/getent" && args[0] === "passwd") {
      const entry = users[args[1]];
      return entry ? { ok: true, stdout: `${args[1]}:x:${entry.uid}:${entry.uid}::${entry.home}:/bin/bash`, stderr: "" } : { ok: false, code: 2, stdout: "", stderr: "" };
    }
    if (binary === "/usr/bin/getent" && args[0] === "group") return { ok: true, stdout: `sudo:x:27:${sudoMembers.join(",")}`, stderr: "" };
    if (binary === "/usr/sbin/useradd") { users[args.at(-1)] = { uid: 1001, home: `/home/${args.at(-1)}` }; return { ok: true, stdout: "", stderr: "" }; }
    if (binary === "/usr/sbin/runuser") {
      // runuser -u <user> -- /bin/sh -c <script> sh <home>: the key work now happens as the user.
      const user = args[1]; const script = args[5]; const home = args[7];   // -u <user> -- /bin/sh -c <script> sh <home>
      asUser.push({ user, script, home, input: options?.input ?? null });
      const file = `${home}/.ssh/authorized_keys`;
      if (script.includes("cat >>")) { keyFiles[file] = `${keyFiles[file] ?? ""}${options?.input ?? ""}`; return { ok: true, stdout: "", stderr: "" }; }
      return { ok: true, stdout: keyFiles[file] ?? "", stderr: "" };
    }
    if (binary === "/usr/sbin/sshd" && args[0] === "-t") return failSshdTest ? { ok: false, stdout: "", stderr: "Bad configuration option" } : { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  run.asUser = asUser; run.keyFiles = keyFiles;
  return run;
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
    // Written as alex, by alex: the file lives in the user-side fake, and root never wrote a byte.
    expect(run.keyFiles["/home/alex/.ssh/authorized_keys"]).toContain(ED_KEY);
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to add an existing user or a malformed name", async () => {
    const run = fakeRun({ users: { alex: { uid: 1001, home: "/home/alex" } } });
    await expect(userAdd({ username: "alex" }, { run, files: fakeFiles() })).rejects.toThrow("already exists");
    await expect(userAdd({ username: "Bad Name" }, { run, files: fakeFiles() })).rejects.toThrow("Username");
  });

  it("imports pasted keys without duplicating existing ones", async () => {
    const run = fakeRun({ users: { alex: { uid: 1001, home: "/home/alex" } }, keyFiles: { "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n` } });
    const result = await userKeysImport({ username: "alex", keys: `${ED_KEY}\n${RSA_KEY}\n` }, { run, files: fakeFiles() });
    expect(result).toMatchObject({ added: 1, total: 2, source: "pasted" });
    expect(run.keyFiles["/home/alex/.ssh/authorized_keys"]).toBe(`${ED_KEY}\n${RSA_KEY}\n`);
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
    const files = fakeFiles({ "/etc/passwd": "root:x:0:0::/root:/bin/bash\nalex:x:1001:1001::/home/alex:/bin/bash\n", "/etc/group": "sudo:x:27:alex\n", "/etc/shadow": "alex:$6$hash:20000:0:99999:7:::\n" });
    await expect(sshPasswordAuthSet({ enabled: false }, { run, files })).rejects.toThrow("No user has an SSH key");
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).toBeUndefined();
  });

  // Linux only: expects POSIX paths.
  it.skipIf(onWindows)("disables password login through a validated drop-in and reloads ssh", async () => {
    const run = fakeRun();
    const files = fakeFiles({
      "/etc/passwd": "root:x:0:0::/root:/bin/bash\nalex:x:1001:1001::/home/alex:/bin/bash\n",
      "/etc/group": "sudo:x:27:alex\n",
      "/etc/shadow": "alex:$6$hash:20000:0:99999:7:::\n",
      "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n`,
    });
    await expect(sshPasswordAuthSet({ enabled: false }, { run, files })).resolves.toMatchObject({ passwordAuthentication: false, keyboardInteractive: false });
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).toContain("PasswordAuthentication no\nKbdInteractiveAuthentication no\n");
    expect(run).toHaveBeenCalledWith("/usr/sbin/sshd", ["-t"], expect.anything());
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["reload-or-restart", "ssh.service"], expect.anything());
  });

  // Linux only: expects POSIX paths.
  it.skipIf(onWindows)("rolls the drop-in back when sshd rejects the configuration", async () => {
    const run = fakeRun({ failSshdTest: true });
    const files = fakeFiles({
      "/etc/passwd": "alex:x:1001:1001::/home/alex:/bin/bash\n",
      "/etc/group": "sudo:x:27:alex\n",
      "/etc/shadow": "alex:$6$hash:20000:0:99999:7:::\n",
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
    readFile: async (target) => (target === "/etc/passwd" ? "owner:x:1000:1000::/home/owner:/bin/bash\n" : target === "/etc/group" ? "sudo:x:27:owner\n" : target === "/etc/shadow" ? "" : `${ED_KEY}\n`),
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

  it("does the whole thing as the user, so a symlink can only lead where they could already write", async () => {
    // Root never opens a path under the user's home: a planted ~/.ssh -> /root/.ssh or
    // authorized_keys -> /etc/passwd is now the user's own problem and nobody else's.
    const run = fakeRun({ users });
    const files = fakeFiles();
    await userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files });
    expect(files.readFile).not.toHaveBeenCalledWith(expect.stringContaining("/home/mallory"), expect.anything());
    expect(files.writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalledWith("/usr/bin/chown", expect.anything(), expect.anything());
    expect(run).not.toHaveBeenCalledWith("/usr/bin/install", expect.anything(), expect.anything());
    expect(run.asUser.every((call) => call.user === "mallory" && call.home === "/home/mallory")).toBe(true);
  });

  it("hands the keys over on stdin and appends only what is new", async () => {
    const run = fakeRun({ users, keyFiles: { "/home/mallory/.ssh/authorized_keys": `${ED_KEY}\n` } });
    const result = await userKeysImport({ username: "mallory", keys: `${ED_KEY}\n${RSA_KEY}\n` }, { run, files: fakeFiles() });
    expect(result).toMatchObject({ added: 1, total: 2 });
    const append = run.asUser.find((call) => call.script.includes("cat >>"));
    expect(append.input).toBe(`${RSA_KEY}\n`);
    expect(append.script).toContain("chmod 700");
    expect(append.script).toContain("chmod 600");
    expect(run.keyFiles["/home/mallory/.ssh/authorized_keys"]).toBe(`${ED_KEY}\n${RSA_KEY}\n`);
  });

  it("writes nothing when every key is already present", async () => {
    const run = fakeRun({ users, keyFiles: { "/home/mallory/.ssh/authorized_keys": `${ED_KEY}\n` } });
    await userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files: fakeFiles() });
    expect(run.asUser.some((call) => call.script.includes("cat >>"))).toBe(false);
  });

  it("takes the home from passwd, never from the environment", async () => {
    // runuser without -l keeps root's environment, so $HOME would be /root.
    const run = fakeRun({ users });
    await userKeysImport({ username: "mallory", keys: ED_KEY }, { run, files: fakeFiles() });
    for (const call of run.asUser) { expect(call.home).toBe("/home/mallory"); expect(call.script).not.toContain("$HOME"); }
  });
});

// M90 (audit s1-06 Function #3): with KbdInteractiveAuthentication on, PAM still takes the password,
// and the guard counted keys that sign nobody in who could turn passwords back on.
describe("key-only login that is key-only", () => {
  const passwd = [
    "root:x:0:0::/root:/bin/bash",
    "alex:x:1000:1000::/home/alex:/bin/bash",
    "pat:x:1001:1001::/home/pat:/bin/bash",
  ].join("\n");
  /** sshd -T before and after the reload, from the given lines; everything else succeeds. */
  const sshdSaying = (before, after = "passwordauthentication no\nkbdinteractiveauthentication no\n") => {
    let reads = 0;
    return vi.fn(async (binary, args) => {
      if (binary === "/usr/sbin/sshd" && args[0] === "-T") { reads += 1; return { ok: true, stdout: reads === 1 ? before : after, stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    });
  };

  const shadow = "root:*:20000:0:99999:7:::\nalex:$6$hash:20000:0:99999:7:::\npat:$6$hash:20000:0:99999:7:::\n";
  it("counts only keys on administrators sshd admits, and not on a locked one", () => {
    const account = (name, extra) => ({ name, uid: 0, home: "/", groups: [], sudo: true, canSudo: true, nopasswd: false, passwordUsable: true, passwordLocked: false, locked: false, keyCount: 1, rootEquivalent: true, ...extra });
    const accounts = [account("root"), account("alex", { keyCount: 0 }), account("pat", { sudo: false, canSudo: false, keyCount: 2 })];
    expect(keyAdmins({ accounts, sshd: parseEffectiveSshd("permitrootlogin no") })).toEqual([]);
    expect(keyAdmins({ accounts, sshd: parseEffectiveSshd("permitrootlogin forced-commands-only") })).toEqual([]);
    expect(keyAdmins({ accounts, sshd: parseEffectiveSshd("permitrootlogin without-password") })).toEqual(["root"]);
    expect(keyAdmins({ accounts: [account("alex", { locked: true })], sshd: parseEffectiveSshd("permitrootlogin no") })).toEqual([]);
    expect(lockedAccounts("alex:!:20000:0:99999:7::1:\npat:!:20000:0:99999:7:::\nsam:$6$x:20000:0:99999:7::30000:\n", 20400)).toEqual(new Set(["alex"]));
  });

  it("refuses to turn passwords off when only root (PermitRootLogin no) and a non-admin have keys", async () => {
    const files = fakeFiles({ "/etc/passwd": passwd, "/etc/group": "sudo:x:27:alex\n", "/etc/shadow": shadow, "/root/.ssh/authorized_keys": `${ED_KEY}\n`, "/home/pat/.ssh/authorized_keys": `${RSA_KEY}\n` });
    await expect(sshPasswordAuthSet({ enabled: false }, { run: sshdSaying("permitrootlogin no\npubkeyauthentication yes\n"), files })).rejects.toThrow("No administrator could sign in with a key and use sudo afterwards. root: PermitRootLogin no keeps root out; alex: it has no key in .ssh/authorized_keys .ssh/authorized_keys2 (where sshd reads keys); pat: it is not an administrator.");
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).toBeUndefined();
    // The same keys with root admitted by key: root is a way in.
    const admitted = fakeFiles({ "/etc/passwd": passwd, "/etc/group": "sudo:x:27:alex\n", "/etc/shadow": shadow, "/root/.ssh/authorized_keys": `${ED_KEY}\n` });
    await expect(sshPasswordAuthSet({ enabled: false }, { run: sshdSaying("permitrootlogin prohibit-password\n"), files: admitted })).resolves.toMatchObject({ passwordAuthentication: false });
  });

  it("refuses when the only administrator with a key is locked", async () => {
    const files = fakeFiles({ "/etc/passwd": passwd, "/etc/group": "sudo:x:27:alex\n", "/etc/shadow": "alex:!:20000:0:99999:7::1:\n", "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n` });
    await expect(sshPasswordAuthSet({ enabled: false }, { run: sshdSaying("permitrootlogin no\n"), files, now: 20400 * 86_400_000 })).rejects.toThrow("No administrator could sign in");
  });

  it("turns keyboard-interactive off with passwords, and gives it back to sshd's own setting when they are on again", async () => {
    const files = fakeFiles({ "/etc/passwd": passwd, "/etc/group": "sudo:x:27:alex\n", "/etc/shadow": shadow, "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n` });
    await sshPasswordAuthSet({ enabled: false }, { run: sshdSaying("permitrootlogin no\nkbdinteractiveauthentication yes\n"), files });
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).toMatch(/^PasswordAuthentication no\nKbdInteractiveAuthentication no\n$/m);
    await expect(sshPasswordAuthSet({ enabled: true }, { run: sshdSaying("passwordauthentication yes\nkbdinteractiveauthentication yes\n"), files })).resolves.toEqual({ passwordAuthentication: true, keyboardInteractive: true, dropIn: "/etc/ssh/sshd_config.d/00-boxpilot.conf" });
    expect(files.written["/etc/ssh/sshd_config.d/00-boxpilot.conf"]).not.toContain("KbdInteractive");
  });

  it("does not report key-only login when sshd still takes passwords after the reload", async () => {
    const files = fakeFiles({ "/etc/passwd": passwd, "/etc/group": "sudo:x:27:alex\n", "/etc/shadow": shadow, "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n` });
    await expect(sshPasswordAuthSet({ enabled: false }, { run: sshdSaying("permitrootlogin no\n", "passwordauthentication no\nkbdinteractiveauthentication yes\n"), files }))
      .rejects.toThrow("sshd still takes passwords (KbdInteractiveAuthentication yes)");
  });
});

// M90 (audit s1-06 Function #7): an account could be added, never locked or removed.
describe("locking and removing an account", () => {
  const today = 20400;
  const now = today * 86_400_000;
  const passwd = "root:x:0:0::/root:/bin/bash\nalex:x:1000:1000::/home/alex:/bin/bash\nsam:x:1001:1001::/home/sam:/bin/bash\nshared:x:1003:1003::/srv/shared:/bin/bash\n";
  const users = { root: { uid: 0, home: "/root" }, alex: { uid: 1000, home: "/home/alex" }, sam: { uid: 1001, home: "/home/sam" }, shared: { uid: 1003, home: "/srv/shared" }, www: { uid: 33, home: "/var/www" }, boxpilot: { uid: 998, home: "/var/lib/boxpilot" }, carer: { uid: 1004, home: "/home/carer" } };

  /** A user database usermod and userdel change, with /etc/shadow read through files. */
  function system({ sudoMembers = ["alex"], shadow = { alex: { password: "$6$hash", expire: "" }, sam: { password: "!", expire: "" } }, userdel = null, serviceUser = "carer", sshdT = "passwordauthentication yes\nusepam yes\n", extraFiles = {} } = {}) {
    const db = structuredClone(users);
    const homes = new Set(Object.values(db).map((entry) => entry.home));
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/bin/getent" && args[0] === "passwd") { const entry = db[args[1]]; return entry ? { ok: true, stdout: `${args[1]}:x:${entry.uid}:${entry.uid}::${entry.home}:/bin/bash`, stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
      if (binary === "/usr/bin/getent" && args[0] === "group") return { ok: true, stdout: `sudo:x:27:${sudoMembers.join(",")}\n`, stderr: "" };
      if (binary === "/usr/bin/systemctl" && args[0] === "show") return { ok: true, stdout: `${serviceUser}\n`, stderr: "" };
      if (binary === "/usr/sbin/sshd" && args[0] === "-T") return sshdT === null ? { ok: false, stdout: "", stderr: "sshd: no hostkeys" } : { ok: true, stdout: sshdT, stderr: "" };
      if (binary === "/usr/sbin/usermod") {
        const name = args.at(-1); const entry = shadow[name] ?? (shadow[name] = { password: "!", expire: "" });
        if (args.includes("--lock") && !entry.password.startsWith("!")) entry.password = `!${entry.password}`;
        if (args.includes("--unlock")) entry.password = entry.password.slice(1);
        const at = args.indexOf("--expiredate"); if (at >= 0) entry.expire = args[at + 1];
        return { ok: true, stdout: "", stderr: "" };
      }
      if (binary === "/usr/sbin/userdel") {
        if (userdel) return userdel(args, db, homes);
        const name = args.at(-1); if (args.includes("--remove")) homes.delete(db[name].home); delete db[name];
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const files = {
      readFile: vi.fn(async (file) => (file === "/etc/shadow" ? Object.entries(shadow).map(([name, entry]) => `${name}:${entry.password}:20000:0:99999:7::${entry.expire}:`).join("\n") : file === "/etc/passwd" ? passwd : file === "/etc/group" ? `sudo:x:27:${sudoMembers.join(",")}\n` : file in extraFiles ? extraFiles[file] : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })))),
      access: vi.fn(async (target) => { if (!homes.has(target)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
    };
    return { run, files, db, shadow, homes };
  }

  it("locks an account so neither a password nor a key signs it in, and unlocks it as it was", async () => {
    // sam signs in with a key and sudoes without a password, so alex is not the last administrator.
    const box = system({ sudoMembers: ["alex", "sam"], extraFiles: { "/home/sam/.ssh/authorized_keys": `${ED_KEY}\n`, "/etc/sudoers": "%sudo ALL=(ALL:ALL) ALL\nsam ALL=(ALL) NOPASSWD: ALL\n" } });
    await expect(userLock({ username: "sam" }, { ...box, now })).resolves.toMatchObject({ username: "sam", locked: true, changed: true });
    expect(box.run).toHaveBeenCalledWith("/usr/sbin/usermod", ["--lock", "--expiredate", "1", "sam"], expect.anything());
    expect(box.shadow.sam).toEqual({ password: "!", expire: "1" });
    await expect(userLock({ username: "sam" }, { ...box, now })).resolves.toMatchObject({ changed: false });
    // sam never had a password: unlocking clears the expiry and leaves the password locked, not empty.
    await expect(userUnlock({ username: "sam" }, { ...box, now })).resolves.toEqual({ username: "sam", locked: false, passwordUnlocked: false });
    expect(box.shadow.sam).toEqual({ password: "!", expire: "" });
    await userLock({ username: "alex" }, { ...box, now });
    expect(box.shadow.alex.password).toBe("!$6$hash");
    await expect(userUnlock({ username: "alex" }, { ...box, now })).resolves.toMatchObject({ passwordUnlocked: true });
    expect(box.shadow.alex).toEqual({ password: "$6$hash", expire: "" });
  });

  it("refuses root, system accounts, the account BoxPilot runs as, and the last administrator", async () => {
    const box = system();
    await expect(userLock({ username: "root" }, { ...box, now })).rejects.toThrow("root cannot be locked");
    await expect(userRemove({ username: "www" }, { ...box, now })).rejects.toThrow("system account (uid 33)");
    await expect(userRemove({ username: "boxpilot" }, { ...box, now })).rejects.toThrow("an account BoxPilot runs as");
    await expect(userLock({ username: "carer" }, { ...box, now })).rejects.toThrow("an account BoxPilot runs as");
    await expect(userLock({ username: "alex" }, { ...box, now })).rejects.toThrow("alex is the last administrator who can sign in");
    await expect(userRemove({ username: "alex" }, { ...box, now })).rejects.toThrow("last administrator");
    // Another administrator who is locked does not count.
    const lockedOther = system({ sudoMembers: ["alex", "sam"], shadow: { alex: { password: "$6$hash", expire: "" }, sam: { password: "!", expire: "1" } } });
    await expect(userRemove({ username: "alex" }, { ...lockedOther, now })).rejects.toThrow("last administrator");
    await expect(userLock({ username: "Bad Name" }, { ...box, now })).rejects.toThrow("Username must be");
    for (const refused of [box, lockedOther]) expect(refused.run).not.toHaveBeenCalledWith("/usr/sbin/usermod", expect.anything(), expect.anything());
    expect(box.run).not.toHaveBeenCalledWith("/usr/sbin/userdel", expect.anything(), expect.anything());
  });

  it("removes an account and keeps its home unless asked, and then only a home of its own under /home", async () => {
    const box = system();
    await expect(userRemove({ username: "sam" }, { ...box, now })).resolves.toEqual({ username: "sam", removed: true, home: "/home/sam", homeRemoved: false });
    expect(box.run).toHaveBeenCalledWith("/usr/sbin/userdel", ["sam"], expect.anything());
    expect(box.homes.has("/home/sam")).toBe(true);
    const withHome = system();
    await expect(userRemove({ username: "sam", removeHome: true }, { ...withHome, now })).resolves.toMatchObject({ removed: true, homeRemoved: true });
    expect(withHome.run).toHaveBeenCalledWith("/usr/sbin/userdel", ["--remove", "sam"], expect.anything());
    await expect(userRemove({ username: "shared", removeHome: true }, { ...system(), now })).rejects.toThrow("not a folder of its own under /home");
  });

  it("says what userdel did when it fails, or leaves the home behind", async () => {
    const busy = system({ userdel: () => ({ ok: false, stdout: "", stderr: "userdel: user sam is currently used by process 4242" }) });
    await expect(userRemove({ username: "sam" }, { ...busy, now })).rejects.toThrow("sam could not be removed: userdel: user sam is currently used by process 4242. Nothing was changed.");
    const homeStuck = system({ userdel: (args, db) => { delete db[args.at(-1)]; return { ok: false, stdout: "", stderr: "userdel: error removing directory /home/sam" }; } });
    await expect(userRemove({ username: "sam", removeHome: true }, { ...homeStuck, now })).resolves.toMatchObject({ removed: true, homeRemoved: false, warnings: [expect.stringContaining("/home/sam is still there (userdel: error removing directory /home/sam)")] });
  });
});

// M90 outside review: turning passwords off must leave someone who can sign in with a key sshd
// accepts *and* use sudo afterwards, judged the way sshd and sudo judge it.
describe("the key-only guard reads sshd and sudo as they decide", () => {
  const passwd = "root:x:0:0::/root:/bin/bash\nalex:x:1000:1000::/home/alex:/bin/bash\nsam:x:1001:1001::/home/sam:/bin/bash\n";
  const group = "sudo:x:27:alex\nops:x:1500:alex\n";
  const base = { "/etc/passwd": passwd, "/etc/group": group, "/etc/shadow": "root:*:20000:0:99999:7:::\nalex:$6$hash:20000:0:99999:7:::\nsam:!:20000:0:99999:7:::\n", "/home/alex/.ssh/authorized_keys": `${ED_KEY}\n` };
  const box = (extra = {}, directories = {}) => {
    const files = fakeFiles({ ...base, ...extra });
    return Object.assign(files, { readdir: vi.fn(async (dir) => { if (dir in directories) return directories[dir]; throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }) });
  };
  const sshd = (lines) => vi.fn(async (binary, args) => (binary === "/usr/sbin/sshd" && args[0] === "-T"
    ? { ok: true, stdout: `${lines}\npasswordauthentication no\nkbdinteractiveauthentication no\n`, stderr: "" }
    : { ok: true, stdout: "", stderr: "" }));
  const turnOff = (lines, files) => sshPasswordAuthSet({ enabled: false }, { run: sshd(lines), files });
  const dropIn = "/etc/ssh/sshd_config.d/00-boxpilot.conf";

  it("goes ahead for an administrator with a key and a password, the shape every refusal below breaks", async () => {
    const files = box();
    await expect(turnOff("usepam yes\nauthenticationmethods any", files)).resolves.toMatchObject({ passwordAuthentication: false });
    expect(files.written[dropIn]).toContain("PasswordAuthentication no");
  });

  // 1a: KbdInteractiveAuthentication no makes a key-plus-code requirement impossible to meet.
  it("refuses while AuthenticationMethods asks for more than a key", async () => {
    for (const methods of ["publickey,keyboard-interactive", "publickey,keyboard-interactive:pam", "publickey,password", "publickey publickey,password", "password"]) {
      const files = box();
      await expect(turnOff(`usepam yes\nauthenticationmethods ${methods}`, files), methods).rejects.toThrow(`asks for more than a key to sign in (AuthenticationMethods ${methods})`);
      expect(files.written[dropIn], methods).toBeUndefined();
    }
    await expect(turnOff("usepam yes\nauthenticationmethods publickey", box())).resolves.toMatchObject({ passwordAuthentication: false });
  });

  // 1b: AllowUsers, DenyUsers, AllowGroups and DenyGroups, Deny first; a host part never counts as allowing.
  it("counts only administrators AllowUsers, DenyUsers, AllowGroups and DenyGroups let in", async () => {
    const refused = {
      "allowusers sam": "AllowUsers", "allowusers alex@192.0.2.0/24": "AllowUsers", "denyusers al*": "DenyUsers",
      "allowusers alex\ndenyusers alex@192.0.2.1": "DenyUsers", "denygroups ops": "DenyGroups", "allowgroups wheel": "AllowGroups",
    };
    for (const [lines, directive] of Object.entries(refused)) {
      const files = box();
      await expect(turnOff(`usepam yes\n${lines}`, files), lines).rejects.toThrow(`alex: ${directive} in the SSH configuration keeps it out`);
      expect(files.written[dropIn], lines).toBeUndefined();
    }
    for (const lines of ["allowusers sam\nallowusers alex", "allowusers a?ex", "allowgroups ops", "allowusers sam alex", "denyusers sam\ndenygroups nobody"]) {
      await expect(turnOff(`usepam yes\n${lines}`, box()), lines).resolves.toMatchObject({ passwordAuthentication: false });
    }
  });

  // 1c: keys only count from where sshd reads them.
  it("counts keys from AuthorizedKeysFile, and not from an AuthorizedKeysCommand it cannot check", async () => {
    expect(authorizedKeyPaths([".ssh/authorized_keys", "%h/.ssh/k2", "/etc/ssh/keys/%u", "/etc/ssh/uid/%U", "/x/100%%", "/etc/%t/keys", "~/.ssh/k3", "none"], { name: "alex", uid: 1000, home: "/home/alex" }))
      .toEqual(["/home/alex/.ssh/authorized_keys", "/home/alex/.ssh/k2", "/etc/ssh/keys/alex", "/etc/ssh/uid/1000", "/x/100%"]);
    await expect(turnOff("usepam yes\nauthorizedkeysfile /etc/ssh/keys/%u", box())).rejects.toThrow("No user has an SSH key in /etc/ssh/keys/%u (where sshd reads keys) yet.");
    await expect(turnOff("usepam yes\nauthorizedkeysfile /etc/ssh/keys/%u", box({ "/etc/ssh/keys/sam": `${RSA_KEY}\n` }))).rejects.toThrow("alex: it has no key in /etc/ssh/keys/%u (where sshd reads keys)");
    await expect(turnOff("usepam yes\nauthorizedkeysfile /etc/ssh/keys/%u", box({ "/etc/ssh/keys/alex": `${RSA_KEY}\n` }))).resolves.toMatchObject({ passwordAuthentication: false });
    await expect(turnOff("usepam yes\nauthorizedkeysfile none\nauthorizedkeyscommand /usr/local/bin/fetch-keys %u", box()))
      .rejects.toThrow("Keys that AuthorizedKeysCommand (/usr/local/bin/fetch-keys %u) hands sshd cannot be checked from here, so they are not counted.");
  });

  // 1d: a key admin with no password cannot sudo unless a NOPASSWD rule says so.
  it("requires the key administrator to be able to sudo: a password, or NOPASSWD for every command", async () => {
    const noPassword = { "/etc/shadow": "alex:!:20000:0:99999:7:::\n" };
    await expect(turnOff("usepam yes", box(noPassword))).rejects.toThrow("alex: it has no password, so sudo would ask for one it cannot give");
    await expect(turnOff("usepam yes", box({ ...noPassword, "/etc/sudoers": "%sudo ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n" }))).rejects.toThrow("it has no password");
    const grant = { ...noPassword, "/etc/sudoers": "Defaults env_reset\n%sudo ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n", "/etc/sudoers.d/90-alex": "alex ALL=(ALL) NOPASSWD:ALL\n", "/etc/sudoers.d/README": "# Files in this folder are read by sudo.\n" };
    await expect(turnOff("usepam yes", box(grant, { "/etc/sudoers.d": ["90-alex", "README"] }))).resolves.toMatchObject({ passwordAuthentication: false });
    // The same grant where sudo.d cannot be listed, is overridden later, or names only some commands: not counted.
    await expect(turnOff("usepam yes", box(grant))).rejects.toThrow("it has no password");
    await expect(turnOff("usepam yes", box({ ...grant, "/etc/sudoers.d/99-later": "%sudo ALL=(ALL) PASSWD: ALL\n" }, { "/etc/sudoers.d": ["90-alex", "99-later"] }))).rejects.toThrow("it has no password");
    await expect(turnOff("usepam yes", box({ ...grant, "/etc/sudoers.d/90-alex": "alex ALL=(ALL) NOPASSWD: /usr/bin/apt\n" }, { "/etc/sudoers.d": ["90-alex"] }))).rejects.toThrow("it has no password");
    await expect(turnOff("usepam yes", box({ ...grant, "/etc/sudoers.d/99-later": "%sudo ALL=(ALL:ALL) PASSWD: ALL, /usr/bin/true\n" }, { "/etc/sudoers.d": ["90-alex", "99-later"] }))).rejects.toThrow("it has no password");
    // Without PAM, sshd refuses an account whose password is locked even with a key and a NOPASSWD rule.
    await expect(turnOff("usepam no", box(grant, { "/etc/sudoers.d": ["90-alex"] }))).rejects.toThrow("alex: its password is locked and UsePAM is off");
    // An account that never was an administrator is not one because it has a key and a password.
    await expect(turnOff("usepam yes", box({ "/etc/group": "sudo:x:27:\n" }))).rejects.toThrow("alex: it is not an administrator");
  });

  it("reads sudoers in sudo's order and says when it could not read all of it", async () => {
    const read = async (file) => ({
      "/etc/sudoers": "root ALL=(ALL:ALL) ALL\n%sudo   ALL=(ALL:ALL) ALL # admins\n@includedir /etc/sudoers.d\n",
      "/etc/sudoers.d/10-a": "alex ALL=(ALL) NOPASSWD: ALL\n",
      "/etc/sudoers.d/20-b": "alex ALL=(root) PASSWD: ALL\n",
    })[file] ?? Promise.reject(new Error("EACCES"));
    const sudoers = await readSudoers({ read, list: async () => ["20-b", "10-a", "skip.conf", "old~"] });
    expect(sudoers).toMatchObject({ readable: true, complete: true });
    expect(sudoers.rules.map((rule) => [rule.who.join(","), rule.allCommands, rule.nopasswd])).toEqual([["root", true, false], ["%sudo", true, false], ["alex", true, true], ["alex", true, false]]);
    expect((await readSudoers({ read, list: async () => ["10-a", "15-gone"] })).complete).toBe(false);
    expect((await readSudoers({ read: async () => "User_Alias ADMINS = alex\nADMINS ALL=(ALL) NOPASSWD: ALL\n", list: async () => [] })).complete).toBe(false);
    expect(await readSudoers({ read: async () => { throw new Error("EACCES"); }, list: async () => [] })).toEqual({ readable: false, complete: false, rules: [] });
  });

  it("refuses when /etc/shadow or /etc/group cannot be read", async () => {
    for (const file of ["/etc/shadow", "/etc/group"]) {
      const missing = fakeFiles(Object.fromEntries(Object.entries(base).filter(([name]) => name !== file)));
      await expect(turnOff("usepam yes", missing)).rejects.toThrow(`Could not read ${file}, so BoxPilot cannot tell who could still sign in. Nothing was changed.`);
      expect(missing.written[dropIn]).toBeUndefined();
    }
  });

  it("gives the page the same answer the task acts on", async () => {
    const facts = await accessFacts({ read: async (file) => (file in base ? base[file] : Promise.reject(new Error("ENOENT"))), list: async () => [], today: 20400, sshd: parseEffectiveSshd("usepam yes\nauthenticationmethods publickey,keyboard-interactive") });
    expect(keyOnlyRefusal(facts)).toContain("AuthenticationMethods publickey,keyboard-interactive");
    expect(keyAdmins(facts)).toEqual([]);
    expect(facts.accounts.find((account) => account.name === "alex")).toMatchObject({ keyCount: 1, passwordUsable: true, canSudo: true, nopasswd: false, rootEquivalent: true });
  });
});

// M90 outside review: "the last administrator who can sign in" counted a sudo member who could not.
describe("the last administrator who can sign in, as it is", () => {
  const today = 20400;
  const now = today * 86_400_000;
  const passwd = "root:x:0:0::/root:/bin/bash\nalex:x:1000:1000::/home/alex:/bin/bash\nsam:x:1001:1001::/home/sam:/bin/bash\npat:x:1002:1002::/home/pat:/bin/bash\n";
  const db = { alex: { uid: 1000, home: "/home/alex" }, sam: { uid: 1001, home: "/home/sam" }, pat: { uid: 1002, home: "/home/pat" } };
  function box({ shadow = "alex:$6$a:20000:0:99999:7:::\nsam:!:20000:0:99999:7:::\npat:!:20000:0:99999:7:::\n", sshdT = "passwordauthentication yes\nusepam yes\n", extra = {} } = {}) {
    const users = structuredClone(db);
    const contents = { "/etc/passwd": passwd, "/etc/group": "sudo:x:27:alex,sam\n", "/etc/shadow": shadow, ...extra };
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/bin/getent" && args[0] === "passwd") { const entry = users[args[1]]; return entry ? { ok: true, stdout: `${args[1]}:x:${entry.uid}:${entry.uid}::${entry.home}:/bin/bash`, stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
      if (binary === "/usr/sbin/sshd") return sshdT === null ? { ok: false, stdout: "", stderr: "no hostkeys" } : { ok: true, stdout: sshdT, stderr: "" };
      if (binary === "/usr/sbin/userdel") { delete users[args.at(-1)]; return { ok: true, stdout: "", stderr: "" }; }
      if (binary === "/usr/sbin/usermod") { contents["/etc/shadow"] = contents["/etc/shadow"].replace(new RegExp(`^(${args.at(-1)}:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:)[^:]*`, "m"), "$11"); return { ok: true, stdout: "", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    });
    const files = { readFile: vi.fn(async (file) => (file in contents ? contents[file] : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })))), readdir: vi.fn(async () => []), access: vi.fn(async () => {}) };
    return { run, files };
  }

  it("does not count a sudo member with no password and no key", async () => {
    const { run, files } = box();
    await expect(userLock({ username: "alex" }, { run, files, now })).rejects.toThrow("alex is the last administrator who can sign in; locking it would leave nobody who can sign in over SSH and use sudo");
    await expect(userRemove({ username: "alex" }, { run, files, now })).rejects.toThrow("alex is the last administrator who can sign in; removing it");
    expect(run).not.toHaveBeenCalledWith("/usr/sbin/usermod", expect.anything(), expect.anything());
    expect(run).not.toHaveBeenCalledWith("/usr/sbin/userdel", expect.anything(), expect.anything());
  });

  it("does not count one with a key but no way to sudo, nor one whose password sshd no longer takes", async () => {
    const keyNoSudo = box({ extra: { "/home/sam/.ssh/authorized_keys": `${ED_KEY}\n` } });
    await expect(userLock({ username: "alex" }, { ...keyNoSudo, now })).rejects.toThrow("last administrator who can sign in");
    const passwordOff = box({ shadow: "alex:$6$a:20000:0:99999:7:::\nsam:$6$s:20000:0:99999:7:::\n", sshdT: "passwordauthentication no\nkbdinteractiveauthentication no\nusepam yes\n" });
    await expect(userLock({ username: "alex" }, { ...passwordOff, now })).rejects.toThrow("last administrator who can sign in");
    const deniedSam = box({ shadow: "alex:$6$a:20000:0:99999:7:::\nsam:$6$s:20000:0:99999:7:::\n", sshdT: "passwordauthentication yes\nusepam yes\ndenyusers sam\n" });
    await expect(userLock({ username: "alex" }, { ...deniedSam, now })).rejects.toThrow("last administrator who can sign in");
  });

  it("goes ahead when another administrator can sign in and sudo, with a password or a key", async () => {
    const withPassword = box({ shadow: "alex:$6$a:20000:0:99999:7:::\nsam:$6$s:20000:0:99999:7:::\n" });
    await expect(userLock({ username: "alex" }, { ...withPassword, now })).resolves.toMatchObject({ locked: true, changed: true });
    const withKey = box({ sshdT: "passwordauthentication no\nusepam yes\n", extra: { "/home/sam/.ssh/authorized_keys": `${ED_KEY}\n`, "/etc/sudoers": "%sudo ALL=(ALL:ALL) ALL\nsam ALL=(ALL) NOPASSWD: ALL\n" } });
    await expect(userRemove({ username: "alex" }, { ...withKey, now })).resolves.toMatchObject({ removed: true });
  });

  it("refuses when it cannot read sshd's configuration for an administrator, and does not ask for a non-administrator", async () => {
    const blind = box({ shadow: "alex:$6$a:20000:0:99999:7:::\nsam:$6$s:20000:0:99999:7:::\npat:!:20000:0:99999:7:::\n", sshdT: null });
    await expect(userLock({ username: "alex" }, { ...blind, now })).rejects.toThrow("Could not read the effective SSH configuration, so BoxPilot cannot tell whether alex is the last administrator who can sign in. Nothing was changed.");
    await expect(userLock({ username: "pat" }, { ...blind, now })).resolves.toMatchObject({ locked: true });
    expect(blind.run).not.toHaveBeenCalledWith("/usr/sbin/usermod", ["--lock", "--expiredate", "1", "alex"], expect.anything());
  });
});
