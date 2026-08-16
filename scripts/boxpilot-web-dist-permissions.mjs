#!/usr/local/bin/node
import path from "node:path";
import { chmod, lstat, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultDistRoot = path.resolve(scriptDirectory, "..", "dist");

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function normalizeWebDistPermissions(root = defaultDistRoot) {
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  const directories = [];
  const files = [];

  while (pending.length > 0) {
    const target = pending.pop();
    if (!isWithin(resolvedRoot, target)) throw new Error("The web build contains a path outside dist");
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("The web build contains a symbolic link");
    if (metadata.isDirectory()) {
      directories.push(target);
      for (const name of await readdir(target)) {
        if (name === "." || name === ".." || name.includes(path.sep)) throw new Error("The web build contains an unsafe name");
        pending.push(path.resolve(target, name));
      }
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("The web build contains an unsafe file");
    files.push(target);
  }

  for (const target of directories) await chmod(target, 0o755);
  for (const target of files) await chmod(target, 0o644);
  return { root: resolvedRoot, directories: directories.length, files: files.length };
}

async function main() {
  if (process.argv.length !== 2) throw new Error("This fixed build-permission normalizer accepts no arguments");
  const result = await normalizeWebDistPermissions();
  console.log(`Normalized ${result.directories} web directories and ${result.files} web files under dist`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
