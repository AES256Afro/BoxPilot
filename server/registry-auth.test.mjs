import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createRegistryAuth } from "./registry-auth.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

// Assembled at run time: no token-shaped literal for a secret scan to find.
const fakeToken = (seed) => ["ghp", "x".repeat(8), seed, "y".repeat(8)].join("_");

/**
 * The Docker client as `docker login --password-stdin` behaves: it reads the token on stdin, asks the
 * registry (the daemon does), and on success adds `auths[<registry>]` to the config in DOCKER_CONFIG,
 * keeping what was there. `accepts` decides what the registry says.
 */
function fakeDocker({ accepts = () => true, key = (registry) => registry } = {}) {
  const calls = [];
  const runDocker = async (binary, args, options = {}) => {
    const folder = options.env?.DOCKER_CONFIG ?? null;
    const seen = folder ? JSON.parse(await readFile(path.join(folder, "config.json"), "utf8")) : null;
    calls.push({ binary, args, env: options.env ?? {}, input: options.input, seen });
    if (args[0] !== "login") return { ok: false, stdout: "", stderr: "unexpected" };
    const [, registry, , username] = args;
    if (!accepts(options.input)) return { ok: false, code: 1, stdout: "", stderr: `Error response from daemon: Get "https://${registry}/v2/": denied: denied` };
    const config = { ...seen, auths: { ...seen.auths, [key(registry)]: { auth: Buffer.from(`${username}:${options.input}`).toString("base64") } } };
    await writeFile(path.join(folder, "config.json"), JSON.stringify(config));
    return { ok: true, stdout: "Login Succeeded", stderr: "WARNING! Your credentials are stored unencrypted" };
  };
  return { calls, runDocker };
}

async function setup(docker = fakeDocker()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-registry-auth-"));
  directories.push(root);
  const directory = path.join(root, "registry-auth");
  return { root, directory, ...docker, auth: createRegistryAuth({ directory, dockerBinary: "/usr/bin/docker", runDocker: docker.runDocker }) };
}

describe("signing in to a container registry", () => {
  it("checks the token through docker login in a fresh folder, on stdin, and keeps only that registry's entry", async () => {
    const { auth, calls, directory } = await setup();
    const token = fakeToken("one");
    expect(await auth.dockerConfigDirectory()).toBeNull();
    expect(await auth.signIn({ registry: "ghcr.io", username: "someone", token })).toEqual({ registry: "ghcr.io", username: "someone", signedIn: true, replaced: false });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.args).toEqual(["login", "ghcr.io", "--username", "someone", "--password-stdin"]);
    // Never an argument: on stdin only.
    expect(call.args.join(" ")).not.toContain(token);
    expect(call.input).toBe(token);
    // A folder of its own inside the sign-ins folder, seeded so the client keeps what it writes in the file.
    expect(path.dirname(call.env.DOCKER_CONFIG)).toBe(directory);
    expect(path.basename(call.env.DOCKER_CONFIG)).toMatch(/^\.signin-/);
    expect(Object.keys(call.seen.auths)).toEqual(["boxpilot.invalid"]);
    // That folder is gone; the config holds the one entry.
    expect(await readdir(directory)).toEqual(["config.json"]);
    const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
    expect(Object.keys(config.auths)).toEqual(["ghcr.io"]);
    expect(Buffer.from(config.auths["ghcr.io"].auth, "base64").toString()).toBe(`someone:${token}`);
    expect(await auth.dockerConfigDirectory()).toBe(directory);
  });

  // POSIX modes.
  it.skipIf(onWindows)("keeps the folder root's alone (0700) and the config 0600", async () => {
    const { auth, directory } = await setup();
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: fakeToken("one") });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, "config.json"))).mode & 0o777).toBe(0o600);
  });

  it("leaves the saved sign-ins untouched when the registry refuses, and says so without the token", async () => {
    const good = fakeToken("good");
    const { auth, directory } = await setup(fakeDocker({ accepts: (token) => token === good }));
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: good });
    const before = await readFile(path.join(directory, "config.json"), "utf8");
    const bad = fakeToken("bad");
    const refusal = await auth.signIn({ registry: "ghcr.io", username: "someone", token: bad }).then(() => null, (error) => error);
    expect(refusal?.message).toMatch(/^Signing in to ghcr\.io failed: .*denied.*The sign-ins saved before are unchanged\.$/);
    expect(refusal.message).not.toContain(bad);
    expect(await readFile(path.join(directory, "config.json"), "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["config.json"]);
    // A first sign-in refused leaves nothing at all to point DOCKER_CONFIG at.
    const fresh = await setup(fakeDocker({ accepts: () => false }));
    await expect(fresh.auth.signIn({ registry: "ghcr.io", username: "someone", token: bad })).rejects.toThrow("failed");
    expect(await readdir(fresh.directory)).toEqual([]);
    expect(await fresh.auth.dockerConfigDirectory()).toBeNull();
  });

  it("lists registries and user names, never a token, and replaces a sign-in to the same registry", async () => {
    const { auth } = await setup();
    const first = fakeToken("first");
    const second = fakeToken("second");
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: first });
    await auth.signIn({ registry: "registry.example.test:5000", username: "builder", token: second });
    expect(await auth.signIn({ registry: "ghcr.io", username: "someone-else", token: second })).toMatchObject({ replaced: true });
    const listed = await auth.list();
    expect(listed).toEqual([{ registry: "ghcr.io", username: "someone-else" }, { registry: "registry.example.test:5000", username: "builder" }]);
    expect(JSON.stringify(listed)).not.toMatch(/first|second|auth/);
  });

  it("names Docker Hub as docker.io, whatever key the client keeps it under", async () => {
    const { auth } = await setup(fakeDocker({ key: () => "https://index.docker.io/v1/" }));
    await auth.signIn({ registry: "docker.io", username: "someone", token: fakeToken("hub") });
    expect(await auth.list()).toEqual([{ registry: "docker.io", username: "someone" }]);
    expect(await auth.signOut({ registry: "docker.io" })).toEqual({ registry: "docker.io", signedOut: true });
    expect(await auth.list()).toEqual([]);
  });

  it("clears what a sign-in cut off by a restart left behind", async () => {
    const { auth, directory, root } = await setup();
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: fakeToken("one") });
    const leftover = path.join(directory, ".signin-abc123");
    await mkdir(leftover);
    await writeFile(path.join(leftover, "config.json"), "{}");
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: fakeToken("two") });
    expect(await readdir(directory)).toEqual(["config.json"]);
    expect(await readdir(root)).toEqual(["registry-auth"]);
  });

  it("refuses what cannot be a registry, a user name or a token before asking Docker", async () => {
    const { auth, calls } = await setup();
    await expect(auth.signIn({ registry: "https://ghcr.io", username: "someone", token: fakeToken("x") })).rejects.toThrow("host name");
    await expect(auth.signIn({ registry: "ghcr.io", username: "some:one", token: fakeToken("x") })).rejects.toThrow("user name");
    await expect(auth.signIn({ registry: "ghcr.io", username: "someone", token: "" })).rejects.toThrow("empty");
    expect(calls).toEqual([]);
  });
});

describe("signing out", () => {
  it("forgets one registry, and removes the config with the last, so nothing points DOCKER_CONFIG at it", async () => {
    const { auth, directory } = await setup();
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: fakeToken("one") });
    await auth.signIn({ registry: "registry.example.test", username: "builder", token: fakeToken("two") });
    await auth.signOut({ registry: "ghcr.io" });
    expect(await auth.list()).toEqual([{ registry: "registry.example.test", username: "builder" }]);
    await auth.signOut({ registry: "registry.example.test" });
    expect(await readdir(directory)).toEqual([]);
    expect(await auth.dockerConfigDirectory()).toBeNull();
    await expect(auth.signOut({ registry: "ghcr.io" })).rejects.toThrow("not signed in to ghcr.io");
  });

  it("refuses to work over a damaged config rather than replace it", async () => {
    const { auth, directory } = await setup();
    await auth.signIn({ registry: "ghcr.io", username: "someone", token: fakeToken("one") });
    await writeFile(path.join(directory, "config.json"), "{ not json");
    await expect(auth.list()).rejects.toThrow("damaged");
    await expect(auth.signOut({ registry: "ghcr.io" })).rejects.toThrow("damaged");
    expect(await readFile(path.join(directory, "config.json"), "utf8")).toBe("{ not json");
  });
});
