// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../server/catalog/index.mjs";
import { applyUpdates, findUpdates, isOwnedImage, newestRelease, pullRequestBody, pullRequestTitle, retag, shapeChanges } from "./catalog-update-images.mjs";

const manifest = ({ id = "game", reference = "ghcr.io/owner/game:1.2.3", version = "1.2.3", sidecar } = {}) => [
  "schemaVersion: 2",
  `id: ${id}`,
  "name: Game",
  "category: Games",
  'description: "A test app."',
  "image:",
  "  # pinned by the owner's release workflow",
  `  reference: ${reference}`,
  `  version: "${version}"`,
  "ports:",
  "  - id: web",
  "    label: Game",
  "    container: 8080",
  "    host: 8139",
  "    exposure: lan",
  ...(sidecar ? ["sidecars:", "  - id: worker", `    image: ${sidecar}`] : []),
  "",
].join("\n");

const shape = (overrides = {}) => ({ platforms: ["linux/amd64", "linux/arm64"], user: "101", ports: ["8080/tcp"], volumes: [], healthcheck: "CMD-SHELL wget -qO- http://127.0.0.1:8080/healthz", ...overrides });

describe("choosing the newest release", () => {
  it("compares numerically and ignores anything that is not a plain release", () => {
    const tags = ["latest", "sha-abc123", "1.2.3", "1.2.10", "1.10.0-rc.1", "1.9.9", "v2.0.0", "main"];
    expect(newestRelease(tags, "1.2.3")).toBe("1.9.9");
    expect(newestRelease(["0.9.0", "0.10.0"], "0.9.0")).toBe("0.10.0");
  });

  it("keeps the v prefix the manifest already uses", () => {
    expect(newestRelease(["1.5.0", "v1.4.0"], "v1.3.0")).toBe("v1.4.0");
    expect(newestRelease(["v1.5.0"], "1.3.0")).toBeNull();
  });

  it("does nothing when the pin is current or is not a release tag", () => {
    expect(newestRelease(["1.2.3", "1.2.2"], "1.2.3")).toBeNull();
    expect(newestRelease(["1.2.3"], "latest")).toBeNull();
    expect(newestRelease(["2026.9.1"], "RELEASE.2026-08-04T00-00-00Z")).toBeNull();
  });
});

describe("which images are followed", () => {
  it("follows only the owner's own GHCR images, pinned by tag", () => {
    expect(isOwnedImage("ghcr.io/owner/game:1.0.0", "Owner")).toBe(true);
    expect(isOwnedImage("ghcr.io/someone-else/game:1.0.0", "owner")).toBe(false);
    expect(isOwnedImage("ghcr.io/owner/game@sha256:" + "a".repeat(64), "owner")).toBe(false);
    expect(isOwnedImage("owner/game:1.0.0", "owner")).toBe(false);
    expect(isOwnedImage("ghcr.io/owner/game:1.0.0", "")).toBe(false);
  });
});

describe("rewriting a manifest", () => {
  it("moves the reference and its version line and leaves comments and layout alone", () => {
    const text = manifest();
    const next = retag(text, { repo: "ghcr.io/owner/game", from: "1.2.3", to: "1.3.0", main: true, version: "1.2.3" });
    expect(next).toBe(text.replace("game:1.2.3", "game:1.3.0").replace('version: "1.2.3"', 'version: "1.3.0"'));
    expect(next).toContain("# pinned by the owner's release workflow");
  });

  it("works on a Windows checkout with CRLF line endings", () => {
    const text = manifest().replace(/\n/g, "\r\n");
    const next = retag(text, { repo: "ghcr.io/owner/game", from: "1.2.3", to: "1.3.0", main: true, version: "1.2.3" });
    expect(next).toContain('version: "1.3.0"\r\n');
    expect(next).toContain("game:1.3.0\r\n");
  });

  it("does not touch a longer tag that starts with the same digits", () => {
    const text = manifest({ reference: "ghcr.io/owner/game:1.2.30", version: "1.2.30" });
    expect(retag(text, { repo: "ghcr.io/owner/game", from: "1.2.3", to: "1.3.0", main: true, version: "1.2.3" })).toBe(text);
  });

  it("moves a sidecar's image without touching the main image's version", () => {
    const text = manifest({ reference: "docker.io/library/nginx:1.29.0", version: "1.29.0", sidecar: "ghcr.io/owner/worker:0.4.0" });
    const next = retag(text, { repo: "ghcr.io/owner/worker", from: "0.4.0", to: "0.5.0", main: false, version: "1.29.0" });
    expect(next).toContain("image: ghcr.io/owner/worker:0.5.0");
    expect(next).toContain('version: "1.29.0"');
  });
});

describe("comparing image shapes", () => {
  it("says nothing when the images match and names each difference when they do not", () => {
    expect(shapeChanges(shape(), shape())).toEqual([]);
    expect(shapeChanges(shape(), shape({ ports: ["8080/tcp", "9090/tcp"], user: "root" }))).toEqual([
      "user: 101 → root",
      "exposed ports: 8080/tcp → 8080/tcp, 9090/tcp",
    ]);
  });
});

describe("finding updates", () => {
  const fakeClients = (registry) => (reference) => {
    const repo = reference.slice(0, reference.lastIndexOf(":"));
    const entry = registry[repo];
    return {
      async tags() {
        if (entry.error) throw new Error(entry.error);
        return entry.tags;
      },
      async shape(tag) {
        return entry.shapes?.[tag] ?? shape();
      },
    };
  };

  it("finds owned main and sidecar images, flags a major move, and records lookups that failed", async () => {
    const manifests = [
      { id: "game", name: "Game", file: "game.yaml", image: { reference: "ghcr.io/owner/game:1.2.3", version: "1.2.3" } },
      { id: "stack", name: "Stack", file: "stack.yaml", image: { reference: "docker.io/library/nginx:1.29.0", version: "1.29.0" }, sidecars: [{ id: "worker", image: "ghcr.io/owner/worker:0.4.0" }] },
      { id: "notes", name: "Notes", file: "notes.yaml", image: { reference: "ghcr.io/owner/notes:1.0.0", version: "1.0.0" } },
      { id: "third", name: "Third", file: "third.yaml", image: { reference: "ghcr.io/upstream/tool:1.0.0", version: "1.0.0" } },
    ];
    const registry = {
      "ghcr.io/owner/game": { tags: ["1.2.3", "2.0.0", "latest"], shapes: { "2.0.0": shape({ volumes: ["/data"] }) } },
      "ghcr.io/owner/worker": { tags: ["0.4.0", "0.5.0"] },
      "ghcr.io/owner/notes": { error: "https://ghcr.io/v2/owner/notes/tags/list answered HTTP 503" },
    };
    const { updates, failures } = await findUpdates(manifests, "owner", { clientFor: fakeClients(registry) });
    expect(updates).toEqual([
      expect.objectContaining({ id: "game", from: "1.2.3", to: "2.0.0", main: true, changes: ["new major version", "volumes: none → /data"] }),
      expect.objectContaining({ id: "stack", repo: "ghcr.io/owner/worker", from: "0.4.0", to: "0.5.0", main: false, sidecar: "worker", changes: [] }),
    ]);
    expect(failures).toEqual([{ id: "notes", reference: "ghcr.io/owner/notes:1.0.0", error: "https://ghcr.io/v2/owner/notes/tags/list answered HTTP 503" }]);
  });

  it("still offers the move when the pinned image can no longer be inspected", async () => {
    const manifests = [{ id: "game", name: "Game", file: "game.yaml", image: { reference: "ghcr.io/owner/game:1.2.3", version: "1.2.3" } }];
    const clientFor = () => ({
      tags: async () => ["1.2.3", "1.2.4"],
      shape: async (tag) => { if (tag === "1.2.3") throw new Error("HTTP 404"); return shape(); },
    });
    const { updates } = await findUpdates(manifests, "owner", { clientFor });
    expect(updates[0]).toMatchObject({ to: "1.2.4", changes: ["could not compare image shapes: HTTP 404"] });
  });
});

describe("writing updates into the catalog", () => {
  let directory;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-catalog-update-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes every move and leaves a catalog that still validates with the new pins", async () => {
    await writeFile(path.join(directory, "game.yaml"), manifest());
    await writeFile(path.join(directory, "stack.yaml"), manifest({ id: "stack", reference: "docker.io/library/nginx:1.29.0", version: "1.29.0", sidecar: "ghcr.io/owner/worker:0.4.0" }));
    await applyUpdates([
      { file: "game.yaml", repo: "ghcr.io/owner/game", from: "1.2.3", to: "1.3.0", main: true, version: "1.2.3" },
      { file: "stack.yaml", repo: "ghcr.io/owner/worker", from: "0.4.0", to: "0.5.0", main: false, version: "1.29.0" },
    ], directory);
    const { manifests, problems } = await loadCatalog({ directory });
    expect(problems).toEqual([]);
    expect(manifests.find((entry) => entry.id === "game").image).toMatchObject({ reference: "ghcr.io/owner/game:1.3.0", version: "1.3.0" });
    expect(manifests.find((entry) => entry.id === "stack").sidecars[0].image).toBe("ghcr.io/owner/worker:0.5.0");
    expect(manifests.find((entry) => entry.id === "stack").image.version).toBe("1.29.0");
  });

  it("refuses when the pin it was asked to move is not in the file", async () => {
    await writeFile(path.join(directory, "game.yaml"), manifest());
    await expect(applyUpdates([{ file: "game.yaml", repo: "ghcr.io/owner/game", from: "1.2.2", to: "1.3.0", main: true, version: "1.2.2" }], directory))
      .rejects.toThrow("could not find ghcr.io/owner/game:1.2.2");
    expect(await readFile(path.join(directory, "game.yaml"), "utf8")).toBe(manifest());
  });
});

describe("the pull request", () => {
  const update = (name, to, extra = {}) => ({ name, to, from: "1.0.0", repo: `ghcr.io/owner/${name.toLowerCase()}`, changes: [], ...extra });

  it("names up to three moves in the title and counts beyond that", () => {
    expect(pullRequestTitle([update("Game", "1.3.0")])).toBe("Update Game catalog image to 1.3.0");
    expect(pullRequestTitle([update("Game", "1.3.0"), update("Stack", "0.5.0", { sidecar: "worker" })])).toBe("Update catalog images: Game 1.3.0, Stack (worker) 0.5.0");
    expect(pullRequestTitle(["A", "B", "C", "D"].map((name) => update(name, "2.0.0")))).toBe("Update 4 catalog images");
  });

  it("lists what needs a look and what could not be checked", () => {
    const body = pullRequestBody([update("Game", "2.0.0", { changes: ["new major version"] })], [{ id: "notes", reference: "ghcr.io/owner/notes:1.0.0", error: "HTTP 503" }], "owner");
    expect(body).toContain("| Game | `ghcr.io/owner/game` | 1.0.0 | 2.0.0 | new major version |");
    expect(body).toContain("- notes: `ghcr.io/owner/notes:1.0.0`: HTTP 503");
    expect(body).toContain("next BoxPilot release");
  });
});
