import path from "node:path";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeWebDistPermissions } from "./boxpilot-web-dist-permissions.mjs";

const temporaryRoots = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "boxpilot-web-dist-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "dist");
  const assets = path.join(root, "assets");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "index.html"), "<!doctype html>\n", { mode: 0o600 });
  await writeFile(path.join(assets, "app.js"), "export {};\n", { mode: 0o600 });
  await chmod(root, 0o700);
  await chmod(assets, 0o700);
  return { parent, root, assets };
}

describe("web distribution permission normalization", () => {
  it("makes only generated directories traversable and generated files readable", async () => {
    const { root, assets } = await fixture();
    const result = await normalizeWebDistPermissions(root);

    expect(result).toMatchObject({ root, directories: 2, files: 2 });
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
    expect((await lstat(assets)).mode & 0o777).toBe(0o755);
    expect((await lstat(path.join(root, "index.html"))).mode & 0o777).toBe(0o644);
    expect((await lstat(path.join(assets, "app.js"))).mode & 0o777).toBe(0o644);
  });

  it("rejects a symbolic link before changing any build mode", async () => {
    const { parent, root } = await fixture();
    const outside = path.join(parent, "outside.txt");
    await writeFile(outside, "private\n", { mode: 0o600 });
    await symlink(outside, path.join(root, "outside-link"));

    await expect(normalizeWebDistPermissions(root)).rejects.toThrow("symbolic link");
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(outside)).mode & 0o777).toBe(0o600);
  });
});
