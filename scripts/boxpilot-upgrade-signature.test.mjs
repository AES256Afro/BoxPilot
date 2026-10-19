/**
 * The release signature check the upgrade script runs when the owner has set a release key: the
 * script's own program, against a real git repository with real SSH-signed tags, and the
 * allowed-signers file exactly as the server writes it (server/release-signer.mjs).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { parseSignerKey, signerFileText } from "../server/release-signer.mjs";

const script = (await readFile("scripts/boxpilot-upgrade.sh", "utf8")).replaceAll("\r\n", "\n");
const verifyProgram = /\nVERIFY_RELEASE_SH='\n([\s\S]*?)\n'\n/.exec(script)?.[1];
const haveTools = ["git", "ssh-keygen"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.com", GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.com", ...options.env } });
  if (result.status !== 0 && !options.allowFail) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result;
};

async function signedRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-signed-"));
  directories.push(root);
  const key = (name) => { run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${name}@example.com`, "-f", path.join(root, name)]); return path.join(root, name); };
  const release = key("release");
  const stranger = key("stranger");
  const repo = path.join(root, "repo");
  run("git", ["init", "-q", repo]);
  await writeFile(path.join(repo, "package.json"), '{ "version": "1.0.0" }\n');
  run("git", ["-C", repo, "add", "."]);
  run("git", ["-C", repo, "commit", "-q", "-m", "first"]);
  const first = run("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.trim();
  const tag = (name, signingKey) => run("git", ["-C", repo, "-c", "gpg.format=ssh", ...(signingKey ? ["-c", `user.signingkey=${signingKey}`] : []), "tag", ...(signingKey ? ["-s"] : ["-a"]), name, "-m", name]);
  tag("v1.0.0", release);
  tag("v1.0.1", stranger);
  tag("v1.0.2", null);
  run("git", ["-C", repo, "tag", "v1.0.3"]); // lightweight
  await writeFile(path.join(repo, "package.json"), '{ "version": "1.0.4" }\n');
  run("git", ["-C", repo, "commit", "-q", "-am", "second"]);
  tag("v1.0.4", release);
  const signers = path.join(root, "release-signers");
  await writeFile(signers, signerFileText(parseSignerKey(await readFile(`${release}.pub`, "utf8"))));
  return { root, repo, first, signers };
}

async function verify({ root, repo, signers }, tag, expect = "") {
  const out = await mkdtemp(path.join(root, "out-"));
  const result = run("sh", ["-c", verifyProgram, "verify-release", `file://${repo}`, tag, expect, signers, out], { allowFail: true });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), files: await readdir(out) };
}

describe("checking a release's signature before building it", () => {
  it("is in the script as one program, with no single quote inside", () => {
    expect(verifyProgram).toBeTruthy();
    expect(verifyProgram).not.toContain("'");
  });

  it.skipIf(onWindows || !haveTools)("builds a tag the release key signed, at the commit it points to", async () => {
    const repository = await signedRepository();
    const result = await verify(repository, "v1.0.0", repository.first);
    expect(result).toMatchObject({ status: 0, stdout: repository.first, files: ["package.json"] });
    expect(JSON.parse(await readFile(path.join(repository.root, (await readdir(repository.root)).find((name) => name.startsWith("out-")), "package.json"), "utf8")).version).toBe("1.0.0");
  });

  it.skipIf(onWindows || !haveTools)("refuses a tag signed by another key, an unsigned one, a lightweight one, and one that moved", async () => {
    const repository = await signedRepository();
    const stranger = await verify(repository, "v1.0.1");
    expect(stranger).toMatchObject({ status: 3, files: [] });
    expect(stranger.stderr).toContain("v1.0.1 is not signed by the release key");
    expect(await verify(repository, "v1.0.2")).toMatchObject({ status: 3, files: [] });
    const light = await verify(repository, "v1.0.3");
    expect(light).toMatchObject({ status: 3, files: [] });
    expect(light.stderr).toContain("lightweight tag");
    // Signed, but not the commit the owner reviewed on the System page.
    const moved = await verify(repository, "v1.0.4", repository.first);
    expect(moved).toMatchObject({ status: 3, files: [] });
    expect(moved.stderr).toContain(`not ${repository.first}`);
    expect(await verify(repository, "v9.9.9")).toMatchObject({ status: 2, files: [] });
  });
});
