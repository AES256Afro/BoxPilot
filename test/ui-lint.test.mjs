import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./check-harness.mjs";

const execFile = promisify(execFileCallback);

/**
 * The UI's two guards, shown failing on something known to be wrong (M84; the rule is M54's).
 *
 * src/ was never linted: it carried sixteen `eslint-disable react-hooks/exhaustive-deps` comments
 * for a plugin nobody had installed, so each one suppressed nothing and nothing checked the hooks.
 * `npm run lint:ui` runs oxlint over it (ESLint cannot parse .tsx against this repo's TypeScript 7),
 * and tsconfig.app.json now refuses unused names. Both are cheap to break without noticing: a config
 * that names a rule oxlint does not know, or a category turned off over the rules, passes everything.
 *
 * The oxlint flags are read from package.json's `lint:ui`, so these cases run what the gate runs.
 */

const scripts = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).scripts ?? {};
const temporary = [];
afterAll(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function tree(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-ui-lint-"));
  temporary.push(directory);
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents);
  return directory;
}

/** Run a node CLI from node_modules, returning its exit code and everything it printed. */
async function run(bin, args) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [path.join(repoRoot, "node_modules", bin), ...args], { cwd: repoRoot });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return { code: error.code, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** `lint:ui` with its target (src) swapped for a planted tree. */
async function lintUi(files) {
  const words = scripts["lint:ui"].split(/\s+/);
  expect(words[0]).toBe("oxlint");
  expect(words.at(-1)).toBe("src");
  return run("oxlint/bin/oxlint", [...words.slice(1, -1), await tree(files)]);
}

const header = 'import { useCallback, useEffect, useState } from "react";\n';

describe("npm run lint:ui", () => {
  it("is part of npm run lint, so the gate runs it over src/", () => {
    expect(scripts.lint).toContain("npm run lint:ui");
    expect(scripts["lint:ui"]).toMatch(/^oxlint -c \.oxlintrc\.json .* src$/);
  });

  it("fails on a hook called inside a callback (the SharesTab useDevice shape)", async () => {
    const result = await lintUi({ "planted.tsx": `${header}export function Picker({ items }: { items: string[] }) {\n  return <ul>{items.map((item) => { const [on] = useState(false); return <li key={item}>{String(on)}</li>; })}</ul>;\n}\n` });
    expect(result.code).toBe(1);
    expect(result.output).toContain("rules-of-hooks");
  });

  it("fails on an effect missing a dependency", async () => {
    const result = await lintUi({ "planted.tsx": `${header}export function Watch({ id }: { id: string }) {\n  const [seen, setSeen] = useState("");\n  useEffect(() => { setSeen(id); }, []);\n  return <p>{seen}</p>;\n}\n` });
    expect(result.code).toBe(1);
    expect(result.output).toContain("exhaustive-deps");
  });

  it("fails on a disable comment that suppresses nothing", async () => {
    const result = await lintUi({ "planted.tsx": `${header}export function Quiet() {\n  // eslint-disable-next-line react-hooks/exhaustive-deps\n  useEffect(() => {}, []);\n  return null;\n}\n` });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Unused eslint-disable directive/);
  });

  it("stays quiet on hooks used as React means them to be", async () => {
    const result = await lintUi({
      "fine.tsx": `${header}function useToggle(initial: boolean) {\n  const [on, setOn] = useState(initial);\n  const flip = useCallback(() => setOn((value) => !value), []);\n  return [on, flip] as const;\n}\nexport function Watch({ id, items }: { id: string; items: string[] }) {\n  const [seen, setSeen] = useState("");\n  const [on, flip] = useToggle(false);\n  const read = useCallback(() => fetch(\`/api/\${id}\`), [id]);\n  useEffect(() => { void read(); setSeen(id); }, [id, read]);\n  const pickItem = (item: string) => setSeen(item);\n  return <ul onClick={flip}>{String(on)}{seen}{items.map((item) => <li key={item} onClick={() => pickItem(item)}>{item}</li>)}</ul>;\n}\n`,
    });
    expect(result.output).not.toMatch(/react-hooks|eslint-disable/);
    expect(result.code).toBe(0);
  });
});

describe("tsconfig.app.json", () => {
  // A project extending the app's own config, so the flags are tested as the build reads them.
  // `types` is cleared because vitest/globals does not resolve from a temporary directory.
  const project = (source) => tree({
    "tsconfig.json": JSON.stringify({ extends: path.join(repoRoot, "tsconfig.app.json"), compilerOptions: { types: [] }, include: ["*.ts"] }),
    "words.ts": 'export const greeting = "hello";\n',
    "planted.ts": source,
  });

  it("refuses an unused import and an unused parameter", async () => {
    const directory = await project('import { greeting } from "./words";\nexport function size(label: string, count: number): number {\n  return count;\n}\n');
    const result = await run("typescript/bin/tsc", ["-p", directory]);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/TS6133: 'greeting' is declared but its value is never read/);
    expect(result.output).toMatch(/TS6133: 'label' is declared but its value is never read/);
  });

  it("accepts a parameter a fixed signature needs, marked with an underscore", async () => {
    const directory = await project("export const handlers: Array<(event: string, index: number) => number> = [(_event, index) => index];\n");
    const result = await run("typescript/bin/tsc", ["-p", directory]);
    expect(result.output).not.toMatch(/error TS/);
    expect(result.code).toBe(0);
  });
});
