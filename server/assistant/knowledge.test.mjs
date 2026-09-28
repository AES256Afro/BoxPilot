// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCatalogService } from "../catalog/index.mjs";
import { createRegistry, defineOperation, registry as realRegistry } from "../ops/index.mjs";
import { chunkMarkdown, createBm25, createKnowledgeIndex, fuseRankings, operationChunks, repositoryRoot, tokenize } from "./knowledge.mjs";

const run = () => ({});
const smallRegistry = createRegistry([[
  defineOperation({ id: "apt.refresh", title: "Refresh package lists", risk: "low", description: "Runs apt-get update so the list of available updates is current.", run }),
  defineOperation({ id: "app.restart", title: "Restart an application", risk: "low", description: "Restarts the app's containers.", parameters: { fields: { id: { type: "string", pattern: /^[a-z0-9-]+$/ } } }, run }),
  defineOperation({ id: "app.purge", title: "Uninstall application and delete its data", risk: "high", description: "Removes the app and its data.", parameters: { fields: { id: { type: "string" } } }, run }),
  defineOperation({ id: "logs.read", title: "Read the system journal", risk: "low", readOnly: true, minimumRole: "operator", description: "Reads journal lines.", parameters: { fields: { unit: { type: "string", optional: true }, lines: { type: "number", optional: true } } }, run }),
]]);

const documents = {
  "AGENTS.md": "# Working on BoxPilot\n\nRead this before changing anything.\n\n## How to add things\n\nA new operation is one registry entry with an id, a title and a risk tier.\n",
  "docs/BACKUPS.md": "# Backups\n\n## Restore\n\nTo restore an app, open its card, pick a backup archive and approve the restore. The app is stopped while its data is put back.\n\n## Off-box copies\n\nAn off-box destination keeps a copy on another machine over SSH.\n",
  "docs/NETWORK.md": "# Network\n\n## Tailscale\n\nSign in to the tailnet so the server is reachable from your phone anywhere.\n",
  "docs/INVENTORY.md": "# Inventory\n\n## Restore\n\nAn older description of restoring, from before ADR-001.\n",
};
const readDirectory = async () => Object.keys(documents).filter((name) => name.startsWith("docs/")).map((name) => name.slice(5));
const readText = async (file) => {
  const relative = path.relative("/repo", file).replaceAll("\\", "/");
  if (!(relative in documents)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return documents[relative];
};
function catalogOf(manifests) {
  const current = { manifests };
  return { all: async () => current, get: async (id) => current.manifests.find((manifest) => manifest.id === id) ?? null, set: (next) => { current.manifests = next; } };
}
const jellyfin = { id: "jellyfin", name: "Jellyfin", category: "Media", description: "Streams your films and music to every screen in the house.", ports: [{ id: "web", label: "Web", host: 8096 }], notes: "Point it at your media folder.", sha256: "a" };

describe("tokenize", () => {
  it("keeps an operation id whole as well as in parts, and folds plurals", () => {
    const tokens = tokenize("Run apt.refresh on the servers");
    expect(tokens).toContain("apt.refresh");
    expect(tokens).toContain("apt");
    expect(tokens).toContain("refresh");
    expect(tokens).toContain("server");
    expect(tokens).not.toContain("the");
  });
});

describe("chunkMarkdown", () => {
  it("cuts by heading and names each chunk by its path through the headings", () => {
    const chunks = chunkMarkdown("docs/BACKUPS.md", documents["docs/BACKUPS.md"]);
    expect(chunks.map((chunk) => chunk.ref.heading)).toEqual(["Restore", "Off-box copies"]);
    expect(chunks[0]).toMatchObject({ id: "doc:docs/BACKUPS.md#restore", kind: "doc", title: "docs/BACKUPS.md › Backups › Restore" });
  });

  it("does not take a heading inside a code block for a section", () => {
    const chunks = chunkMarkdown("docs/X.md", "# Top\n\n```sh\n# not a heading\necho hi\n```\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("# not a heading");
  });

  it("cuts a long section into pieces under the limit, at paragraph and sentence boundaries", () => {
    const long = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} says something about backups.`).join(" ");
    const chunks = chunkMarkdown("docs/LONG.md", `# Long\n\n${long}\n\n- a bullet\n- another bullet\n`, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.text.length <= 300)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  it("marks the documents ADR-001 overrides, and weighs them less", () => {
    const [chunk] = chunkMarkdown("docs/INVENTORY.md", documents["docs/INVENTORY.md"]);
    expect(chunk.title).toContain("older document");
    expect(chunk.weight).toBeLessThan(1);
  });
});

describe("operationChunks", () => {
  it("says what each operation does, its tier, who may run it and its parameters", () => {
    const byId = Object.fromEntries(operationChunks(smallRegistry).map((chunk) => [chunk.ref.operationId, chunk.text]));
    expect(byId["app.purge"]).toContain("Risk tier: high");
    expect(byId["app.purge"]).toContain("Who may run it: the owner");
    expect(byId["logs.read"]).toContain("Read-only");
    expect(byId["logs.read"]).toContain("Who may run it: an operator or the owner");
    expect(byId["logs.read"]).toContain("unit (string, optional)");
    expect(byId["apt.refresh"]).toContain("Parameters: none");
  });
});

describe("retrieval", () => {
  async function index(manifests = [jellyfin]) {
    const catalog = catalogOf(manifests);
    const knowledge = createKnowledgeIndex({ registry: smallRegistry, catalog, root: "/repo", readDirectory, readText });
    await knowledge.ensure();
    return { knowledge, catalog };
  }

  it("ranks the section that answers the question first", async () => {
    const { knowledge } = await index();
    const [first] = knowledge.search("How do I restore an app from a backup?");
    expect(first.chunk.id).toBe("doc:docs/BACKUPS.md#restore");
  });

  it("puts the newer document above the older one that says the same thing", async () => {
    const { knowledge } = await index();
    const ids = knowledge.search("restore").map((hit) => hit.chunk.id);
    expect(ids.indexOf("doc:docs/BACKUPS.md#restore")).toBeLessThan(ids.indexOf("doc:docs/INVENTORY.md#restore"));
  });

  it("finds an operation by its id, and an app by its name", async () => {
    const { knowledge } = await index();
    expect(knowledge.search("what does apt.refresh do")[0].chunk.id).toBe("op:apt.refresh");
    expect(knowledge.search("jellyfin port")[0].chunk.id).toBe("app:jellyfin");
    expect(knowledge.search("restart", { kinds: ["operation"] }).map((hit) => hit.chunk.kind)).toEqual(["operation"]);
  });

  it("blends in meaning when embeddings are cached, finding a chunk that shares no word with the question", async () => {
    const { knowledge } = await index();
    const model = "nomic-embed-text:latest";
    // Scripted embeddings: everything points one way except the tailnet section, which points the
    // way the question does although it shares no word with it.
    for (const chunk of knowledge.chunks()) knowledge.embeddings.set(model, chunk.hash, chunk.id === "doc:docs/NETWORK.md#tailscale" ? [0, 1, 0] : [1, 0, 0]);
    const question = "Travelling abroad next month";
    expect(knowledge.search(question).map((hit) => hit.chunk.id)).not.toContain("doc:docs/NETWORK.md#tailscale");
    const [first] = knowledge.search(question, { vector: [0, 0.9, 0.1], model });
    expect(first.chunk.id).toBe("doc:docs/NETWORK.md#tailscale");
    expect(first.similarity).toBeGreaterThan(0.9);
    expect(knowledge.missingEmbeddings(model)).toEqual([]);
  });

  it("rebuilds the catalog's part when the catalog changes", async () => {
    const { knowledge, catalog } = await index();
    expect(knowledge.stats().apps).toBe(1);
    catalog.set([jellyfin, { id: "navidrome", name: "Navidrome", category: "Media", description: "A music server.", sha256: "b" }]);
    await knowledge.ensure();
    expect(knowledge.stats().apps).toBe(2);
    expect(knowledge.search("navidrome")[0].chunk.id).toBe("app:navidrome");
  });

  it("fuses rankings so an item near the top of both lists wins", () => {
    expect(fuseRankings([[1, 2, 3], [2, 3, 1]])[0][0]).toBe(2);
  });

  it("scores nothing for a question with no known word", () => {
    expect(createBm25([{ title: "a", text: "backup restore" }]).search(tokenize("zebra")).size).toBe(0);
  });
});

describe("the index of this repository", () => {
  it("holds every document, every registered operation and every catalog app", async () => {
    const catalog = createCatalogService({ directory: path.join(repositoryRoot, "catalog") });
    const knowledge = createKnowledgeIndex({ registry: realRegistry, catalog });
    const stats = await knowledge.ensure();
    const { manifests } = await catalog.all();
    expect(stats.unreadable).toEqual([]);
    expect(stats.documents).toBeGreaterThanOrEqual(10);
    expect(stats.operations).toBe(realRegistry.list().length);
    expect(stats.apps).toBe(manifests.length);
    expect(knowledge.chunks().every((chunk) => chunk.text.length <= 1200 || chunk.kind !== "doc")).toBe(true);
    expect(knowledge.search("What is ADR-003 about reads?").map((hit) => hit.chunk.ref.path)).toContain("docs/DECISIONS.md");
    // The sizes, for the record in CI's log.
    console.log(`[assistant index] ${JSON.stringify({ ...stats, builtAt: undefined })}`);
  });
});
