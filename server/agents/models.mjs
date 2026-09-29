/**
 * The model library (M37): the small Qwen models the agents runner can serve through Unsloth, what
 * each needs, and a daily look for a newer one. Local models only; the owner chose Unsloth's GGUF
 * builds of the newest small Qwen that reads text and images.
 *
 * Sizes here are what the previews say before a download starts; the download itself takes the
 * exact sizes and checksums from Hugging Face and verifies every byte (server/tasks/agents.mjs).
 * The Unsloth spike (spike/unsloth-headless) measures load time and speed on CPU; until its results
 * land, the defaults below are its starting point: Qwen 3.5 4B at UD-Q4_K_XL with the F16 vision
 * projector, an 8k context and two threads.
 */

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
    memoryBytes: 5 * 1024 ** 3,
    contextTokens: 8_192,
    vision: true,
    tools: true,
    recommended: true,
    note: "The default: fits the runner's 8 GB memory cap with room for an 8k context.",
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
    memoryBytes: 9 * 1024 ** 3,
    contextTokens: 8_192,
    vision: true,
    tools: true,
    recommended: false,
    note: "Better answers, about twice as slow on a CPU, and it needs the memory cap raised above 8 GB.",
  },
]);

export const defaultModelId = modelLibrary.find((model) => model.recommended).id;

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
