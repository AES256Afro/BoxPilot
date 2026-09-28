/**
 * What the assistant knows about BoxPilot itself (M34.1): its own documents, the operation registry
 * and the catalog, cut into chunks and searched by keyword (BM25), and by meaning as well when the
 * model server has an embedding model.
 *
 * Everything lives in memory. The documents and the registry change only when BoxPilot is upgraded,
 * which restarts this process, and the catalog is re-read when its manifests change, so the index is
 * built when the assistant is first used and rebuilt in part when the catalog moves on - a few
 * hundred kilobytes of text, under 3 MiB of heap, and well under a second of work. Embeddings are cached by the hash of the text they were made
 * from and by model, in memory too: the corpus is small enough to embed again after a restart in
 * the background, and a cache on disk would be one more thing to keep in step with a model the
 * owner can swap at any time.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function builtInRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    return process.cwd();
  }
}
export const repositoryRoot = builtInRoot();

/** Older documents that ADR-001 overrides where they differ (see AGENTS.md). */
const olderDocuments = new Set(["docs/INVENTORY.md", "docs/VIRTUALIZATION.md"]);

const stopwords = new Set("a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so that the their them then there these this to was we what when where which who why will with you your".split(" "));

function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Lower-cased words with a light plural stem. A dotted or hyphenated name (`apt.refresh`,
 * `pi-hole`) is kept whole as well as split, so asking for an operation by its id finds it first.
 */
export function tokenize(text) {
  const tokens = [];
  const add = (word) => { if (word.length >= 2 && !stopwords.has(word)) tokens.push(stem(word)); };
  for (const [word] of String(text ?? "").toLowerCase().matchAll(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g)) {
    if (/[.-]/.test(word)) {
      if (word.length <= 64) tokens.push(word);
      for (const part of word.split(/[.-]/)) add(part);
    } else {
      add(word);
    }
  }
  return tokens;
}

const slug = (text) => String(text).toLowerCase().replace(/[`*_[\]()]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "top";
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

/** Split text into pieces of at most `maxChars`, at paragraphs, then bullets, then sentences. */
function pieces(content, maxChars) {
  const blocks = content.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/).map((block) => block.trim()).filter(Boolean);
  const units = blocks.flatMap((block) => {
    if (block.length <= maxChars) return [block];
    const sentences = block.split(/(?<=[.!?])\s+/);
    const cut = [];
    for (const sentence of sentences) {
      for (let from = 0; from < sentence.length; from += maxChars) cut.push(sentence.slice(from, from + maxChars));
    }
    return cut;
  });
  const out = [];
  let current = "";
  for (const unit of units) {
    const joined = current ? `${current}\n${unit}` : unit;
    if (joined.length > maxChars && current) { out.push(current); current = unit; } else current = joined;
  }
  if (current) out.push(current);
  return out;
}

/**
 * A Markdown document as chunks, one per heading (levels 1-4), longer sections cut further. Each
 * chunk carries its file, the heading it sits under, and the headings above that as its title.
 */
export function chunkMarkdown(relativePath, text, { maxChars = 1200 } = {}) {
  const lines = String(text ?? "").replaceAll("\r\n", "\n").split("\n");
  const sections = [];
  let stack = [];
  let body = [];
  let fenced = false;
  const flush = () => {
    const content = body.join("\n").trim();
    if (content) sections.push({ headings: stack.filter(Boolean), content });
    body = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) { body.push(line); continue; }
    flush();
    const level = heading[1].length;
    stack = stack.slice(0, level - 1);
    stack[level - 1] = heading[2].replace(/[`*_]/g, "").trim();
  }
  flush();
  const seen = new Map();
  const older = olderDocuments.has(relativePath);
  return sections.flatMap(({ headings, content }) => {
    const heading = headings.at(-1) ?? path.basename(relativePath);
    const base = `doc:${relativePath}#${slug(heading)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count ? `${base}-${count + 1}` : base;
    const parts = pieces(content, maxChars);
    return parts.map((part, index) => ({
      id: parts.length > 1 ? `${id}~${index + 1}` : id,
      kind: "doc",
      title: `${relativePath}${headings.length ? ` › ${headings.join(" › ")}` : ""}${older ? " (older document; ADR-001 wins where they differ)" : ""}`,
      ref: { path: relativePath, heading },
      text: part,
      weight: older ? 0.7 : 1,
    }));
  });
}

function describeField(name, field) {
  const details = [field?.type ?? "string"];
  if (field?.optional) details.push("optional");
  if (field?.nullable) details.push("may be null");
  if (Array.isArray(field?.enum)) details.push(`one of ${field.enum.slice(0, 12).join(", ")}`);
  if (field?.secret || field?.secretEnvOf) details.push("carries secrets");
  return `${name} (${details.join(", ")})`;
}

/** One chunk per registered operation: what it does, its tier, who may run it, its parameters. */
export function operationChunks(registry) {
  return registry.list().map((operation) => {
    const fields = Object.entries(operation.parameters?.fields ?? {}).map(([name, field]) => describeField(name, field));
    const who = operation.minimumRole === "owner" || operation.risk === "high" ? "the owner" : operation.minimumRole === "operator" || !operation.readOnly ? "an operator or the owner" : "anyone signed in";
    return {
      id: `op:${operation.id}`,
      kind: "operation",
      title: `Operation ${operation.id}: ${operation.title}`,
      ref: { operationId: operation.id },
      text: [
        `Operation id: ${operation.id}`,
        `Title: ${operation.title}`,
        `Risk tier: ${operation.risk}`,
        operation.readOnly ? "Read-only: it looks and changes nothing." : "Changes the server when a person approves it.",
        `Who may run it: ${who}`,
        operation.elevatedOnly ? "Reveals secrets, so it needs the password again." : null,
        `Parameters: ${fields.length ? fields.join("; ") : "none"}`,
        operation.description ? `What it does: ${operation.description}` : null,
      ].filter(Boolean).join("\n"),
      weight: 1,
    };
  });
}

/** One chunk per catalog app: its name, what it is, its ports and its notes. */
export function catalogChunks(manifests) {
  return (manifests ?? []).map((manifest) => {
    const ports = (manifest.ports ?? []).map((port) => `${port.label ?? port.id} ${port.host ?? port.container ?? ""}`.trim());
    return {
      id: `app:${manifest.id}`,
      kind: "app",
      title: `App ${manifest.name ?? manifest.id} (${manifest.id})`,
      ref: { appId: manifest.id },
      text: [
        `App: ${manifest.name ?? manifest.id} (catalog id ${manifest.id})${manifest.category ? `, category ${manifest.category}` : ""}`,
        manifest.description ?? null,
        ports.length ? `Ports: ${ports.join(", ")}` : null,
        manifest.notes ? `Notes: ${manifest.notes}` : null,
      ].filter(Boolean).join("\n"),
      weight: 1,
    };
  });
}

/**
 * A BM25 index over chunks. `search(tokens)` answers a Map of chunk index to score.
 *
 * The postings live in three typed arrays, not an array of [chunk, count] pairs per term: the index
 * is held for the life of the process, and ~50,000 two-element arrays for BoxPilot's own documents
 * kept 5.5 MiB of heap where these keep well under one. Each term's postings are in chunk order, as
 * before, so scores add up in the same order and come out the same.
 */
export function createBm25(chunks, { k1 = 1.2, b = 0.75 } = {}) {
  const building = new Map(); // term -> [chunk, count, chunk, count, ...], dropped once packed
  const lengths = Float64Array.from(chunks, (chunk, index) => {
    const tokens = tokenize(`${chunk.title}\n${chunk.text}`);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) {
      let list = building.get(token);
      if (!list) building.set(token, (list = []));
      list.push(index, count);
    }
    return tokens.length;
  });
  const termIds = new Map();
  const starts = new Uint32Array(building.size + 1);
  let total = 0;
  for (const list of building.values()) total += list.length / 2;
  const postingChunks = new Uint32Array(total);
  const postingCounts = new Uint32Array(total);
  let at = 0;
  for (const [token, list] of building) {
    starts[termIds.size] = at;
    termIds.set(token, termIds.size);
    for (let position = 0; position < list.length; position += 2) {
      postingChunks[at] = list[position];
      postingCounts[at] = list[position + 1];
      at += 1;
    }
  }
  starts[termIds.size] = at;
  building.clear();
  const average = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length);
  function search(queryTokens) {
    const scores = new Map();
    for (const token of new Set(queryTokens)) {
      const id = termIds.get(token);
      if (id === undefined) continue;
      const from = starts[id];
      const to = starts[id + 1];
      const idf = Math.log(1 + (chunks.length - (to - from) + 0.5) / (to - from + 0.5));
      for (let position = from; position < to; position += 1) {
        const index = postingChunks[position];
        const count = postingCounts[position];
        const score = idf * ((count * (k1 + 1)) / (count + k1 * (1 - b + b * (lengths[index] / average))));
        scores.set(index, (scores.get(index) ?? 0) + score * (chunks[index].weight ?? 1));
      }
    }
    return scores;
  }
  return { search, terms: termIds.size, postings: total };
}

const normalize = (vector) => {
  const length = Math.hypot(...vector) || 1;
  return Float32Array.from(vector, (value) => value / length);
};
const dot = (a, b) => { let sum = 0; for (let index = 0; index < Math.min(a.length, b.length); index += 1) sum += a[index] * b[index]; return sum; };

/**
 * Embeddings by model and content hash, bounded by count and by bytes; the oldest go first.
 *
 * A count alone did not bound the memory: a vector's size is the model's, so 8,192 of them were
 * 24 MiB from a 768-wide model and 128 MiB from a 4,096-wide one. The corpus is under a thousand
 * chunks, so these limits still hold a whole corpus under any common embedding model, with room
 * for most of the one before a switch.
 */
export const embeddingCacheLimits = Object.freeze({ maxEntries: 4096, maxBytes: 32 * 1024 * 1024 });

export function createEmbeddingCache({ maxEntries = embeddingCacheLimits.maxEntries, maxBytes = embeddingCacheLimits.maxBytes } = {}) {
  const vectors = new Map();
  let bytes = 0;
  const key = (model, hash) => `${model}\u0000${hash}`;
  const drop = (name) => {
    const held = vectors.get(name);
    if (!held) return;
    bytes -= held.byteLength;
    vectors.delete(name);
  };
  return {
    get: (model, hash) => vectors.get(key(model, hash)) ?? null,
    set(model, hash, vector) {
      const name = key(model, hash);
      drop(name);
      const stored = normalize(vector);
      vectors.set(name, stored);
      bytes += stored.byteLength;
      while (vectors.size > 1 && (vectors.size > maxEntries || bytes > maxBytes)) drop(vectors.keys().next().value);
    },
    count: (model) => [...vectors.keys()].filter((entry) => entry.startsWith(`${model}\u0000`)).length,
    get size() { return vectors.size; },
    get bytes() { return bytes; },
  };
}

/**
 * Reciprocal rank fusion of the keyword ranking and the meaning ranking: robust to the two scores
 * being on different scales, which BM25 and cosine similarity always are.
 */
export function fuseRankings(lists, { k = 60, depth = 50 } = {}) {
  const fused = new Map();
  for (const list of lists) {
    list.slice(0, depth).forEach((index, rank) => fused.set(index, (fused.get(index) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The index. `ensure()` builds it (documents and registry once, the catalog again whenever its
 * manifests change); `search()` ranks chunks for a question.
 */
export function createKnowledgeIndex({
  registry,
  catalog,
  root = repositoryRoot,
  readDirectory = readdir,
  readText = (file) => readFile(file, "utf8"),
  embeddings = createEmbeddingCache(),
  now = () => new Date(),
} = {}) {
  let staticChunks = null;
  let staticLoad = null;
  let catalogSignature = null;
  let appChunks = [];
  let chunks = [];
  let bm25 = createBm25([]);
  let documents = [];
  let builtAt = null;
  let problems = [];

  async function loadStatic() {
    const found = [];
    const failed = [];
    let names = [];
    try {
      names = (await readDirectory(path.join(root, "docs"))).filter((name) => typeof name === "string" && /^[A-Za-z0-9._-]+\.md$/.test(name)).sort().map((name) => `docs/${name}`);
    } catch {
      failed.push("docs");
    }
    const docChunks = [];
    for (const relative of ["AGENTS.md", ...names]) {
      try {
        const text = await readText(path.join(root, relative));
        docChunks.push(...chunkMarkdown(relative, text));
        found.push(relative);
      } catch {
        failed.push(relative);
      }
    }
    documents = found;
    problems = failed;
    return [...docChunks, ...(registry ? operationChunks(registry) : [])];
  }

  function rebuild() {
    chunks = [...staticChunks, ...appChunks].map((chunk) => ({ ...chunk, hash: chunk.hash ?? hashOf(`${chunk.title}\n${chunk.text}`) }));
    bm25 = createBm25(chunks);
    builtAt = now().toISOString();
  }

  async function ensure() {
    if (!staticChunks) {
      staticLoad ??= loadStatic().then((loaded) => { staticChunks = loaded; }, (error) => { staticLoad = null; throw error; });
      await staticLoad;
      rebuild();
    }
    const listed = catalog ? await catalog.all().catch(() => null) : null;
    if (listed) {
      const signature = hashOf((listed.manifests ?? []).map((manifest) => `${manifest.id}:${manifest.sha256 ?? hashOf(JSON.stringify(manifest))}`).join("\n"));
      if (signature !== catalogSignature) {
        catalogSignature = signature;
        appChunks = catalogChunks(listed.manifests);
        rebuild();
      }
    }
    return stats();
  }

  /**
   * Chunks for a question, best first. `vector` is the question's embedding under `model`; chunks
   * with a cached embedding under the same model are ranked by meaning too and the two rankings
   * are fused. Without one, it is keyword search alone. `kinds` limits the kinds considered.
   */
  function search(question, { limit = 6, kinds = null, vector = null, model = null } = {}) {
    const allowed = (index) => !kinds || kinds.includes(chunks[index].kind);
    const keyword = [...bm25.search(tokenize(question)).entries()].filter(([index]) => allowed(index)).sort((a, b) => b[1] - a[1]);
    const lists = [keyword.map(([index]) => index)];
    const similarity = new Map();
    if (vector && model) {
      const query = normalize(vector);
      for (let index = 0; index < chunks.length; index += 1) {
        if (!allowed(index)) continue;
        const cached = embeddings.get(model, chunks[index].hash);
        if (cached) similarity.set(index, dot(query, cached) * (chunks[index].weight ?? 1));
      }
      if (similarity.size) lists.push([...similarity.entries()].sort((a, b) => b[1] - a[1]).map(([index]) => index));
    }
    const keywordScore = new Map(keyword);
    const ranked = lists.length > 1 ? fuseRankings(lists) : keyword;
    return ranked.slice(0, limit).map(([index, score]) => ({ chunk: chunks[index], score, keyword: keywordScore.get(index) ?? 0, similarity: similarity.get(index) ?? null }));
  }

  /** Chunks whose embedding under `model` is not cached yet, keyword-best first when a question is given. */
  function missingEmbeddings(model, { question = null, limit = 16 } = {}) {
    const order = question ? [...bm25.search(tokenize(question)).entries()].sort((a, b) => b[1] - a[1]).map(([index]) => chunks[index]) : chunks;
    return order.filter((chunk) => !embeddings.get(model, chunk.hash)).slice(0, limit);
  }

  function get(id) {
    return chunks.find((chunk) => chunk.id === id) ?? null;
  }

  function stats(model = null) {
    const byKind = (kind) => chunks.filter((chunk) => chunk.kind === kind).length;
    return {
      chunks: chunks.length,
      documents: documents.length,
      documentChunks: byKind("doc"),
      operations: byKind("operation"),
      apps: byKind("app"),
      characters: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      terms: bm25.terms,
      embedded: model ? embeddings.count(model) : 0,
      builtAt,
      unreadable: problems,
    };
  }

  return { ensure, search, missingEmbeddings, get, stats, embeddings, chunks: () => chunks };
}
