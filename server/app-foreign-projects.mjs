/**
 * Compose projects on this server that BoxPilot did not create (helper side, runs as root): listed
 * from `docker compose ls`, and started, stopped, restarted or read from with their own files.
 */

/**
 * Foreign compose projects for the generic deployer (app-helper.mjs), through its Docker runner.
 *
 * @param {{
 *   docker: (args: string[], options?: Record<string, any>) => ReturnType<typeof import("./exec.mjs").fixedRun>,
 *   redact: (value: unknown) => string,
 * }} dependencies
 */
export function createForeignProjects({ docker, redact }) {
  /**
   * Compose projects on this server that BoxPilot did not create (M3.10): a stack somebody
   * started by hand in /opt or a home directory. Listed so the catalog page tells the whole
   * truth about the machine; managing them is a later, separate step.
   */
  async function foreignProjects() {
    const result = await docker(["compose", "ls", "--all", "--format", "json"], { timeout: 30_000 });
    if (!result.ok) return { available: false, projects: [] };
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return { available: false, projects: [] }; }
    if (!Array.isArray(parsed)) return { available: false, projects: [] };
    const projects = parsed
      // BoxPilot's own stacks are not "foreign": the per-app projects are bp-*, and a
      // compose-deployed controller's own project is "boxpilot".
      .filter((entry) => typeof entry?.Name === "string" && !entry.Name.startsWith("bp-") && entry.Name !== "boxpilot")
      .map((entry) => ({ name: entry.Name, status: entry.Status ?? "unknown", configFiles: typeof entry.ConfigFiles === "string" ? entry.ConfigFiles.split(",").map((file) => file.trim()) : [] }));
    return { available: true, projects };
  }

  /**
   * A foreign compose project resolved from `docker compose ls`, or null. The name is looked up
   * against what compose actually reports rather than trusted from the caller, so nothing can be
   * run against an arbitrary path, and BoxPilot's own projects are never treated as foreign.
   */
  async function resolveForeignProject(name) {
    if (typeof name !== "string" || !name.length || name.startsWith("bp-") || name === "boxpilot") return null;
    const { available, projects } = await foreignProjects();
    if (!available) return null;
    return projects.find((project) => project.name === name) ?? null;
  }

  /** The --file arguments for a project's compose files, from its own resolved configuration. */
  function composeFileArgs(project) {
    return project.configFiles.filter((file) => typeof file === "string" && file.startsWith("/")).flatMap((file) => ["--file", file]);
  }

  /**
   * Start, stop, or restart a compose stack BoxPilot did not create (M3.10). Lifecycle only: the
   * project's own compose files are used verbatim, so this manages what is there without adopting
   * or remodelling it.
   */
  async function foreignProjectAction({ name, action }, { progress = null } = {}) {
    if (!["start", "stop", "restart"].includes(action)) throw new Error("action must be start, stop, or restart");
    const project = await resolveForeignProject(name);
    if (!project) throw new Error(`No compose project named ${name} was found (BoxPilot's own apps are managed from their cards)`);
    const files = composeFileArgs(project);
    if (!files.length) throw new Error(`${name} does not report a compose file, so BoxPilot cannot act on it`);
    progress?.(`${action} ${name}...`, "stdout");
    const result = await docker(["compose", "--project-name", name, ...files, action], { timeout: 5 * 60_000, progress });
    if (!result.ok) throw new Error(`docker compose ${action} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    return { name, action, done: true };
  }

  /** Tail a foreign project's logs, the same read the app cards offer for managed apps. */
  async function foreignProjectLogs({ name, lines = 200 }) {
    const project = await resolveForeignProject(name);
    if (!project) throw new Error(`No compose project named ${name} was found`);
    const files = composeFileArgs(project);
    const result = await docker(["compose", "--project-name", name, ...files, "logs", "--no-color", "--tail", String(Math.min(Math.max(Number(lines) || 200, 1), 1000))], { timeout: 30_000 });
    return { name, lines: redact(`${result.stdout}\n${result.stderr}`).split("\n").filter((line) => line.length).slice(-1000) };
  }

  return { foreignProjects, foreignProjectAction, foreignProjectLogs };
}
