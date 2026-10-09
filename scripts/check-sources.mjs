#!/usr/bin/env node
/**
 * Syntax-check the server and script sources without running them.
 *   node scripts/check-sources.mjs syntax   # `node --check` every .mjs under server/ and scripts/
 *   node scripts/check-sources.mjs shell    # `sh -n` every .sh in scripts/ and deploy/
 *
 * These were shell one-liners (`find | xargs`, a `for` loop), and npm runs scripts through cmd.exe
 * on Windows, where neither parses: `npm run check` could not pass on a Windows checkout however
 * green the code was. The same checks, walked in Node, run the same on both. `node --check` runs
 * several at a time; one process per file is what makes the check slow, not the checking.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function filesUnder(directory, extension, { recursive }) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive && entry.name !== "node_modules") found.push(...await filesUnder(full, extension, { recursive }));
    else if (entry.isFile() && entry.name.endsWith(extension)) found.push(full);
  }
  return found.sort();
}

function check(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) => resolve({ ok: false, error: error.code === "ENOENT" ? `${command} was not found on the PATH` : error.message }));
    child.on("close", (code) => resolve({ ok: code === 0 }));
  });
}

async function checkAll(files, argsFor, command) {
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const result = await check(command, argsFor(file));
      if (!result.ok) failures.push(`${file}${result.error ? `: ${result.error}` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(os.availableParallelism?.() ?? 4, 8)) }, worker));
  return failures;
}

const mode = process.argv[2];
let files; let failures;
if (mode === "syntax") {
  files = [...await filesUnder("server", ".mjs", { recursive: true }), ...await filesUnder("scripts", ".mjs", { recursive: true }), ...await filesUnder("packages", ".mjs", { recursive: true })];
  failures = await checkAll(files, (file) => ["--check", file], process.execPath);
} else if (mode === "shell") {
  files = [...await filesUnder("scripts", ".sh", { recursive: false }), ...await filesUnder("deploy", ".sh", { recursive: false })];
  failures = await checkAll(files, (file) => ["-n", file], "sh");
} else {
  console.error("Usage: node scripts/check-sources.mjs syntax|shell");
  process.exit(2);
}
for (const failure of failures) console.error(`FAILED ${failure}`);
console.log(`${mode}: ${files.length - failures.length} of ${files.length} files passed`);
process.exitCode = failures.length ? 1 : 0;
