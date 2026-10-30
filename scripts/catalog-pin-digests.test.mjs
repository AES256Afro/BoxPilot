// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../server/catalog/index.mjs";
import { applyPins, planPins } from "./catalog-pin-digests.mjs";

const digest = (letter) => `sha256:${letter.repeat(64)}`;

const manifest = ({ id = "game", reference = "ghcr.io/owner/game:1.2", sidecar } = {}) => [
  "schemaVersion: 2", `id: ${id}`, "name: Game", "category: Games", 'description: "A test app."',
  "image:", "  # the tag the release notes name", `  reference: ${reference}`,
  "ports:", "  - id: web", "    label: Game", "    container: 8080", "    host: 8139", "    exposure: lan",
  ...(sidecar ? ["sidecars:", "  - id: db", `    image: ${sidecar}`] : []), "",
].join("\n");

describe("planning pins", () => {
  const registry = { "ghcr.io/owner/game:1.2": digest("a"), "postgres:16": digest("b"), "ghcr.io/owner/moved:1.0": digest("c") };
  const resolve = async (reference) => {
    if (reference === "ghcr.io/owner/down:1.0") throw new Error("HTTP 503");
    return { digest: registry[reference] ?? null };
  };
  const manifests = [
    { id: "game", file: "game.yaml", image: { reference: "ghcr.io/owner/game:1.2" }, sidecars: [{ id: "db", image: "postgres:16" }] },
    { id: "moved", file: "moved.yaml", image: { reference: `ghcr.io/owner/moved:1.0@${digest("9")}` } },
    { id: "current", file: "current.yaml", image: { reference: `postgres:16@${digest("b")}` } },
    { id: "exact", file: "exact.yaml", image: { reference: `ghcr.io/owner/exact@${digest("e")}` } },
    { id: "down", file: "down.yaml", image: { reference: "ghcr.io/owner/down:1.0" } },
    { id: "gone", file: "gone.yaml", image: { reference: "ghcr.io/owner/gone:1.0" } },
  ];

  it("pins every image that has only a tag, main and sidecar, and records lookups that failed", async () => {
    const { pins, failures } = await planPins(manifests, { resolve });
    expect(pins).toEqual([
      { id: "game", file: "game.yaml", reference: "ghcr.io/owner/game:1.2", next: `ghcr.io/owner/game:1.2@${digest("a")}` },
      { id: "game", file: "game.yaml", reference: "postgres:16", next: `postgres:16@${digest("b")}` },
    ]);
    expect(failures).toEqual([
      { id: "down", reference: "ghcr.io/owner/down:1.0", error: "HTTP 503" },
      { id: "gone", reference: "ghcr.io/owner/gone:1.0", error: "the registry gave no digest for this tag" },
    ]);
  });

  it("moves a pin whose tag has moved only when asked to refresh", async () => {
    const { pins } = await planPins(manifests, { resolve, refresh: true });
    expect(pins).toContainEqual({ id: "moved", file: "moved.yaml", reference: `ghcr.io/owner/moved:1.0@${digest("9")}`, next: `ghcr.io/owner/moved:1.0@${digest("c")}` });
    expect(pins.some((pin) => pin.id === "exact" || pin.id === "current")).toBe(false);
  });
});

describe("writing pins", () => {
  let directory;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-catalog-pin-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("pins main and sidecar images, keeps comments, and leaves a catalog that validates", async () => {
    await writeFile(path.join(directory, "game.yaml"), manifest({ sidecar: "postgres:16" }));
    await applyPins([
      { file: "game.yaml", reference: "ghcr.io/owner/game:1.2", next: `ghcr.io/owner/game:1.2@${digest("a")}` },
      { file: "game.yaml", reference: "postgres:16", next: `postgres:16@${digest("b")}` },
    ], directory);
    const { manifests, problems } = await loadCatalog({ directory });
    expect(problems).toEqual([]);
    expect(manifests[0].image).toMatchObject({ reference: `ghcr.io/owner/game:1.2@${digest("a")}`, digestPinned: true });
    expect(manifests[0].sidecars[0].image).toBe(`postgres:16@${digest("b")}`);
    expect(await readFile(path.join(directory, "game.yaml"), "utf8")).toContain("# the tag the release notes name");
  });

  it("does not touch a longer tag that starts the same, and refuses when the reference is not there", async () => {
    await writeFile(path.join(directory, "game.yaml"), manifest({ reference: "ghcr.io/owner/game:1.2.3" }));
    await expect(applyPins([{ file: "game.yaml", reference: "ghcr.io/owner/game:1.2", next: `ghcr.io/owner/game:1.2@${digest("a")}` }], directory))
      .rejects.toThrow("could not find ghcr.io/owner/game:1.2");
    expect(await readFile(path.join(directory, "game.yaml"), "utf8")).toBe(manifest({ reference: "ghcr.io/owner/game:1.2.3" }));
  });
});
