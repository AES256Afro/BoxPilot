/**
 * Signed in to a container registry, for private apps only (M71, ADR-019).
 *
 * The helper keeps one Docker client config, `<directory>/config.json` (folder 0700, file 0600, both
 * root's), holding an `auths` entry per registry. Only docker and compose calls for an app from the
 * private catalog are pointed at it (DOCKER_CONFIG, app-helper.mjs); every other pull stays
 * anonymous, so a token that expires or is revoked never breaks a public catalog image from the
 * same registry.
 *
 * The token is not in the credential store (credentials.mjs): there, http.request and a connector
 * sync can send a credential by name. Here nothing reads it but the Docker client the helper runs,
 * and nothing BoxPilot shows says more than the registry and the user name.
 *
 * A sign-in is checked before it is kept: `docker login --password-stdin` runs against a fresh
 * folder inside this one (the daemon makes the call to the registry, so the helper's own sandbox
 * without a network is no obstacle), and only when the registry accepts it is that registry's entry
 * copied into the config. A refused token leaves the config as it was.
 */
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdirWithoutFollowing, readFileWithoutFollowing, replaceFileWithoutFollowing } from "./durable-file.mjs";
import { fixedRun } from "./exec.mjs";
import { redactLine } from "./redaction.mjs";

const defaultRegistryAuthDirectory = process.env.BOXPILOT_REGISTRY_AUTH_DIRECTORY ?? "/var/lib/boxpilot-managed/registry-auth";
/** A registry as Docker names it: a host name, lower case, and a port if it has one. Never a URL. */
export const registryHostPattern = /^(?=.{1,253}(?::[0-9]{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;
/** A registry user name: no colon (Docker keeps user:token together) and no space. */
export const registryUsernamePattern = /^[A-Za-z0-9_][A-Za-z0-9._@+-]{0,254}$/;

/** Docker Hub's key in a client config, whatever it was signed in as. */
const dockerHubKey = "https://index.docker.io/v1/";
const dockerHubNames = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
const keyFor = (registry) => (dockerHubNames.has(registry) ? dockerHubKey : registry);
const registryOf = (key) => (key === dockerHubKey ? "docker.io" : key);
/**
 * Seeded into the folder a sign-in is checked in. The Docker client looks for a system credential
 * helper (pass, secretservice) only when its config holds no sign-in at all, and one found there
 * would keep the token where this cannot copy it from; an entry for a name that cannot exist keeps
 * it in the file. It is never copied.
 */
const placeholderKey = "boxpilot.invalid";
const scratchPrefix = ".signin-";

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {{ timeout?: number, env?: Record<string, string>, input?: string }} [options]
 */
function defaultDockerRunner(binary, args, { timeout = 90_000, env = {}, input } = {}) {
  return fixedRun(binary, args, { timeout, env: { ...env, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, ...(typeof input === "string" ? { input } : {}) });
}

/** The user name of a config entry: its own field, else the part of `auth` before the first colon. */
function usernameOf(entry) {
  if (typeof entry?.username === "string" && entry.username) return entry.username;
  if (typeof entry?.auth !== "string" || !entry.auth) return null;
  const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon > 0 ? decoded.slice(0, colon) : null;
}

/** Saves and sign-outs one at a time per folder: each reads the config, changes it and writes it back. */
const queues = new Map();
function serially(key, work) {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(key, next.catch(() => {}));
  return next;
}

/**
 * @param {{ directory?: string, dockerBinary?: string, runDocker?: (binary: string, args: string[], options?: { timeout?: number, env?: Record<string, string>, input?: string }) => Promise<{ ok: boolean, stdout?: string, stderr?: string }> }} [options]
 */
export function createRegistryAuth({ directory = defaultRegistryAuthDirectory, dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker", runDocker = defaultDockerRunner } = {}) {
  const folder = path.resolve(directory);
  const configFile = path.join(folder, "config.json");

  async function ensureFolder() {
    await mkdirWithoutFollowing(path.dirname(folder), path.basename(folder), { mode: 0o700 });
    await chmod(folder, 0o700);
  }

  /** The config as saved; none when nothing was ever signed in. A damaged one is an error, never overwritten blind. */
  async function read() {
    let raw;
    try {
      raw = await readFileWithoutFollowing(configFile);
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new Error(`The registry sign-ins could not be read (${error?.code ?? "error"}); nothing was changed`);
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`The registry sign-ins could not be read: ${configFile} is damaged. Nothing was changed; remove it and sign in again`);
    return parsed;
  }

  async function write(config) {
    await replaceFileWithoutFollowing(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }

  /** Each registry signed in to and the user name it was signed in as. Never a token. */
  async function list() {
    const config = await read();
    return Object.entries(config.auths ?? {})
      .filter(([key]) => key !== placeholderKey)
      .map(([key, entry]) => ({ registry: registryOf(key), username: usernameOf(entry) }))
      .sort((left, right) => left.registry.localeCompare(right.registry));
  }

  /**
   * Check `token` with the registry through the Docker daemon and, when it is accepted, keep it.
   *
   * @param {{ registry: string, username: string, token: string }} request
   */
  async function signIn({ registry, username, token }) {
    if (typeof registry !== "string" || !registryHostPattern.test(registry)) throw new Error("A registry is its host name, such as ghcr.io, with a port if it has one");
    if (typeof username !== "string" || !registryUsernamePattern.test(username)) throw new Error("The user name has a character a registry sign-in cannot carry");
    if (typeof token !== "string" || !token) throw new Error("The token is empty");
    return serially(folder, async () => {
      await ensureFolder();
      // What a sign-in cut off by a restart left: its folder holds that token in the clear.
      for (const name of await readdir(folder).catch(() => [])) if (name.startsWith(scratchPrefix)) await rm(path.join(folder, name), { recursive: true, force: true });
      const scratch = await mkdtemp(path.join(folder, scratchPrefix));
      try {
        await writeFile(path.join(scratch, "config.json"), JSON.stringify({ auths: { [placeholderKey]: {} } }), { mode: 0o600 });
        const result = await runDocker(dockerBinary, ["login", registry, "--username", username, "--password-stdin"], { timeout: 90_000, env: { DOCKER_CONFIG: scratch }, input: token });
        if (!result?.ok) {
          const said = redactLine(String(result?.stderr ?? "")).split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 600);
          throw new Error(`Signing in to ${registry} failed${said ? `: ${said}` : ""}. The sign-ins saved before are unchanged.`);
        }
        let written = null;
        try { written = JSON.parse(await readFile(path.join(scratch, "config.json"), "utf8")); } catch { written = null; }
        const entries = Object.entries(written?.auths ?? {}).filter(([key, entry]) => key !== placeholderKey && typeof entry?.auth === "string" && entry.auth);
        const wanted = entries.find(([key]) => key === keyFor(registry)) ?? (entries.length === 1 ? entries[0] : null);
        if (!wanted) throw new Error("docker login accepted the sign-in but kept no credentials BoxPilot can use (a credential helper may be configured). The sign-ins saved before are unchanged.");
        const config = await read();
        const auths = { ...(config.auths ?? {}) };
        const replaced = Object.hasOwn(auths, wanted[0]);
        auths[wanted[0]] = { auth: wanted[1].auth };
        await write({ ...config, auths });
        return { registry: registryOf(wanted[0]), username, signedIn: true, replaced };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }

  /** Forget the sign-in for `registry`; the config goes when it was the last. @param {{ registry: string }} request */
  async function signOut({ registry }) {
    if (typeof registry !== "string" || !registryHostPattern.test(registry)) throw new Error("A registry is its host name, such as ghcr.io");
    return serially(folder, async () => {
      const config = await read();
      const key = keyFor(registry);
      if (!Object.hasOwn(config.auths ?? {}, key)) throw new Error(`BoxPilot is not signed in to ${registry}`);
      const auths = { ...config.auths };
      delete auths[key];
      if (Object.keys(auths).filter((name) => name !== placeholderKey).length) await write({ ...config, auths });
      else await rm(configFile, { force: true });
      return { registry, signedOut: true };
    });
  }

  /** The folder to give DOCKER_CONFIG, or null when nothing is signed in. */
  async function dockerConfigDirectory() {
    const info = await lstat(configFile).catch(() => null);
    return info?.isFile() ? folder : null;
  }

  return { list, signIn, signOut, dockerConfigDirectory, directory: folder };
}
