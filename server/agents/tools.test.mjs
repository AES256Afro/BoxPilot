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
    for (const file of ["AGENTS.md", "docs/ROADMAP-V2.md", "docs/DECISIONS.md", "docs/ARCHITECTURE.md", "docs/UI-PAGES.md", "docs/spikes/2026-09-unsloth-headless.md"]) expect(internalDocument({ kind: "doc", ref: { path: file } }), file).toBe(true);
    for (const file of ["docs/BACKUPS.md", "docs/RECOVERY.md", "docs/NETWORK.md"]) expect(internalDocument({ kind: "doc", ref: { path: file } }), file).toBe(false);
    expect(internalDocument({ kind: "operation", ref: { operationId: "app.backup" } })).toBe(false);
    expect(aboutBuildingBoxPilot("Most important server or platform issue to focus on within boxpilot.")).toBe(false);
    expect(aboutBuildingBoxPilot("when is the next milestone")).toBe(true);
  });
});
