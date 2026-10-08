// @vitest-environment node
/**
 * docs.search answers questions about the owner's server from the owner's documents, and leaves
 * BoxPilot's own roadmap and decision records out unless the question is about building BoxPilot:
 * the first real run searched "most important issue to focus on" and got the roadmap back.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeIndex } from "../assistant/knowledge.mjs";
import { registry } from "../ops/index.mjs";
import { aboutBuildingBoxPilot, createToolRunner, internalDocument } from "./tools.mjs";

const documents = {
  "AGENTS.md": "# Working on BoxPilot\n\n## Tests\n\nThe most important thing to focus on is that every server and platform issue has a test.\n",
  "docs/ROADMAP-V2.md": "# Roadmap\n\n## M37 Agents\n\nThe most important server and platform issue to focus on next is the agents' speed.\n\n## Focus\n\nPlatform issues: focus on the most important server work first.\n",
  "docs/DECISIONS.md": "# Decisions\n\n## ADR-005\n\nThe most important platform issue to focus on was where agents run on the server.\n",
  "docs/BACKUPS.md": "# Backups\n\n## When a backup drive fails\n\nThe most important issue on a server is a failing backup drive: replace it, then check that restores work.\n",
};
const knowledge = createKnowledgeIndex({
  registry, catalog: null, root: "/repo",
  readDirectory: async () => Object.keys(documents).filter((name) => name.startsWith("docs/")).map((name) => name.slice(5)),
  readText: async (file) => {
    const relative = path.relative("/repo", file).replaceAll("\\", "/");
    if (!(relative in documents)) throw new Error("missing");
    return documents[relative];
  },
});
const tools = createToolRunner({ state: {}, store: { listDocuments: () => [] }, registry, knowledge });
const context = { spec: { knowledge: { docs: true, registry: false, catalog: false, documents: false } }, readRole: "owner", readAs: "owner" };

describe("docs.search", () => {
  it("leaves BoxPilot's roadmap, decisions and contributors' guide out of a question about the owner's server", async () => {
    const text = await tools.run("docs.search", { query: "Most important server or platform issue to focus on within boxpilot.", limit: 4 }, context);
    expect(text).toMatch(/^## docs\/BACKUPS\.md/);
    expect(text).not.toMatch(/ROADMAP|DECISIONS|AGENTS\.md/);
  });

  it("finds them when the question is about how BoxPilot is planned or built", async () => {
    expect(await tools.run("docs.search", { query: "What is on the roadmap for M37 agents?" }, context)).toMatch(/docs\/ROADMAP-V2\.md › Roadmap › M37 Agents/);
    expect(await tools.run("docs.search", { query: "Why did ADR-005 put agents in their own service?" }, context)).toMatch(/docs\/DECISIONS\.md/);
  });

  it("knows which documents are the builders' own", () => {
    for (const file of ["AGENTS.md", "docs/ROADMAP-V2.md", "docs/DECISIONS.md", "docs/ARCHITECTURE.md", "docs/HARNESS.md", "docs/UI-PAGES.md", "docs/spikes/2026-09-unsloth-headless.md"]) expect(internalDocument({ kind: "doc", ref: { path: file } }), file).toBe(true);
    for (const file of ["docs/BACKUPS.md", "docs/RECOVERY.md", "docs/NETWORK.md"]) expect(internalDocument({ kind: "doc", ref: { path: file } }), file).toBe(false);
    expect(internalDocument({ kind: "operation", ref: { operationId: "app.backup" } })).toBe(false);
    expect(aboutBuildingBoxPilot("Most important server or platform issue to focus on within boxpilot.")).toBe(false);
    expect(aboutBuildingBoxPilot("when is the next milestone")).toBe(true);
  });
});

describe("the owner's documents (S3-2)", () => {
  const library = [{ id: "d1", title: "Router", text: "The router's admin page is at 192.168.1.1. SENTINEL-HOUSE-7.", enabled: true, characters: 60 }];
  const store = { listDocuments: () => library, findDocument: (title) => library.find((document) => document.title === title) ?? null };
  const reader = createToolRunner({ state: {}, store, registry, knowledge: null });
  const spec = { knowledge: { docs: false, registry: false, catalog: false, documents: true } };

  it("are read by the tools for the owner and operators", async () => {
    for (const readRole of ["owner", "operator"]) {
      expect(await reader.run("docs.search", { query: "router admin page" }, { spec, readRole })).toContain("SENTINEL-HOUSE-7");
      expect(await reader.run("document.read", { title: "Router" }, { spec, readRole })).toContain("SENTINEL-HOUSE-7");
    }
  });

  it("are never read for a viewer, whatever the agent's spec says", async () => {
    expect(await reader.run("docs.search", { query: "router admin page" }, { spec, readRole: "viewer" })).not.toContain("SENTINEL-HOUSE-7");
    await expect(reader.run("document.read", { title: "Router" }, { spec, readRole: "viewer" })).rejects.toThrow(/owner and operators/);
  });

  it("are not read when the owner switched them off for every agent (B1-7)", async () => {
    const sources = { docs: false, registry: false, catalog: false, documents: false };
    expect(await reader.run("docs.search", { query: "router admin page" }, { spec, sources, readRole: "owner" })).not.toContain("SENTINEL-HOUSE-7");
    await expect(reader.run("document.read", { title: "Router" }, { spec, sources, readRole: "owner" })).rejects.toThrow(/switched off/);
  });
});
