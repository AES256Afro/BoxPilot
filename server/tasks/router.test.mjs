import { describe, it, expect, vi } from "vitest";
import { routerConnect, routerInspect, routerLeases, routerLogin, validateRouter, credentialsPath } from "./router.mjs";

/**
 * The router is reached over a self-signed certificate with a stored password, so the parts worth
 * pinning are the ones that protect it: the password never reaching a command line, the credential
 * never being written before it has been proved, and a changed certificate being refused.
 */
const CHALLENGE = { alg: 5, salt: "3y.arn3Fg9EbDSfF", nonce: "zevUELh85e1WxlJRusb7y6uc31utgsQ3" };

function harness({ loginFails = false } = {}) {
  const calls = [];
  const fetchJson = vi.fn(async (_url, body) => {
    calls.push(body);
    if (body.method === "challenge") return { result: CHALLENGE };
    if (body.method === "login") return loginFails ? { error: { message: "Invalid username or password" } } : { result: { sid: "session-1" } };
    if (body.method === "call" && body.params[1] === "system") return { result: { model: "GL-MT6000", firmware_version: "4.7.0" } };
    if (body.method === "call" && body.params[1] === "clients") {
      return { result: { clients: [
        { name: "chris-laptop", ip: "192.168.8.26", mac: "aa:bb:cc:dd:ee:01", online: true, is_static: false },
        { name: "bigbox", ip: "192.168.8.10", mac: "aa:bb:cc:dd:ee:02", online: true, is_static: true },
        { name: "ghost", ip: null, mac: "aa:bb:cc:dd:ee:03", online: false },  // no address: not a lease
      ] } };
    }
    return { result: {} };
  });
  const run = vi.fn(async (binary, args, options) => ({
    ok: true,
    stdout: args[0] === "passwd" ? "$5$salt$hashedvalue" : "d41d8cd98f00b204e9800998ecf8427e *stdin",
    stderr: "", input: options?.input,
  }));
  const written = {};
  const files = {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path, contents) => { written[path] = contents; }),
    readFile: vi.fn(async (path) => written[path] ?? Promise.reject(new Error("ENOENT"))),
  };
  return { fetchJson, run, files, written, calls };
}

describe("signing in to the router", () => {
  it("never puts the password on a command line", async () => {
    const { fetchJson, run } = harness();
    await routerLogin({ host: "192.168.8.1", username: "root", password: "hunter2 hunter2" }, { run, fetchJson });
    for (const [, args] of run.mock.calls) {
      expect(args.join(" ")).not.toContain("hunter2");
    }
    // It goes in on stdin instead, which `ps` does not show.
    expect(run.mock.calls[0][2].input).toBe("hunter2 hunter2");
    expect(run.mock.calls[0][1]).toEqual(["passwd", "-5", "-salt", CHALLENGE.salt, "-stdin"]);
  });

  it("follows the challenge with the hash the router asked for", async () => {
    const { fetchJson, run, calls } = harness();
    const sid = await routerLogin({ host: "192.168.8.1", username: "root", password: "x" }, { run, fetchJson });
    expect(sid).toBe("session-1");
    expect(calls[0]).toMatchObject({ method: "challenge", params: { username: "root" } });
    expect(calls[1].method).toBe("login");
    expect(calls[1].params.password).toBeUndefined(); // the password itself is never sent
  });

  it("says the router refused it, rather than something vaguer", async () => {
    const { fetchJson, run } = harness({ loginFails: true });
    await expect(routerLogin({ host: "192.168.8.1", username: "root", password: "wrong" }, { run, fetchJson }))
      .rejects.toThrow("Invalid username or password");
  });
});

describe("storing the credential", () => {
  it("proves the password works before writing it down", async () => {
    const { fetchJson, run, files } = harness({ loginFails: true });
    await expect(routerConnect({ kind: "glinet", host: "192.168.8.1", username: "root", password: "wrong" }, { run, fetchJson, files }))
      .rejects.toThrow();
    // A credential saved without being tried is a setting that looks done and is not.
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("writes it root-only once the router has accepted it", async () => {
    const { fetchJson, run, files, written } = harness();
    await routerConnect({ kind: "glinet", host: "192.168.8.1", username: "root", password: "s3cret" }, { run, fetchJson, files });
    expect(files.writeFile).toHaveBeenCalledWith(credentialsPath, expect.stringContaining("host=192.168.8.1"), { mode: 0o600 });
    expect(written[credentialsPath]).toContain("username=root");
    expect(files.mkdir).toHaveBeenCalledWith("/etc/boxpilot/secrets", { recursive: true, mode: 0o700 });
  });

  it("refuses an address or a kind it does not understand", () => {
    expect(validateRouter({ kind: "linksys", host: "192.168.8.1", username: "root" })).toMatch(/kind/);
    expect(validateRouter({ kind: "glinet", host: "not a host", username: "root" })).toMatch(/address/);
    expect(validateRouter({ kind: "glinet", host: "192.168.8.1", username: "ro ot" })).toMatch(/username/);
    expect(validateRouter({ kind: "glinet", host: "192.168.8.1", username: "root", password: "a\nb" })).toMatch(/password/);
    expect(validateRouter({ kind: "glinet", host: "192.168.8.1", username: "root", password: "fine" })).toBeNull();
  });
});

describe("reading what the router knows", () => {
  it("reports not-connected as a state, not a failure", async () => {
    const { fetchJson, run, files } = harness();
    expect(await routerInspect({}, { run, fetchJson, files })).toMatchObject({ configured: false, reachable: false });
  });

  it("separates a credential that stopped working from one never set up", async () => {
    const { fetchJson, run, files } = harness();
    await routerConnect({ kind: "glinet", host: "192.168.8.1", username: "root", password: "s3cret" }, { run, fetchJson, files });
    const broken = harness({ loginFails: true });
    broken.files.readFile = files.readFile;
    const report = await routerInspect({}, { run: broken.run, fetchJson: broken.fetchJson, files: broken.files });
    expect(report).toMatchObject({ configured: true, reachable: false });
    expect(report.reason).toMatch(/Invalid username or password/);
  });

  it("lists the devices with an address, and marks the reserved ones", async () => {
    const { fetchJson, run, files } = harness();
    await routerConnect({ kind: "glinet", host: "192.168.8.1", username: "root", password: "s3cret" }, { run, fetchJson, files });
    const { leases } = await routerLeases({}, { run, fetchJson, files });
    expect(leases).toEqual([
      { name: "chris-laptop", address: "192.168.8.26", mac: "aa:bb:cc:dd:ee:01", online: true, reserved: false },
      { name: "bigbox", address: "192.168.8.10", mac: "aa:bb:cc:dd:ee:02", online: true, reserved: true },
    ]);
  });

  it("refuses to read leases with no router connected", async () => {
    const { fetchJson, run, files } = harness();
    await expect(routerLeases({}, { run, fetchJson, files })).rejects.toThrow("No router is connected");
  });
});
