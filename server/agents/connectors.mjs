/**
 * Outside data for agents (M37): the learning library's connectors, and the opt-in web search.
 * Every connector is off until the owner turns it on, and whatever it brings is data, never
 * instructions: it is redacted when kept, and boxed as untrusted when a tool hands it to a model.
 *
 * - upload: a PDF (pdf.mjs), Markdown or text, through the Agents section.
 * - folder: a folder on this server the BoxPilot service can read, looked at in quiet hours; new
 *   and changed files come in, removed ones go.
 * - notion, slack: read-only, with a token the owner saves as a named credential. The token lives
 *   in the root-owned credential store and is read only inside the root task that fetches
 *   (agents.connector.sync, a registered low-risk operation the owner approves or schedules): the
 *   web process never holds it (M13.7's rule).
 * - web search: through the owner's own SearXNG on this network (the catalog has it), never a
 *   cloud search API. Off unless the owner turns it on, and off for every agent unless given.
 *
 * A connector is { id, title, readsWith, fetch }: adding one is adding an entry here.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createEndpointGuard, normalizeEndpoint, readBounded } from "../assistant/local-endpoint.mjs";
import { extractPdfText } from "./pdf.mjs";

export class ConnectorError extends Error {
  constructor(message) { super(message); this.expose = true; }
}

export const connectorLimits = Object.freeze({ fileBytes: 5 * 1024 * 1024, files: 100, documentChars: 64_000, syncChars: 400_000, pages: 25, blocks: 200, slackMessages: 400 });

/** Text a document keeps: control characters out, bounded. */
export function cleanDocumentText(text, max = connectorLimits.documentChars) {
  const value = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ---- uploads ----

/** An uploaded file's text: PDF, Markdown or plain text. `kind` is the file's extension. */
export function textOfUpload(buffer, name) {
  const extension = path.extname(String(name ?? "")).toLowerCase();
  if (buffer.length > connectorLimits.fileBytes * 2) throw new ConnectorError("The file is larger than 10 MB");
  if (extension === ".pdf" || buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    const { text, pages } = extractPdfText(buffer);
    return { text: cleanDocumentText(text), detail: `${pages} ${pages === 1 ? "page" : "pages"}` };
  }
  if ([".md", ".txt", ".markdown", ".text", ""].includes(extension)) {
    const text = buffer.toString("utf8");
    if (/\u0000/.test(text.slice(0, 4_000))) throw new ConnectorError("That file is not text");
    return { text: cleanDocumentText(text), detail: null };
  }
  throw new ConnectorError("Upload a PDF, Markdown or text file");
}

// ---- a folder on this server ----

const folderForbidden = /^\/(proc|sys|dev|run|boot|etc|root|var\/lib\/boxpilot)(\/|$)/;

/** The folder the owner named, checked: absolute, not a system or BoxPilot path. */
export function readFolderSetting(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || value.length > 300 || value.includes("\0")) throw new ConnectorError("The folder is an absolute path, like /srv/notes");
  const normal = path.posix.normalize(value).replace(/\/$/, "") || "/";
  if (normal === "/" || folderForbidden.test(normal)) throw new ConnectorError("Pick a folder of documents, not a system folder");
  return normal;
}

/**
 * The folder's documents: Markdown, text and PDF files at its top and one level down, each at most
 * 5 MB, at most 100. A file that cannot be read is skipped and named.
 */
export async function scanFolder(folder, { read = readFile, list = readdir, info = stat } = {}) {
  const found = [];
  const skipped = [];
  const walk = async (directory, depth) => {
    const entries = await list(directory, { withFileTypes: true }).catch((error) => { throw new ConnectorError(`The folder could not be read: ${error.code ?? error.message}`); });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= connectorLimits.files) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && depth === 0) { await walk(full, 1); continue; }
      if (!entry.isFile() || !/\.(md|markdown|txt|pdf)$/i.test(entry.name)) continue;
      const size = await info(full).then((value) => value.size, () => null);
      if (size === null || size > connectorLimits.fileBytes) { skipped.push(`${path.posix.relative(folder, full)} (too large)`); continue; }
      try {
        const { text } = textOfUpload(await read(full), entry.name);
        if (text) found.push({ externalId: path.posix.relative(folder, full), title: entry.name.replace(/\.(md|markdown|txt|pdf)$/i, ""), text });
      } catch (error) {
        skipped.push(`${path.posix.relative(folder, full)} (${error.message})`);
      }
    }
  };
  await walk(folder, 0);
  return { documents: found, skipped };
}

// ---- web search through the owner's SearXNG ----

/**
 * Search through SearXNG's JSON API on this network. SearXNG answers JSON only when its
 * settings.yml lists json under search.formats; a 403 says so.
 */
export async function searxSearch({ endpoint, query, limit = 5 }, { fetcher = fetch, guard = createEndpointGuard() } = {}) {
  if (!endpoint) throw new ConnectorError("Web search has no SearXNG address; the owner sets one in the Agents section");
  const origin = await guard(endpoint).catch((error) => { throw new ConnectorError(`Web search goes only to a SearXNG on this network: ${error.message}`); });
  const base = normalizeEndpoint(endpoint).replace(/\/$/, "");
  const url = new URL(`${base.startsWith(origin) ? base : origin}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "1");
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { Accept: "application/json" } });
  if (response.status === 403) throw new ConnectorError("SearXNG refused JSON: add json under search.formats in its settings.yml");
  if (!response.ok) throw new ConnectorError(`SearXNG answered ${response.status}`);
  let body;
  try { body = JSON.parse(await readBounded(response, 2 * 1024 * 1024)); } catch { throw new ConnectorError("SearXNG's answer could not be read"); }
  const results = (Array.isArray(body?.results) ? body.results : []).slice(0, limit).map((entry) => ({
    title: cleanDocumentText(entry?.title, 200), url: String(entry?.url ?? "").slice(0, 300), content: cleanDocumentText(entry?.content, 500),
  })).filter((entry) => /^https?:\/\//.test(entry.url));
  if (!results.length) return `No results for "${query}".`;
  return results.map((entry, index) => `${index + 1}. ${entry.title}\n${entry.url}\n${entry.content}`).join("\n\n");
}

// ---- Notion and Slack, inside the root task ----

async function getJson(fetcher, url, { token, method = "GET", body = null, headers = {} }) {
  const response = await fetcher(url, {
    method, redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401 || response.status === 403) throw new ConnectorError("The token was refused; save a new one under its name");
  if (!response.ok) throw new ConnectorError(`${new URL(url).hostname} answered ${response.status}`);
  return JSON.parse(await readBounded(response, 4 * 1024 * 1024));
}

const richText = (items) => (Array.isArray(items) ? items.map((item) => item?.plain_text ?? "").join("") : "");

/** Notion: the pages the integration was shared with, their text block by block. */
export async function fetchNotion({ token }, { fetcher = fetch } = {}) {
  const headers = { "Notion-Version": "2022-06-28" };
  const search = await getJson(fetcher, "https://api.notion.com/v1/search", { token, method: "POST", headers, body: { filter: { property: "object", value: "page" }, page_size: connectorLimits.pages } });
  const documents = [];
  for (const page of (Array.isArray(search?.results) ? search.results : []).slice(0, connectorLimits.pages)) {
    if (typeof page?.id !== "string" || !/^[0-9a-f-]{32,36}$/i.test(page.id)) continue;
    const titleProperty = Object.values(page.properties ?? {}).find((property) => property?.type === "title");
    const title = cleanDocumentText(richText(titleProperty?.title), 120) || "Untitled page";
    const blocks = await getJson(fetcher, `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, { token, headers });
    const lines = (Array.isArray(blocks?.results) ? blocks.results : []).slice(0, connectorLimits.blocks).map((block) => richText(block?.[block?.type]?.rich_text)).filter(Boolean);
    documents.push({ externalId: page.id, title: `Notion: ${title}`, text: cleanDocumentText(lines.join("\n")) });
  }
  return documents.filter((document) => document.text);
}

/** Slack: the last days of the channels the owner named, as text; who wrote what is left out. */
export async function fetchSlack({ token, channels = [], days = 7 }, { fetcher = fetch, now = () => Date.now() } = {}) {
  const oldest = String(Math.floor((now() - days * 86_400_000) / 1000));
  const documents = [];
  for (const channel of channels.slice(0, 10)) {
    if (!/^[CG][A-Z0-9]{6,20}$/.test(channel)) continue;
    const history = await getJson(fetcher, `https://slack.com/api/conversations.history?channel=${channel}&oldest=${oldest}&limit=${connectorLimits.slackMessages}`, { token });
    if (history?.ok === false) throw new ConnectorError(`Slack said ${String(history.error ?? "no").slice(0, 60)} for ${channel}`);
    const messages = (Array.isArray(history?.messages) ? history.messages : []).filter((message) => typeof message?.text === "string" && !message.subtype).reverse();
    const text = messages.map((message) => `${new Date(Number(message.ts) * 1000).toISOString().slice(0, 16).replace("T", " ")}: ${message.text}`).join("\n");
    if (text) documents.push({ externalId: channel, title: `Slack: ${channel}`, text: cleanDocumentText(text) });
  }
  return documents;
}

export const connectors = Object.freeze({
  notion: { id: "notion", title: "Notion", readsWith: "a Notion integration token, shared with the pages to read", fetch: fetchNotion },
  slack: { id: "slack", title: "Slack", readsWith: "a Slack bot token with channels:history, and the channel ids to read", fetch: fetchSlack },
});

/** What a sync hands back to the web process: documents, bounded in all. */
export function boundSync(documents) {
  const kept = [];
  let chars = 0;
  for (const document of documents) {
    if (chars + document.text.length > connectorLimits.syncChars) break;
    kept.push(document);
    chars += document.text.length;
  }
  return { documents: kept, truncated: kept.length < documents.length };
}
