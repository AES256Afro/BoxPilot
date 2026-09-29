/**
 * The model library (M37): the small Qwen models the agents runner can serve through Unsloth, what
 * each needs, and a daily look for a newer one. Local models only; the owner chose Unsloth's GGUF
 * builds of the newest small Qwen that reads text and images.
 *
 * Sizes here are what the previews say before a download starts; the download itself takes the
 * exact sizes and checksums from Hugging Face and verifies every byte (download.mjs). Memory, and
 * the 2B's and the 9B's speeds, are the Unsloth spike's (docs/spikes/2026-09-unsloth-headless.md,
 * EPYC 7763 cores, one processor); the 4B's speed is BoxPilot's own benchmark at four threads under
 * a 400% quota on a four-processor GitHub runner (.github/workflows/agents-bench.yml), where the
 * runner's caps now put it. `measuredAt` says which. The home server is faster than either, and
 * the Usage tab shows its own measured speed once a run has gone. Tool calling 5 of 5 and chart
 * reading right for all three sizes.
 *
 * memoryBytes is what the runner's memory cap is charged for a model: its memory after a few
 * requests plus its files, which are mapped and count as the cgroup's page cache once read.
 */

/** The Unsloth release the spike measured. The runtime says when the installed one differs. */
export const testedUnslothVersion = "2026.9.12";

export const modelLibrary = Object.freeze([
  {
    id: "qwen3.5-4b",
    title: "Qwen 3.5 4B (Unsloth, 4-bit)",
    family: "qwen3.5",
    parameters: 4,
    repo: "unsloth/Qwen3.5-4B-GGUF",
    quant: "UD-Q4_K_XL",
    file: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
    projector: "mmproj-F16.gguf",
    approxBytes: 2_900_000_000,
    approxProjectorBytes: 680_000_000,
    memoryBytes: 6_200_000_000, // 2.6 GB + 3.6 GB of files
    contextTokens: 8_192,
    tokensPerSecond: 8,
    measuredAt: "4 threads (a four-processor GitHub runner)",
    vision: true,
    tools: true,
    recommended: true,
    note: "The default: the better answers of the two small ones. About 8 words a second written and 15 read at four threads on a small four-processor machine (4 written on one processor), so a digest or a triage in the background, and a question in a few minutes.",
  },
  {
    id: "qwen3.5-2b",
    title: "Qwen 3.5 2B (Unsloth, 4-bit)",
    family: "qwen3.5",
    parameters: 2,
    repo: "unsloth/Qwen3.5-2B-GGUF",
    quant: "UD-Q4_K_XL",
    file: "Qwen3.5-2B-UD-Q4_K_XL.gguf",
    projector: "mmproj-F16.gguf",
    approxBytes: 1_450_000_000,
    approxProjectorBytes: 550_000_000,
    memoryBytes: 3_700_000_000, // 1.7 GB + 2.0 GB of files
    contextTokens: 8_192,
    tokensPerSecond: 8.3,
    measuredAt: "one processor (the spike)",
    vision: true,
    tools: true,
    recommended: false,
    note: "Twice as fast as the 4B with the same tool calling and chart reading in the spike (8.3 words a second, measured on one processor): the one to choose when waiting matters more than wording.",
  },
  {
    id: "qwen3.5-9b",
    title: "Qwen 3.5 9B (Unsloth, 4-bit)",
    family: "qwen3.5",
    parameters: 9,
    repo: "unsloth/Qwen3.5-9B-GGUF",
    quant: "UD-Q4_K_XL",
    file: "Qwen3.5-9B-UD-Q4_K_XL.gguf",
    projector: "mmproj-F16.gguf",
    approxBytes: 5_900_000_000,
    approxProjectorBytes: 920_000_000,
    memoryBytes: 10_700_000_000, // 3.8 GB + 6.9 GB of files: more than the 8 GB cap
    contextTokens: 8_192,
    tokensPerSecond: 2.3,
    measuredAt: "one processor (the spike)",
    vision: true,
    tools: true,
    recommended: false,
    note: "Slow (about 2 words a second and four minutes to read a long prompt, measured on one processor), and with its 6.9 GB of files it needs more than the 8 GB memory cap: every word would read the disk. Not recommended.",
  },
]);

export const defaultModelId = modelLibrary.find((model) => model.recommended).id;

/**
 * The embedder memory search uses: Unsloth's own RAG embedder, which it starts beside the chat
 * model when /v1/embeddings is asked (the spike: 101 MB, 26 ms a text, 0.01% of a core idle,
 * 384 dimensions). The runner is offline, so it is downloaded with the chat model.
 */
export const embedderModel = Object.freeze({ repo: "unsloth/bge-small-en-v1.5-GGUF", file: "bge-small-en-v1.5-f16.gguf", approxBytes: 67_582_560, dimensions: 384 });

/** Only Unsloth's own Qwen GGUF repositories: the owner chose them, and nothing else is downloaded. */
export const repoPattern = /^unsloth\/Qwen\d+(?:\.\d+)?-\d+(?:\.\d+)?B(?:-Instruct)?-GGUF$/;
export const ggufPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.gguf$/;

/** The quantisation Unsloth's `--model repo:quant` names, from the file: "Qwen3.5-4B-UD-Q4_K_XL.gguf" is UD-Q4_K_XL. */
export function quantOf(file) {
  const match = /-((?:UD-)?(?:I?Q\d[A-Za-z0-9_]*|F16|BF16|F32))\.gguf$/i.exec(String(file ?? ""));
  return match ? match[1] : null;
}
export const modelById = (id) => modelLibrary.find((model) => model.id === id) ?? null;
export const modelIdPattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** What the Unsloth driver passes as --model: the Hugging Face repo and the quantisation. */
export const unslothModelSpec = (model) => `${model.repo}:${model.quant}`;

/**
 * The download preview: how big, and roughly how long at a typical home connection (25 MB/s)
 * and a slow one (5 MB/s). An estimate, and said to be one.
 */
export function downloadPreview(model, { fastBytesPerSecond = 25e6, slowBytesPerSecond = 5e6 } = {}) {
  const bytes = model.approxBytes + (model.projector ? model.approxProjectorBytes : 0);
  const minutes = (rate) => Math.max(1, Math.round(bytes / rate / 60));
  return { bytes, fastMinutes: minutes(fastBytesPerSecond), slowMinutes: minutes(slowBytesPerSecond), memoryBytes: model.memoryBytes };
}

/**
 * A version from a Qwen repository name: "unsloth/Qwen3.5-4B-GGUF" is 3.5 at 4B. Null for anything
 * that is not a small, general Qwen GGUF (coder, math and embedding builds are left out).
 */
export function parseQwenRepo(id) {
  const match = /^unsloth\/Qwen(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)B(?:-Instruct)?-GGUF$/i.exec(String(id ?? ""));
  if (!match) return null;
  return { version: Number(match[1]), parameters: Number(match[2]) };
}

/**
 * Whether Unsloth has published a newer small Qwen than the one in use: a later version, at most
 * `maxParameters` billion, with a vision projector among its files. `fetchJson(url)` reads Hugging
 * Face's public model API; this only reads, and never switches anything - a newer model becomes a
 * card the owner can approve (service.mjs), never an automatic change.
 */
export async function findNewerQwen({ current, fetchJson, maxParameters = 9 }) {
  const using = parseQwenRepo(current?.repo);
  if (!using) return null;
  const listing = await fetchJson("https://huggingface.co/api/models?author=unsloth&search=Qwen&sort=createdAt&direction=-1&limit=60");
  const candidates = (Array.isArray(listing) ? listing : [])
    .map((entry) => ({ repo: typeof entry?.id === "string" ? entry.id : null, parsed: parseQwenRepo(entry?.id) }))
    .filter((entry) => entry.parsed && entry.parsed.version > using.version && entry.parsed.parameters <= maxParameters)
    // The same size as the one in use first, then the largest that fits.
    .sort((a, b) => b.parsed.version - a.parsed.version || Math.abs(a.parsed.parameters - using.parameters) - Math.abs(b.parsed.parameters - using.parameters));
  for (const candidate of candidates.slice(0, 5)) {
    const detail = await fetchJson(`https://huggingface.co/api/models/${candidate.repo}`).catch(() => null);
    const files = (Array.isArray(detail?.siblings) ? detail.siblings : []).map((file) => String(file?.rfilename ?? ""));
    if (!files.some((name) => /mmproj/i.test(name))) continue;
    const gguf = files.find((name) => /UD-Q4_K_XL\.gguf$/i.test(name)) ?? files.find((name) => /Q4_K_M\.gguf$/i.test(name));
    if (!gguf) continue;
    return { repo: candidate.repo, version: candidate.parsed.version, parameters: candidate.parsed.parameters, file: gguf, projector: files.find((name) => /mmproj.*F16/i.test(name)) ?? files.find((name) => /mmproj/i.test(name)) };
  }
  return null;
}
