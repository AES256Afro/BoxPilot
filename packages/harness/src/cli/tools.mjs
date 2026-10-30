/**
 * The CLI's tools (M45.8): what an agent may do in its working folder.
 *
 * - files_list, files_read: read inside the folder.
 * - files_write: create, replace or append to a file inside the folder; asks the person first.
 * - shell_run: one program from the allowlist, with arguments, in the folder, no shell; asks first.
 * - web_fetch: one public web page as text, when the person turned it on; never a private address.
 * - notes_save, notes_search: the agent's memory between runs, in the harness's own file.
 *
 * Every path is the folder's: relative, inside it after every symlink is followed, and never the
 * harness's own `.harness` folder; nothing writes into `.git`.
 */
import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { defineTool } from "../core/tools.mjs";
import { isLocalAddress } from "../providers/local-endpoint.mjs";

/**
 * Programs shell_run may start unless the person names others; each call still asks first. Not git:
 * a repository's own settings can make git start other programs (hooks, filters, fsmonitor), so it
 * is the person's to add for a folder they trust.
 */
export const defaultPrograms = Object.freeze(["ls", "cat", "head", "tail", "wc", "grep", "find", "sort", "uniq", "diff", "file", "stat", "du", "df", "date", "uname"]);

export const toolLimits = Object.freeze({ readBytes: 2 * 1024 * 1024, readLines: 400, listEntries: 300, writeChars: 100_000, commandMs: 30_000, commandBytes: 1024 * 1024, fetchBytes: 1024 * 1024, fetchMs: 15_000, redirects: 3 });

const isWithin = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/** The working folder: every path a tool is given is checked to be inside it. */
export function createFolder(root) {
  const base = path.resolve(root);
  let real = null;
  const realRoot = async () => (real ??= await realpath(base));
  return {
    base,
    /**
     * A path the model gave, inside the folder, or an error that says why not. `write`: it will be
     * written, so it must not be a link, nor in `.git`.
     */
    async resolve(given, { write = false } = {}) {
      const text = String(given ?? "").trim() || ".";
      if (text.includes("\0")) throw new Error("A path cannot hold a NUL character");
      if (path.isAbsolute(text) || /^~/.test(text)) throw new Error(`Give a path inside the working folder, like notes/todo.md, not ${text.slice(0, 120)}`);
      const full = path.resolve(base, text);
      const relative = path.relative(base, full);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${text.slice(0, 120)} is outside the working folder`);
      const parts = relative.split(path.sep);
      if (parts.includes(".harness")) throw new Error("The harness's own files are not for its tools");
      if (write && parts.includes(".git")) throw new Error("The tools do not write into .git");
      if (write) {
        const existing = await lstat(full).catch(() => null);
        if (existing?.isSymbolicLink()) throw new Error(`${relative} is a link; the tools write only plain files`);
        if (existing && !existing.isFile()) throw new Error(`${relative} is not a file`);
      }
      // Followed through every link: the deepest part that exists must still be inside the folder.
      const inside = await realRoot();
      for (let probe = full; ; probe = path.dirname(probe)) {
        const found = await realpath(probe).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
        if (found === null) continue;
        if (!isWithin(inside, found)) throw new Error(`${text.slice(0, 120)} leads outside the working folder`);
        break;
      }
      return { full, relative: relative || "." };
    },
  };
}

const sizeOf = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 102.4) / 10} KB` : `${Math.round(bytes / 1024 ** 2 / 0.1) / 10} MB`);

/** A page's text: scripts, styles and tags gone, the common entities read, blank runs closed up. */
export function pageText(html) {
  return String(html)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/**
 * Whether a URL may be fetched: http or https, no user name or password, and a host that is a
 * public address or resolves only to public ones.
 */
export async function publicUrl(given, { lookup = dnsLookup } = {}) {
  let url;
  try { url = new URL(String(given)); } catch { throw new Error("That is not a URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https pages can be fetched");
  if (url.username || url.password) throw new Error("A URL with a user name or password is not fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error(`${host} does not resolve`);
  if (host === "localhost" || addresses.some((entry) => isLocalAddress(entry.address) || /^(?:0\.|::$|::ffff:0\.)/.test(entry.address))) throw new Error(`${host} is on this machine or a private network; web_fetch reads public pages only`);
  return url;
}

/**
 * The tools of one run.
 *
 * @param {{
 *   folder: ReturnType<typeof createFolder>,
 *   store?: ReturnType<typeof import("./store.mjs").openStore> | null,
 *   runId?: string | null,
 *   programs?: string[],
 *   web?: boolean,
 *   fetch?: typeof globalThis.fetch,
 *   lookup?: typeof dnsLookup,
 *   env?: Record<string, string | undefined>,
 * }} options
 */
export function folderTools({ folder, store = null, runId = null, programs = defaultPrograms, web = false, fetch: fetchImpl = globalThis.fetch, lookup = dnsLookup, env = process.env }) {
  const allowed = new Set(programs);
  const tools = [
    defineTool({
      name: "files_list", title: "Files", kind: "read",
      description: "List the files and folders at a path inside the working folder.",
      parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", maxLength: 500, description: "A folder inside the working folder; . for the folder itself" }, depth: { type: "integer", minimum: 1, maximum: 3, description: "How many levels down to list (1 to 3)" } } },
      async run({ path: given = ".", depth = 1 }) {
        const { full, relative } = await folder.resolve(given);
        const lines = [];
        const walk = async (directory, prefix, level) => {
          const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (lines.length >= toolLimits.listEntries) return;
            if (entry.name === ".harness") continue;
            const shown = `${prefix}${entry.name}`;
            if (entry.isDirectory()) {
              lines.push(`${shown}/`);
              if (level < depth && entry.name !== ".git") await walk(path.join(directory, entry.name), `${shown}/`, level + 1);
            } else if (entry.isSymbolicLink()) lines.push(`${shown} (link)`);
            else {
              const info = await stat(path.join(directory, entry.name)).catch(() => null);
              lines.push(`${shown}${info ? ` (${sizeOf(info.size)})` : ""}`);
            }
          }
        };
        await walk(full, "", 1);
        const cut = lines.length >= toolLimits.listEntries ? `\n[… stopped at ${toolLimits.listEntries} entries]` : "";
        return { title: `Files in ${relative}`, text: lines.length ? `${lines.join("\n")}${cut}` : "(empty)" };
      },
    }),
    defineTool({
      name: "files_read", title: "File", kind: "read",
      description: "Read a text file inside the working folder, a stretch of lines at a time.",
      parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 500 }, from: { type: "integer", minimum: 1, description: "The first line to read (1 is the first)" }, lines: { type: "integer", minimum: 1, maximum: toolLimits.readLines, description: "How many lines" } } },
      async run({ path: given, from = 1, lines = 200 }) {
        const { full, relative } = await folder.resolve(given);
        const info = await stat(full);
        if (!info.isFile()) throw new Error(`${relative} is not a file`);
        if (info.size > toolLimits.readBytes) throw new Error(`${relative} is ${sizeOf(info.size)}; files_read reads files up to ${sizeOf(toolLimits.readBytes)}`);
        const buffer = await readFile(full);
        if (buffer.subarray(0, 8192).includes(0)) throw new Error(`${relative} is not a text file`);
        const all = buffer.toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/);
        const end = Math.min(all.length, from - 1 + lines);
        const shown = all.slice(from - 1, end);
        const range = all.length <= lines && from === 1 ? `all ${all.length} lines` : `lines ${from} to ${end} of ${all.length}`;
        return { title: `${relative} (${range})`, text: shown.join("\n") };
      },
    }),
    defineTool({
      name: "files_write", title: "Write a file", kind: "write",
      description: "Create a new file, replace a file, or append to one, inside the working folder. The person approves each write.",
      parameters: { type: "object", additionalProperties: false, required: ["path", "text", "mode"], properties: { path: { type: "string", minLength: 1, maxLength: 500 }, text: { type: "string", maxLength: toolLimits.writeChars }, mode: { type: "string", enum: ["create", "replace", "append"] } } },
      describe: ({ path: given, text, mode }) => `${{ create: "Create", replace: "Replace", append: "Append to" }[mode]} ${given} (${text.length} characters)`,
      async run({ path: given, text, mode }) {
        const { full, relative } = await folder.resolve(given, { write: true });
        const exists = await lstat(full).then(() => true, () => false);
        if (mode === "create" && exists) throw new Error(`${relative} already exists; use replace or append`);
        if (mode !== "create" && !exists) throw new Error(`${relative} does not exist; use create`);
        await mkdir(path.dirname(full), { recursive: true });
        // The parent made, it is checked again: a folder made through a link would lead outside.
        await folder.resolve(given, { write: true });
        if (mode === "append") await appendFile(full, text);
        else if (mode === "create") await writeFile(full, text, { flag: "wx" });
        else {
          const temporary = `${full}.harness-${process.pid}.tmp`;
          await writeFile(temporary, text, { flag: "wx" });
          await rename(temporary, full);
        }
        return { title: `Wrote ${relative}`, text: `${{ create: "Created", replace: "Replaced", append: "Appended to" }[mode]} ${relative}: ${text.length} characters.` };
      },
    }),
    defineTool({
      name: "shell_run", title: "Run a command", kind: "operation",
      description: `Run one program in the working folder, with arguments, without a shell (no pipes, globs or redirects). Programs: ${[...allowed].join(", ")}. The person approves each command.`,
      parameters: { type: "object", additionalProperties: false, required: ["program"], properties: { program: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" }, args: { type: "array", maxItems: 32, items: { type: "string", maxLength: 1000 } } } },
      describe: ({ program, args = [] }) => `Run: ${[program, ...args.map((arg) => (/^[\w./:=@%+-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ")}`,
      async run({ program, args = [] }, { signal }) {
        if (!allowed.has(program)) throw new Error(`${program} is not one of the programs this run may start: ${[...allowed].join(", ")}`);
        const result = await new Promise((resolve) => {
          execFile(program, args, {
            cwd: folder.base, shell: false, timeout: toolLimits.commandMs, maxBuffer: toolLimits.commandBytes, signal, windowsHide: true,
            env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME ?? folder.base, LANG: env.LANG ?? "C.UTF-8", GIT_PAGER: "cat", PAGER: "cat" },
          }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        });
        if (result.error?.code === "ENOENT") throw new Error(`${program} is not installed here`);
        const code = result.error ? (Number.isInteger(result.error.code) ? result.error.code : result.error.killed ? "stopped (it took too long)" : String(result.error.code ?? result.error.message)) : 0;
        return { title: `${program} ${args.join(" ")}`.slice(0, 120), text: `Exit: ${code}\n${result.stdout.trim() ? `${result.stdout.trimEnd()}\n` : ""}${result.stderr.trim() ? `--- errors ---\n${result.stderr.trimEnd()}` : ""}`.trimEnd() };
      },
    }),
  ];
  if (web) {
    tools.push(defineTool({
      name: "web_fetch", title: "Web page", kind: "read", sends: true,
      description: "Read one public web page as text (http or https). Never pages on this machine or a private network.",
      parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 8, maxLength: 2000 } } },
      async run({ url: given }, { signal }) {
        let url = await publicUrl(given, { lookup });
        for (let hop = 0; ; hop += 1) {
          const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(toolLimits.fetchMs)]), headers: { Accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1", "User-Agent": "boxpilot-harness" } });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (hop >= toolLimits.redirects) throw new Error("Too many redirects");
            url = await publicUrl(new URL(response.headers.get("location") ?? "", url), { lookup });
            continue;
          }
          const type = response.headers.get("content-type") ?? "";
          if (!/^(?:text\/|application\/(?:json|xml|xhtml))/i.test(type)) throw new Error(`The page is ${type || "of no stated type"}, not text`);
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let body = "";
          let bytes = 0;
          while (reader) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > toolLimits.fetchBytes) { await reader.cancel().catch(() => {}); break; }
            body += decoder.decode(value, { stream: true });
          }
          const text = /html/i.test(type) ? pageText(body) : body;
          return { title: `${url.hostname} (${response.status})`, text: `${url.href}\n\n${text}` };
        }
      },
    }));
  }
  if (store) {
    tools.push(
      defineTool({
        name: "notes_save", title: "Save a note", kind: "write", asks: false,
        description: "Save a short note for your later runs in this folder: what you learned that will help next time. Never a secret.",
        parameters: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string", minLength: 3, maxLength: 120 }, text: { type: "string", minLength: 1, maxLength: 2000 } } },
        run({ title, text }) {
          const id = store.saveNote({ title, body: text, runId });
          return { title: "Saved a note", text: `Saved note ${id}: ${title}` };
        },
      }),
      defineTool({
        name: "notes_search", title: "Notes", kind: "read",
        description: "Find the notes your earlier runs in this folder saved; with no query, the newest.",
        parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 200 } } },
        run({ query = "" }) {
          const notes = store.searchNotes(query, 5);
          return { title: query ? `Notes about ${query}` : "Newest notes", text: notes.length ? notes.map((note) => `${note.title} (${note.createdAt.slice(0, 10)})\n${note.body}`).join("\n\n") : "No notes found." };
        },
      }),
    );
  }
  return tools;
}
