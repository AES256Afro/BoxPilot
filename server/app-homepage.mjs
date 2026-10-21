/**
 * Homepage sync (helper side, runs as root): the "BoxPilot" group in Homepage's services.yaml,
 * listing every installed catalog app, written on request and refreshed after an install or an
 * uninstall.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { readFileWithoutFollowing, replaceFileWithoutFollowing } from "./durable-file.mjs";
import { parseServeStatus } from "./tailscale-serve.mjs";
import { projectNameFor } from "./catalog/compose.mjs";

/** Where Homepage sync remembers the address its links are written for, in Homepage's own folder. */
export const homepageSyncFile = "boxpilot-homepage-sync.json";

/**
 * Homepage sync for the generic deployer (app-helper.mjs), reading each app's saved state the way
 * the deployer does.
 *
 * @param {{
 *   catalog: ReturnType<typeof import("./catalog/index.mjs").createCatalogService>,
 *   readState: (id: string) => Promise<any>,
 *   dirFor: (id: string) => string,
 *   runCommand: typeof import("./exec.mjs").fixedRun,
 *   tailscaleBinary: string,
 *   clock: () => Date,
 * }} dependencies
 */
export function createAppHomepage({ catalog, readState, dirFor, runCommand, tailscaleBinary, clock }) {
  const homepageGroup = "BoxPilot";
  const homepageHostPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

  /** Local ports Tailscale Serve publishes over HTTPS right now; empty when Tailscale is absent. */
  async function servedPorts() {
    const result = await runCommand(tailscaleBinary, ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    return new Set(result.ok ? parseServeStatus(result.stdout).map((entry) => entry.port) : []);
  }

  /**
   * M8.2: write a "BoxPilot" group into Homepage's services.yaml listing every installed
   * catalog app (link, description, dashboard icon, live container status through the
   * read-only Docker socket Homepage already mounts). Other groups the operator wrote are
   * kept. `host` is what the browser should use to reach this server; it is remembered so
   * installs and uninstalls can refresh the dashboard without asking again.
   */
  /** @param {{ host?: string }} [request] @param {{ progress?: ((line: string, stream: string) => void) | null }} [options] */
  async function syncHomepage({ host } = {}, { progress = null } = {}) {
    const homepage = await catalog.get("homepage");
    if (!homepage) throw new Error("Homepage is not in the catalog");
    const homepageState = await readState("homepage");
    if (!homepageState?.installed) throw new Error("Homepage is not installed");
    const rememberedPath = path.join(dirFor("homepage"), homepageSyncFile);
    const remembered = await readFileWithoutFollowing(rememberedPath).then(JSON.parse).catch(() => null);
    const linkHost = host ?? remembered?.host ?? null;
    if (typeof linkHost !== "string" || !homepageHostPattern.test(linkHost)) throw new Error("A host name or address for the dashboard links is required");
    const configDirectory = path.join(dirFor("homepage"), "config");
    const tailnetHost = /\.ts\.net$/i.test(linkHost);
    const served = tailnetHost ? await servedPorts() : new Set();
    const { manifests } = await catalog.all();
    const entries = [];
    for (const manifest of manifests) {
      if (manifest.id === "homepage") continue;
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      const port = manifest.ports.find((entry) => entry.protocol === "tcp") ?? null;
      const hostPort = port ? state.values?.ports?.[port.id] ?? port.host : null;
      // A loopback app answers on the server itself only. Tailscale Serve is how it is meant to be
      // reached, so link the HTTPS address when it is published and the dashboard is being read on
      // the tailnet; otherwise say where it lives rather than offering an address that fails in the
      // reader's browser.
      const loopback = port?.exposure === "loopback";
      const publishedOnTailnet = loopback && tailnetHost && served.has(Number(hostPort));
      const href = port ? (loopback ? (publishedOnTailnet ? `https://${linkHost}:${hostPort}` : null) : `http://${linkHost}:${hostPort}`) : null;
      const description = loopback && !publishedOnTailnet ? `${manifest.description} (on the server itself at 127.0.0.1:${hostPort}; publish it with Serve to reach it from elsewhere)` : manifest.description;
      entries.push({ [manifest.name]: { ...(href ? { href } : {}), description, icon: `${manifest.id}.png`, server: "boxpilot", container: projectNameFor(manifest.id) } });
    }
    await mkdir(configDirectory, { recursive: true });
    const servicesPath = path.join(configDirectory, "services.yaml");
    // The owner's own groups live in the same file. One that does not parse, or is not a list of
    // groups, used to count as empty and was replaced with BoxPilot's group alone, deleting theirs.
    // Only a file that is not there (or holds nothing) is empty; anything else is left as it is.
    const leftAlone = (why) => new Error(`Homepage's services.yaml (${servicesPath}) ${why}, so it was left as it is rather than replaced with only BoxPilot's group, which would lose your own groups. Fix the file, or move it aside to start afresh, then sync again.`);
    let existing = [];
    // Homepage's config folder is its container's to write, and a restored backup's: a link here is
    // not followed, so root never reads another file into a services.yaml the container can read.
    const text = await readFileWithoutFollowing(servicesPath).catch((error) => { if (error.code === "ENOENT") return null; throw leftAlone(`could not be read (${error.message})`); });
    if (text !== null) {
      let parsed;
      try { parsed = YAML.parse(text); } catch (error) { throw leftAlone(`is not valid YAML (${String(error.message).split("\n")[0]})`); }
      if (Array.isArray(parsed)) existing = parsed;
      else if (parsed !== null && parsed !== undefined) throw leftAlone("is not a list of groups");
    }
    const kept = existing.filter((group) => !(group && typeof group === "object" && Object.keys(group)[0] === homepageGroup));
    const services = [{ [homepageGroup]: entries }, ...kept];
    const pending = `${servicesPath}.${randomUUID()}.tmp`;
    await writeFile(pending, `# The "${homepageGroup}" group is managed by BoxPilot and rewritten on every sync; other groups are kept.\n${YAML.stringify(services)}`, { mode: 0o644 });
    // Replace in one step: a truncating write can leave torn YAML that the next sync would discard.
    await rename(pending, servicesPath);
    // Written only where nothing is: "wx" creates it exclusively, so a link the container left at
    // that name (even one to a file that does not exist yet, /etc/nologin) is never written through.
    await writeFile(path.join(configDirectory, "docker.yaml"), "boxpilot:\n  socket: /var/run/docker.sock\n", { mode: 0o644, flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await replaceFileWithoutFollowing(rememberedPath, JSON.stringify({ host: linkHost, syncedAt: clock().toISOString() }), { mode: 0o600 });
    progress?.(`Homepage now lists ${entries.length} installed app(s) in its ${homepageGroup} group`, "stdout");
    return { synced: true, services: entries.length, groupsKept: kept.length, host: linkHost };
  }

  /** Best-effort dashboard refresh after an install or uninstall; never fails the main job. */
  async function refreshHomepage(changedId, progress) {
    if (changedId === "homepage") return;
    try {
      const state = await readState("homepage");
      if (!state?.installed) return;
      await syncHomepage({}, { progress });
    } catch (error) {
      progress?.(`Homepage dashboard not refreshed: ${error.message}`, "stderr");
    }
  }

  return { syncHomepage, refreshHomepage };
}
