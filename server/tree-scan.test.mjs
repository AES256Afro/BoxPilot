import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTreeScanBudget, listTreeEntries, measureTreeBytes } from "./tree-scan.mjs";

const roots = [];
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-tree-scan-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("measures regular files without following linked data or cycles", async () => {
  const root = await fixture(); const outside = await fixture();
  await mkdir(path.join(root, "child"));
  await writeFile(path.join(root, "child", "kept"), "12345");
  await writeFile(path.join(outside, "excluded"), "x".repeat(1024));
  await symlink(outside, path.join(root, "external"));
  await symlink(root, path.join(root, "child", "cycle"));
  expect(await measureTreeBytes(root)).toBe(5);
});

it("stops wide and deep scans instead of reporting a partial total as complete", async () => {
  const root = await fixture();
  for (let index = 0; index < 12; index += 1) await writeFile(path.join(root, String(index)), "x");
  await expect(measureTreeBytes(root, { budget: createTreeScanBudget({ maxEntries: 5 }) })).rejects.toMatchObject({ code: "TREE_SCAN_BUDGET" });
  await expect(listTreeEntries(root, { budget: createTreeScanBudget({ maxEntries: 5 }) })).rejects.toMatchObject({ code: "TREE_SCAN_BUDGET" });
  expect(await measureTreeBytes(root)).toBe(12); // prior refusal left no stuck iterator
  await mkdir(path.join(root, "a", "b", "c"), { recursive: true });
  await expect(measureTreeBytes(root, { budget: createTreeScanBudget({ maxDepth: 1 }) })).rejects.toMatchObject({ code: "TREE_SCAN_BUDGET" });
});

it("distinguishes absent roots from an invalid or linked inventory root", async () => {
  const root = await fixture();
  expect(await listTreeEntries(path.join(root, "absent"))).toEqual([]);
  await writeFile(path.join(root, "file"), "x");
  await expect(listTreeEntries(path.join(root, "file"))).rejects.toThrow(/real directory/);
  await symlink(root, path.join(root, "link"));
  await expect(listTreeEntries(path.join(root, "link"))).rejects.toThrow(/real directory/);
});

it("shares one budget across several trees and uses an injected deadline", async () => {
  const first = await fixture(); const second = await fixture();
  await writeFile(path.join(first, "a"), "x"); await writeFile(path.join(second, "b"), "x");
  const budget = createTreeScanBudget({ maxEntries: 1 });
  expect(await measureTreeBytes(first, { budget })).toBe(1);
  await expect(measureTreeBytes(second, { budget })).rejects.toMatchObject({ code: "TREE_SCAN_BUDGET" });
  let clock = 0;
  const timed = createTreeScanBudget({ maxDurationMs: 1000, now: () => clock });
  clock = 1000;
  await expect(measureTreeBytes(first, { budget: timed })).rejects.toMatchObject({ code: "TREE_SCAN_BUDGET" });
});
