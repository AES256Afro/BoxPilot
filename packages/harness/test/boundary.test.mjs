// @vitest-environment node
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The harness stands on its own (ADR-013 §6): every import in its source is one of Node's own
 * modules, a file inside the package, or a dependency its package.json declares. Nothing from
 * BoxPilot's server/ or src/, however short the relative path that would reach it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(full));
    else if (/\.(mjs|js)$/.test(entry.name) && !/\.test\.(mjs|js)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const specifiers = (code) => [
  ...code.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
  ...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
].map((match) => match[1]);

describe("the harness package", () => {
  it("imports only Node, its own files and the dependencies it declares", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
    const files = await sources(path.join(root, "src"));
    expect(files.length).toBeGreaterThan(0);
    const stray = [];
    for (const file of files) {
      for (const specifier of specifiers(await readFile(file, "utf8"))) {
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(file), specifier);
          if (!target.startsWith(path.join(root, "src") + path.sep)) stray.push(`${path.relative(root, file)} → ${specifier}`);
          continue;
        }
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!declared.has(name)) stray.push(`${path.relative(root, file)} → ${specifier}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("asks for the same versions as the project around it, when it sits in one", async () => {
    const host = path.resolve(root, "../../package.json");
    if (!existsSync(host)) return;
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const around = JSON.parse(await readFile(host, "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) expect(`${name}@${around.dependencies?.[name]}`).toBe(`${name}@${version}`);
  });
});
