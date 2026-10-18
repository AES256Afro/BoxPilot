/**
 * Language models an app runs (helper side, runs as root): listing, downloading and removing them
 * inside the app's model runner container (a manifest's `modelRunner`, Ollama's CLI).
 */

/** "4.7 GB" as bytes. Ollama prints powers of 1000, the way the Docker CLI does. */
function parseModelSize(text) {
  const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(String(text ?? "").trim());
  if (!match) return 0;
  const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[match[2].toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

/**
 * Model management for the generic deployer (app-helper.mjs), through its own compose step.
 *
 * @param {{
 *   ensureManifest: (id: string) => Promise<any>,
 *   readState: (id: string) => Promise<any>,
 *   containerStatus: (id: string) => Promise<any>,
 *   compose: (id: string, args: string[], options?: { progress?: ((line: string, stream: string) => void) | null, timeout?: number }) => ReturnType<typeof import("./exec.mjs").fixedRun>,
 *   redact: (value: unknown) => string,
 *   scaled: (ms: number, timeScale?: number) => number,
 *   stepTimedOut: (result: any, step: string, budgetMs: number) => Error | null,
 * }} dependencies
 */
export function createAppModels({ ensureManifest, readState, containerStatus, compose, redact, scaled, stepTimedOut }) {
  /**
   * Language models an app has downloaded, and the two things you want to do with them.
   *
   * These live outside install on purpose. A large model is tens of gigabytes: pulling one inside
   * `app.install` meant a silent wait against a socket that gives up after twenty-five idle
   * minutes, so the download that most needed patience was the one guaranteed to fail. Here it is
   * an operation of its own, with its own budget and its output streamed as it goes.
   */
  function modelService(manifest) {
    if (!manifest.modelRunner) throw new Error(`${manifest.name} does not manage models`);
    return manifest.modelRunner.service;
  }

  /**
   * Models are read and written by running a command inside the container, which Docker refuses
   * unless it is running. It refuses quickly and with a message naming a container id, so the
   * check is here purely to say something the owner can act on instead.
   */
  async function readyForModels(id, manifest) {
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const status = await containerStatus(id);
    if (status.status === "paused") throw new Error(`${manifest.name} is paused. Resume it before changing its models`);
    if (!status.running) throw new Error(`${manifest.name} is not running. Start it before changing its models`);
  }

  /** `ollama list` as rows. Columns are separated by runs of spaces; SIZE and MODIFIED contain single ones. */
  function parseModelList(stdout) {
    const lines = String(stdout ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
    const models = [];
    for (const line of lines) {
      const columns = line.trim().split(/\s{2,}/);
      if (columns.length < 3 || columns[0] === "NAME") continue;
      const [name, id, size, modified = ""] = columns;
      models.push({ name, id, size, modified, bytes: parseModelSize(size) });
    }
    return models;
  }

  async function listModels({ id }) {
    const manifest = await ensureManifest(id);
    // Listing is a read the panel makes on open, so a stopped app is reported rather than thrown:
    // "start it first" belongs in the panel, not in an error dialog the owner did not ask for.
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const status = await containerStatus(id);
    if (status.status === "paused") return { id, available: false, models: [], totalBytes: 0, reason: `${manifest.name} is paused. Resume it to see its models` };
    if (!status.running) return { id, available: false, models: [], totalBytes: 0, reason: `${manifest.name} is not running. Start it to see its models` };
    const result = await compose(id, ["exec", "-T", modelService(manifest), "ollama", "list"], { timeout: 60_000 });
    // A runner that is still starting has no answer yet, which is not a failure worth an error page.
    if (!result.ok) return { id, available: false, models: [], totalBytes: 0, reason: redact(result.stderr).split("\n").filter(Boolean).slice(-1)[0] ?? "the model runner is not answering yet" };
    const models = parseModelList(result.stdout);
    return { id, available: true, models, totalBytes: models.reduce((sum, model) => sum + model.bytes, 0), reason: null };
  }

  async function pullModel({ id, model }, { progress = null, timeScale = 1 } = {}) {
    const manifest = await ensureManifest(id);
    await readyForModels(id, manifest);
    progress?.(`Downloading ${model}. Large models are tens of gigabytes; this can take a while.`, "stdout");
    // Two hours: a 20 GB model over a domestic line is comfortably an hour, and the alternative is
    // a download that dies near the end with nothing to show for it. A slower line gets more time
    // from "Try again with more time", which scales this with the job's budget.
    const pullBudgetMs = scaled(120 * 60_000, timeScale);
    const result = await compose(id, ["exec", "-T", modelService(manifest), "ollama", "pull", model], { timeout: pullBudgetMs, progress });
    const ranOut = stepTimedOut(result, `Downloading ${model}`, pullBudgetMs);
    if (ranOut) throw ranOut;
    if (!result.ok) throw new Error(`Could not download ${model}: ${redact(result.stderr).split("\n").filter(Boolean).slice(-2).join(" ") || "the model runner refused"}`);
    return { id, model, pulled: true, models: parseModelList((await compose(id, ["exec", "-T", modelService(manifest), "ollama", "list"], { timeout: 60_000 })).stdout) };
  }

  async function removeModel({ id, model }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    await readyForModels(id, manifest);
    const result = await compose(id, ["exec", "-T", modelService(manifest), "ollama", "rm", model], { timeout: 5 * 60_000, progress });
    if (!result.ok) throw new Error(`Could not remove ${model}: ${redact(result.stderr).split("\n").filter(Boolean).slice(-2).join(" ") || "the model runner refused"}`);
    return { id, model, removed: true };
  }

  return { listModels, pullModel, removeModel, parseModelList };
}
