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
});
