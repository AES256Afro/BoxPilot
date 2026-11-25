import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { parseSshdConfig, parseUsers, userOperations } from "./users.mjs";

const operations = Object.fromEntries(userOperations().map((operation) => [operation.id, operation]));

describe("user operations", () => {
  it("parses human accounts with sudo membership from passwd and group", () => {
    const passwd = [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1::/usr/sbin:/usr/sbin/nologin",
      "alex:x:1000:1000:Alex:/home/alex:/bin/bash",
      "backupbot:x:1001:1001::/home/backupbot:/usr/sbin/nologin",
      "pat:x:1002:1002::/home/pat:/bin/zsh",
      "nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin",
    ].join("\n");
    const group = "sudo:x:27:alex\nusers:x:100:";
    expect(parseUsers(passwd, group)).toEqual([
      { name: "root", uid: 0, home: "/root", shell: "/bin/bash", sudo: true },
      { name: "alex", uid: 1000, home: "/home/alex", shell: "/bin/bash", sudo: true },
      { name: "pat", uid: 1002, home: "/home/pat", shell: "/bin/zsh", sudo: false },
    ]);
  });

  it("parses effective sshd settings from sshd -T output", () => {
    expect(parseSshdConfig("port 22\npasswordauthentication no\npermitrootlogin prohibit-password\npubkeyauthentication yes\nkbdinteractiveauthentication no\n"))
      .toEqual({ passwordAuthentication: false, keyboardInteractive: false, pubkeyAuthentication: true, permitRootLogin: "prohibit-password", port: 22 });
  });

  it("stages mutations as root tasks with exact payloads", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["users.add"].run({ username: "alex", githubUser: "alex-gh" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("users.add", { username: "alex", githubUser: "alex-gh" }, expect.anything());
    await operations["users.keys.import"].run({ username: "alex", keys: "ssh-ed25519 AAAA x" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("users.keys-import", { username: "alex", githubUser: null, keys: "ssh-ed25519 AAAA x" }, expect.anything());
    await operations["ssh.password-auth.set"].run({ enabled: false }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("ssh.password-auth", { enabled: false }, expect.anything());
  });

  it("rejects malformed parameters at the registry boundary", () => {
    expect(validateParameters(operations["users.add"].parameters, { username: "alex" }, "t")).toBeNull();
    expect(validateParameters(operations["users.add"].parameters, { username: "Alex!" }, "t")).toContain("invalid value");
    expect(validateParameters(operations["users.sudo.set"].parameters, { username: "alex", sudo: true }, "t")).toBeNull();
    expect(validateParameters(operations["users.sudo.set"].parameters, { username: "alex", sudo: "yes" }, "t")).toContain("boolean");
    expect(validateParameters(operations["ssh.password-auth.set"].parameters, { enabled: true }, "t")).toBeNull();
    expect(operations["users.sudo.set"].risk).toBe("high");
    expect(operations["ssh.password-auth.set"].risk).toBe("high");
  });

  // M90: the page needs to know who could still sign in with a key, and which accounts are shut.
  it("reads which accounts are locked and which administrators could sign in with a key", async () => {
    const files = {
      "/etc/passwd": "root:x:0:0::/root:/bin/bash\nalex:x:1000:1000::/home/alex:/bin/bash\npat:x:1001:1001::/home/pat:/bin/bash\nsam:x:1002:1002::/home/sam:/bin/bash\n",
      "/etc/group": "sudo:x:27:alex,sam\n",
      "/etc/shadow": "root:*:20000:0:99999:7:::\nalex:!:20000:0:99999:7:::\npat:!:20000:0:99999:7:::\nsam:!:20000:0:99999:7::1:\n",
      "/root/.ssh/authorized_keys": "ssh-ed25519 AAAAroot root\n",
      "/home/pat/.ssh/authorized_keys": "ssh-ed25519 AAAApat pat\n",
      "/home/sam/.ssh/authorized_keys": "ssh-ed25519 AAAAsam sam\n",
    };
    const read = async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); };
    const run = vi.fn(async (binary) => (binary.endsWith("sshd") ? { ok: true, stdout: "passwordauthentication no\nkbdinteractiveauthentication yes\npermitrootlogin no\n", stderr: "" } : { ok: true, stdout: "ActiveState=active\n", stderr: "" }));
    const report = await operations["users.inspect"].run({}, { run, read, now: 20400 * 86_400_000 });
    expect(report.users.map((user) => [user.name, user.keyCount, user.locked])).toEqual([["root", 1, false], ["alex", 0, false], ["pat", 1, false], ["sam", 1, true]]);
    // root under PermitRootLogin no, pat without sudo, sam locked: none of them is a way in.
    expect(report.keyAdmins).toEqual([]);
    expect(report.keyOnlyProblem).toContain("No administrator could sign in with a key and use sudo afterwards.");
    // sudoers could not be read here, so every account counts as an administrator for locking.
    expect(report.users.map((user) => user.rootEquivalent)).toEqual([true, true, true, true]);
    expect(report.sshd).toMatchObject({ passwordAuthentication: false, keyboardInteractive: true });
  });

  // M90 review: the page's answer comes from the same facts as the task's guard: sudo that works,
  // AllowUsers, the files sshd reads keys from, and who is root in all but name.
  it("reports who could administer with a key the way the guard decides it, and who is root in all but name", async () => {
    const files = {
      "/etc/passwd": "root:x:0:0::/root:/bin/bash\nalex:x:1000:1000::/home/alex:/bin/bash\npat:x:1001:1001::/home/pat:/bin/bash\nkim:x:1002:1002::/home/kim:/bin/bash\n",
      "/etc/group": "sudo:x:27:alex\ndocker:x:998:kim\n",
      "/etc/shadow": "alex:!:20000:0:99999:7:::\npat:$6$p:20000:0:99999:7:::\nkim:$6$k:20000:0:99999:7:::\n",
      "/etc/sudoers": "%sudo ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n",
      "/etc/sudoers.d/alex": "alex ALL=(ALL) NOPASSWD: ALL\n",
      "/etc/ssh/keys/alex": "ssh-ed25519 AAAAalex alex\n",
      "/home/alex/.ssh/authorized_keys": "ssh-ed25519 AAAAignored alex\n",
    };
    const read = async (file) => { if (file in files) return files[file]; throw new Error("ENOENT"); };
    const list = async () => ["alex"];
    const sshdSays = (extra) => vi.fn(async (binary) => (binary.endsWith("sshd") ? { ok: true, stdout: `passwordauthentication yes\nusepam yes\nauthorizedkeysfile /etc/ssh/keys/%u\n${extra}`, stderr: "" } : { ok: true, stdout: "ActiveState=active\n", stderr: "" }));
    const report = await operations["users.inspect"].run({}, { run: sshdSays(""), read, list, now: 20400 * 86_400_000 });
    expect(report.keyAdmins).toEqual(["alex"]);
    expect(report.keyOnlyProblem).toBeNull();
    expect(report.users.map((user) => [user.name, user.keyCount, user.rootEquivalent])).toEqual([["root", 0, true], ["alex", 1, true], ["pat", 0, false], ["kim", 0, true]]);
    const restricted = await operations["users.inspect"].run({}, { run: sshdSays("allowusers pat\n"), read, list, now: 20400 * 86_400_000 });
    expect(restricted.keyAdmins).toEqual([]);
    expect(restricted.keyOnlyProblem).toContain("alex: AllowUsers in the SSH configuration keeps it out");
  });

  it("locks, unlocks and removes accounts as root tasks, removal typed and high", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["users.lock"].run({ username: "sam" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("users.lock", { username: "sam" }, expect.anything());
    await operations["users.unlock"].run({ username: "sam" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("users.unlock", { username: "sam" }, expect.anything());
    await operations["users.remove"].run({ username: "sam" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("users.remove", { username: "sam", removeHome: false }, expect.anything());
    expect([operations["users.lock"].risk, operations["users.unlock"].risk, operations["users.remove"].risk]).toEqual(["medium", "medium", "high"]);
    expect(operations["users.remove"].confirm({ username: "sam", removeHome: true })).toBe("sam");
    expect(validateParameters(operations["users.remove"].parameters, { username: "sam", removeHome: true }, "t")).toBeNull();
    expect(validateParameters(operations["users.remove"].parameters, { username: "sam", removeHome: "yes" }, "t")).toContain("boolean");
    expect(validateParameters(operations["users.lock"].parameters, { username: "../root" }, "t")).toContain("invalid value");
  });
});
