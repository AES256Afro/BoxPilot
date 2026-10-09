/**
 * Named credentials for reaching outward (M13.7): an API token saved once under a name, referenced
 * by that name from an HTTP step, never written into a flow, a job record, or SQLite.
 *
 * The store is one root-owned file (0600) in the helper's own state directory. The web process
 * never holds a value: setting one arrives through the ordinary secret-parameter machinery (staged
 * in memory, merged at execution, a placeholder in every record), reading happens only inside the
 * root task that performs the request, and everything the interface can list is names and dates.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { writeFileDurably } from "./durable-file.mjs";

export const credentialNamePattern = /^[a-z][a-z0-9-]{0,31}$/;
export const defaultCredentialFile = process.env.BOXPILOT_CREDENTIAL_FILE ?? "/var/lib/boxpilot-managed/credentials.json";

/**
 * The credentials BoxPilot saves for itself, each through its own operation at its own tier: the
 * Cloudflare API token and the tunnel's run token (cloudflare.connect, high, ADR-011), the
 * heartbeat's secret address (heartbeat.set), and the agents' Zulip bot key (agents.zulip.connect).
 * Every name BoxPilot writes to this store on its own belongs here; ops/connectors.test.mjs holds
 * the list to the modules that write them.
 *
 * None of them is the owner's to send anywhere. http.request is medium and sends a credential by
 * name, in any header, to any address, so without this an agent's proposed step or a session that
 * never gave the password could post the Cloudflare token wherever it liked. These names are refused
 * by http.request, by a connector sync, and by Save and Remove a credential, which would otherwise
 * replace one without the checks of the operation that owns it, or take it away from under its
 * feature. Their own operations reach the store directly and are not affected.
 */
export const managedCredentialNames = new Set(["cloudflare-api-token", "cloudflare-tunnel-token", "heartbeat-url", "zulip-agents-bot"]);

/** Why a credential name may not be used, saved or removed by hand, or null when it may. */
export function managedCredentialProblem(name) {
  return managedCredentialNames.has(name) ? `BoxPilot keeps ${name} for itself: only the setting that saved it uses, replaces or removes it` : null;
}

const valueLimit = 4096;
const countLimit = 64;

/**
 * What no request header can carry. A value rides in one header, and a line break inside it made
 * fetch refuse the request with an error that quoted the value - into the job's record, the
 * journal and the support bundle.
 */
export const headerUnsafe = /[\0\r\n]/;

/**
 * Saves and removes one at a time per file. The helper runs a Zulip connect and a heartbeat change
 * side by side (they are on different lanes), and each read the file, changed its copy and put it
 * back, so the second one back lost the first one's change.
 */
const writeQueues = new Map();
function serially(file, work) {
  const next = (writeQueues.get(file) ?? Promise.resolve()).then(work, work);
  writeQueues.set(file, next.catch(() => {}));
  return next;
}

export function createCredentialStore({ file = defaultCredentialFile, now = () => new Date() } = {}) {
  /** The saved credentials; none when there is no file yet. A file that cannot be read is an error: saving over it would lose every credential in it. */
  async function load() {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new Error(`The credential store could not be read (${error?.code ?? "error"}); nothing was changed`);
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The credential store could not be read: the file is damaged. Nothing was changed; restore it from a backup, or remove it to start again");
    return parsed;
  }

  async function save(entries) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    // Write-then-rename so a crash mid-write can never leave a truncated store behind. The temp
    // name is unique per write, so two concurrent writers cannot share one temp file and rename
    // a half-written blend of both over the store. Synced before the rename, or a power cut can
    // leave the rename on disk without the data, and an empty store.
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFileDurably(temp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }

  async function set({ name, value: given }) {
    if (typeof name !== "string" || !credentialNamePattern.test(name)) throw new Error("A credential name is lowercase letters, digits and dashes, 32 characters at most");
    // A pasted value often ends with a line break; that one is the paste's, not the value's.
    const value = typeof given === "string" ? given.replace(/[\r\n]+$/, "") : given;
    if (typeof value !== "string" || !value.length || value.length > valueLimit) throw new Error(`A credential value is 1 to ${valueLimit} characters`);
    if (headerUnsafe.test(value)) throw new Error("A credential value is one line: it has a line break inside it, which no request can carry");
    return serially(file, async () => {
      const entries = await load();
      const existed = Object.hasOwn(entries, name);
      if (!existed && Object.keys(entries).length >= countLimit) throw new Error(`At most ${countLimit} credentials can be stored`);
      entries[name] = { value, createdAt: entries[name]?.createdAt ?? now().toISOString(), updatedAt: now().toISOString() };
      await save(entries);
      return { name, replaced: existed };
    });
  }

  async function remove({ name }) {
    return serially(file, async () => {
      const entries = await load();
      if (!Object.hasOwn(entries, name)) throw new Error(`No credential is named ${name}`);
      delete entries[name];
      await save(entries);
      return { name, removed: true };
    });
  }

  /** Names and dates only; the values have no path out of this file except into a request header. */
  async function listNames() {
    const entries = await load();
    return Object.keys(entries).sort().map((name) => ({ name, createdAt: entries[name].createdAt ?? null, updatedAt: entries[name].updatedAt ?? null }));
  }

  /** The one value reader, used by the root task that performs the request. */
  async function read(name) {
    const entries = await load();
    return Object.hasOwn(entries, name) ? entries[name].value : null;
  }

  return { set, remove, listNames, read };
}
