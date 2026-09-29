/**
 * The agents runtime on the host (M37): where things live, and the reads the helper makes about
 * them. Unsloth is installed under /opt/boxpilot-agents/unsloth, owned by root and read-only to the
 * runner; models live in the runner's state directory in the Hugging Face cache layout that
 * `unsloth run` reads offline (hub/models--<org>--<name>/{blobs,snapshots/<commit>,refs/main}).
 *
 * Why a systemd unit and not a catalog app (ADR-005): the caps must cover the runner and the model
 * server as one cgroup; the model starts and stops with demand, which a long-running container does
 * not; Unsloth's official image starts JupyterLab and SSH by default; and loopback-only networking
 * is enforced by the unit itself (IPAddressDeny=any), with no Docker in between.
 */
import { lstat, readdir, readlink, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { ggufPattern, quantOf, repoPattern } from "./models.mjs";
import { runnerUnit } from "./caps.mjs";

export const agentsPaths = Object.freeze({
  home: process.env.BOXPILOT_AGENTS_HOME ?? "/opt/boxpilot-agents",
  runtime: process.env.BOXPILOT_AGENTS_RUNTIME ?? "/opt/boxpilot-agents/unsloth",
  state: process.env.BOXPILOT_AGENTS_STATE ?? "/var/lib/boxpilot-agents",
  token: process.env.BOXPILOT_AGENTS_TOKEN_PATH ?? "/var/lib/boxpilot/agents/runner.token",
  user: "boxpilot-agents",
});

export const cacheDirectory = (stateDir, repo) => path.join(stateDir, "hf", "hub", `models--${repo.replace("/", "--")}`);

/** A model's parameters as every agents operation takes them, checked; throws on anything else. */
export function readModelParameters({ repo, file, projector = null }) {
  if (!repoPattern.test(repo ?? "")) throw new Error("Only Unsloth's Qwen GGUF repositories are downloaded");
  if (!ggufPattern.test(file ?? "") || !quantOf(file)) throw new Error("The model file must be a quantised .gguf");
  if (projector !== null && projector !== undefined && !ggufPattern.test(projector)) throw new Error("The vision projector must be a .gguf");
  return { repo, file, projector: projector ?? null, quant: quantOf(file) };
}

/** Whether a file is in the cache for a repository's current snapshot: its link and the blob behind it. */
export async function cachedFile(stateDir, repo, file) {
  const base = cacheDirectory(stateDir, repo);
  const snapshots = await readdir(path.join(base, "snapshots")).catch(() => []);
  for (const commit of snapshots) {
    const link = path.join(base, "snapshots", commit, file);
    const info = await lstat(link).catch(() => null);
    if (!info) continue;
    const target = info.isSymbolicLink() ? path.resolve(path.dirname(link), await readlink(link)) : link;
    const blob = await stat(target).catch(() => null);
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
    for (const commit of snapshots.slice(0, 5)) {
      for (const file of (await readdir(path.join(hub, directory, "snapshots", commit)).catch(() => [])).filter((name) => ggufPattern.test(name))) {
        const found = await cachedFile(stateDir, repo, file);
        if (found) models.push({ repo, file, commit, bytes: found.bytes, complete: true, projector: /mmproj/i.test(file) });
      }
    }
  }
  return models;
}

/** What the Agents section shows about the host side: is Unsloth there, is the unit up, which models. */
export async function inspectRuntime({ run, paths = agentsPaths, systemctl = "/usr/bin/systemctl" }) {
  const binary = path.join(paths.runtime, "bin", "unsloth");
  const installed = await stat(binary).then((info) => info.isFile(), () => false);
  const version = installed ? await run(binary, ["--version"], { timeout: 20_000 }).then((result) => (result.ok ? result.stdout.split("\n").pop().trim().slice(0, 80) : null), () => null) : null;
  const show = await run(systemctl, ["show", runnerUnit, "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID"], { timeout: 10_000 }).catch(() => ({ ok: false, stdout: "" }));
  const unit = Object.fromEntries(String(show.stdout ?? "").split("\n").map((line) => line.split("=", 2)).filter((pair) => pair.length === 2));
  const free = await statfs(path.dirname(paths.state)).then((info) => info.bavail * info.bsize, () => null);
  return {
    runtime: { installed, version, path: binary },
    service: { unit: runnerUnit, loaded: unit.LoadState === "loaded", active: unit.ActiveState ?? "unknown", sub: unit.SubState ?? "unknown", enabled: unit.UnitFileState ?? "unknown" },
    models: (await listCachedModels(paths.state)).map(({ repo, file, bytes, complete, projector }) => ({ repo, file, bytes, complete, projector })),
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
