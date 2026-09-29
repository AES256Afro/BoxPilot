/**
 * The agents runtime on the host (M37): where things live, and the reads the helper makes about
 * them. Unsloth is installed with its own installer, as the runner's user, into the runner's state
 * directory (/var/lib/boxpilot-agents/unsloth): its Studio keeps its key, its admin account and its
 * caches beside its code, as it does in the spike's image. Models live beside it in the Hugging Face
 * cache layout that `unsloth run` reads offline (hf/hub/models--<org>--<name>/...).
 *
 * Root never runs anything from there and never writes there: the helper only looks (a stat, a
 * directory listing, a link that must stay inside the cache), and downloads run as the runner's
 * user (download.mjs). The runner reports Unsloth's version itself.
 *
 * Why the runner's own child and not a container (ADR-005): the caps cover the runner and the model
 * server as one cgroup, the runner starts and stops the model with no privilege at all, and idle is
 * then no process at all; loopback-only networking is the unit's own (IPAddressDeny=any).
 */
import { lstat, readdir, readlink, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { embedderModel, ggufPattern, quantOf, repoPattern } from "./models.mjs";
import { runnerUnit } from "./caps.mjs";

export const agentsPaths = Object.freeze({
  state: process.env.BOXPILOT_AGENTS_STATE ?? "/var/lib/boxpilot-agents",
  runtime: process.env.BOXPILOT_AGENTS_RUNTIME ?? "/var/lib/boxpilot-agents/unsloth",
  token: process.env.BOXPILOT_AGENTS_TOKEN_PATH ?? "/var/lib/boxpilot/agents/runner.token",
  user: "boxpilot-agents",
});

export const cacheDirectory = (stateDir, repo) => path.join(stateDir, "hf", "hub", `models--${repo.replace("/", "--")}`);

/** A model's parameters as every agents operation takes them, checked; throws on anything else. */
export function readModelParameters({ repo, file, projector = null }) {
  // Unsloth's Qwen GGUFs, and the one embedder memory search uses: nothing else is downloaded.
  const embedder = repo === embedderModel.repo && file === embedderModel.file;
  if (!repoPattern.test(repo ?? "") && !embedder) throw new Error("Only Unsloth's Qwen GGUF repositories are downloaded");
  if (!ggufPattern.test(file ?? "") || !quantOf(file)) throw new Error("The model file must be a quantised .gguf");
  if (projector !== null && projector !== undefined && !ggufPattern.test(projector)) throw new Error("The vision projector must be a .gguf");
  return { repo, file, projector: projector ?? null, quant: quantOf(file) };
}

/**
 * Whether a file is in the cache for a repository's snapshot: its link, and the blob behind it,
 * which must be inside that repository's blobs folder - a link pointing anywhere else is not a model.
 */
export async function cachedFile(stateDir, repo, file) {
  const base = cacheDirectory(stateDir, repo);
  const blobs = path.join(base, "blobs");
  const snapshots = await readdir(path.join(base, "snapshots")).catch(() => []);
  for (const commit of snapshots) {
    if (!/^[a-f0-9]{40}$/.test(commit)) continue;
    const link = path.join(base, "snapshots", commit, file);
    const info = await lstat(link).catch(() => null);
    if (!info?.isSymbolicLink()) continue;
    const target = path.resolve(path.dirname(link), await readlink(link));
    if (path.dirname(target) !== blobs || !/^[a-f0-9]{64}$/.test(path.basename(target))) continue;
    const blob = await lstat(target).catch(() => null);
    if (blob?.isFile() && blob.size > 0) return { commit, bytes: blob.size, path: target };
  }
  return null;
}

/** Every model in the cache, as the Agents section lists them. */
export async function listCachedModels(stateDir) {
  const hub = path.join(stateDir, "hf", "hub");
  const repos = (await readdir(hub).catch(() => [])).filter((name) => /^models--unsloth--/.test(name));
  const models = [];
  for (const directory of repos.slice(0, 20)) {
    const repo = directory.replace(/^models--/, "").replace("--", "/");
    if (!repoPattern.test(repo)) continue;
    const snapshots = await readdir(path.join(hub, directory, "snapshots")).catch(() => []);
    const files = new Set();
    for (const commit of snapshots.slice(0, 5)) for (const file of await readdir(path.join(hub, directory, "snapshots", commit)).catch(() => [])) if (ggufPattern.test(file)) files.add(file);
    for (const file of files) {
      const found = await cachedFile(stateDir, repo, file);
      if (found) models.push({ repo, file, bytes: found.bytes, complete: true, projector: /mmproj/i.test(file) });
    }
  }
  return models;
}

/** What the Agents section shows about the host side: is Unsloth there, is the unit up, which models. */
export async function inspectRuntime({ run, paths = agentsPaths, systemctl = "/usr/bin/systemctl" }) {
  const binary = path.join(paths.runtime, "bin", "unsloth");
  const installed = await stat(binary).then((info) => info.isFile(), () => false);
  const show = await run(systemctl, ["show", runnerUnit, "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID"], { timeout: 10_000 }).catch(() => ({ ok: false, stdout: "" }));
  const unit = Object.fromEntries(String(show.stdout ?? "").split("\n").map((line) => line.split("=", 2)).filter((pair) => pair.length === 2));
  const free = await statfs(path.dirname(paths.state)).then((info) => info.bavail * info.bsize, () => null);
  return {
    runtime: { installed, path: binary },
    service: { unit: runnerUnit, loaded: unit.LoadState === "loaded", active: unit.ActiveState ?? "unknown", sub: unit.SubState ?? "unknown", enabled: unit.UnitFileState ?? "unknown" },
    models: await listCachedModels(paths.state),
    diskFreeBytes: free,
  };
}

/** agents.model.switch's check: the model and its projector are downloaded whole. */
export async function checkDownloaded(parameters, { paths = agentsPaths } = {}) {
  const model = readModelParameters(parameters);
  const main = await cachedFile(paths.state, model.repo, model.file);
  if (!main) throw new Error(`${model.file} is not downloaded yet: approve its download first`);
  if (model.projector && !(await cachedFile(paths.state, model.repo, model.projector))) throw new Error(`The vision projector ${model.projector} is not downloaded yet`);
  return { ...model, bytes: main.bytes, commit: main.commit };
}
