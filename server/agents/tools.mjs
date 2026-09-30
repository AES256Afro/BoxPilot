/**
 * The read-only tools, as the web process runs them for the agents runner (M37). The runner never
 * reads the server itself: it asks for a tool by name on a run it holds the lease of, and this
 * reads - as that run's person, through the same helpers and rules the pages use - and returns
 * text. The helper is reached only through registered read-only operations, and an operator read
 * (ADR-003) is never run for a run that reads as a viewer.
 *
 * Notes, plans and notifications are the service's (service.mjs); everything here only reads.
 */
import { alertSources, asRequest, backupSummary, maskedParameters } from "../assistant/facts.mjs";
import { createBm25, tokenize } from "../assistant/knowledge.mjs";
import { seesEveryAccount } from "../routes/access.mjs";
import { searxSearch } from "./connectors.mjs";
import { exactTools } from "./deterministic.mjs";
import { describePihole } from "./pihole.mjs";
import { describeApps, describePlaces, describeServer, describeStorage, locate } from "./tool-text.mjs";

/** Whether an agent's allowlist lets it look at this app (spec.allow.apps: "*" or ids). */
export const appAllowed = (spec, appId) => !spec?.allow || spec.allow.apps === "*" || spec.allow.apps.includes(String(appId ?? "").replace(/^bp-/, ""));

const clip = (text, max) => { const value = String(text ?? ""); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const gigabytes = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(bytes >= 100e9 ? 0 : 1)} GB` : "unknown");

export class ToolError extends Error {
  constructor(message) { super(message); this.code = "tool_failed"; }
}

/**
 * BoxPilot's documents for the people building it rather than the owner running it: the roadmap,
 * the decision records, the architecture and page notes, hand-offs and the contributors' guide.
 */
export const internalDocuments = /^(AGENTS\.md|docs\/(ROADMAP[^/]*|DECISIONS|ARCHITECTURE|UI-PAGES|HANDOFF[^/]*|spikes\/[^/]+)\.md)$/i;
export const internalDocument = (chunk) => chunk?.kind === "doc" && internalDocuments.test(String(chunk.ref?.path ?? chunk.title?.split(" › ")[0] ?? ""));
/** A question about how BoxPilot itself is planned or built, which those documents do answer. */
export const aboutBuildingBoxPilot = (query) => /\b(roadmap|milestones?|M\d{2}(?:\.\d+)?|ADR-?\d+|decisions? records?|architecture|design decisions?|release plan|changelog|contribut\w*|hand-?off notes?|spike)\b/i.test(String(query ?? ""));

/** Longest a `since` may reach back: a week. */
export function sinceWithinWeek(since) {
  const match = /^(\d{1,3})([mhd])$/.exec(String(since ?? ""));
  if (!match) return false;
  const minutes = Number(match[1]) * { m: 1, h: 60, d: 1440 }[match[2]];
  return minutes >= 1 && minutes <= 7 * 1440;
}

export function createToolRunner({ state, store, registry, helper = null, inventory = null, knowledge = null, secretEnvNamesFor = null, now = () => new Date(), helperTimeoutMs = 30_000, webSearch = () => ({ enabled: false, endpoint: null }), fetcher = fetch }) {
  let appsRead = null;
  /** app.inspect, shared for fifteen seconds: a run asks several tools that all start from it. */
  function readApps() {
    if (!helper) return Promise.resolve(null);
    const at = now().getTime();
    if (appsRead && at - appsRead.at < 15_000) return appsRead.promise;
    const promise = helper.request("app.inspect", {}, { timeoutMs: helperTimeoutMs });
    appsRead = { at, promise };
    promise.catch(() => { if (appsRead?.promise === promise) appsRead = null; });
    return promise;
  }

  /** A registered read, refused for a role it is not open to - the same check the operations route makes. */
  async function read(operationId, parameters, { readRole }) {
    const operation = registry.get(operationId);
    if (!operation?.readOnly) throw new ToolError(`${operationId} is not a read`);
    if (operation.elevatedOnly) throw new ToolError(`${operation.title} reveals secrets, so no agent reads it`);
    if (operation.minimumRole === "operator" && !["owner", "operator"].includes(readRole)) throw new ToolError(`${operation.title} needs an operator`);
    if (operation.minimumRole === "owner" && readRole !== "owner") throw new ToolError(`${operation.title} is the owner's to read`);
    const problem = registry.validate(operationId, parameters);
    if (problem) throw new ToolError(problem);
    if (!helper) throw new ToolError("The helper is not available");
    return helper.request(operationId, parameters, { timeoutMs: Math.min(operation.timeoutMs ?? helperTimeoutMs, helperTimeoutMs) });
  }

  const tools = {
    async "server.facts"() {
      const snapshot = await inventory?.inspect();
      if (!snapshot) throw new ToolError("The server's facts could not be read");
      return describeServer(snapshot);
    },

    async "apps.list"(_input, context) {
      const [apps, snapshot] = await Promise.all([readApps().catch(() => null), inventory?.inspect().catch(() => null)]);
      const applications = Array.isArray(apps?.applications) ? apps.applications.filter((app) => appAllowed(context?.spec, app?.id)) : null;
      const others = (snapshot?.docker?.containers ?? []).filter((container) => !container.app && !String(container.name ?? "").startsWith("bp-"));
      return describeApps(applications, others);
    },

    async "services.status"({ unit = null }, context) {
      const listed = await read("service.list", {}, context);
      const units = Array.isArray(listed?.units) ? listed.units : [];
      if (unit) {
        const found = units.find((entry) => entry.unit === unit);
        return found ? `${found.unit}: ${found.active} (${found.sub}), ${found.enabled}${found.description ? ` - ${found.description}` : ""}.` : `${unit} is not a unit on this server.`;
      }
      const failed = units.filter((entry) => entry.active === "failed");
      return [
        `${listed?.counts?.total ?? units.length} units, ${listed?.counts?.active ?? "?"} active, ${failed.length} failed.`,
        failed.length ? `Failed: ${failed.slice(0, 15).map((entry) => entry.unit).join(", ")}.` : "Nothing has failed.",
      ].join("\n");
    },

    async "logs.query"({ kind, target, lines = 60, since = null, filter = null }, context) {
      if (since && !sinceWithinWeek(since)) throw new ToolError("since reaches back at most 7d");
      if (kind === "container" && !appAllowed(context.spec, target)) throw new ToolError(`This agent may not look at ${target}`);
      const result = await read("logs.read", { kind, target, lines, ...(since ? { since } : {}), ...(filter ? { filter } : {}) }, context);
      const entries = Array.isArray(result?.lines) ? result.lines.slice(-lines) : [];
      return entries.length ? `${entries.length} lines from ${kind} ${target}${since ? ` since ${since}` : ""}:\n${entries.join("\n")}` : `No lines from ${kind} ${target}${since ? ` since ${since}` : ""}.`;
    },

    async "storage.health"() {
      const snapshot = await inventory?.inspect().catch(() => null);
      if (!snapshot?.storage) return "Storage and drive health could not be read.";
      return describeStorage(snapshot);
    },

    async "docs.search"({ query, limit = 4 }, context) {
      const sources = context.spec.knowledge ?? {};
      const kinds = [sources.docs !== false && "doc", sources.registry !== false && "operation", sources.catalog !== false && "app"].filter(Boolean);
      const hits = [];
      if (knowledge && kinds.length) {
        await knowledge.ensure().catch(() => null);
        // BoxPilot's own plans and records of how it is built answer questions about building BoxPilot,
        // never about this server: they come back only when that is what was asked.
        const internalToo = aboutBuildingBoxPilot(query);
        const found = knowledge.search(query, { limit: internalToo ? limit : limit + 24, kinds }).filter((hit) => internalToo || !internalDocument(hit.chunk));
        for (const hit of found.slice(0, limit)) hits.push({ score: hit.score, title: hit.chunk.title, text: hit.chunk.text });
      }
      if (sources.documents !== false) {
        const documents = store.listDocuments().filter((document) => document.enabled);
        if (documents.length) {
          const chunks = documents.map((document) => ({ title: `Owner's document: ${document.title}`, text: document.text.slice(0, 4_000), weight: 1.2 }));
          for (const [index, score] of createBm25(chunks).search(tokenize(query))) hits.push({ score, title: chunks[index].title, text: chunks[index].text });
        }
      }
      if (!hits.length) return `Nothing in the documents matched "${clip(query, 80)}".`;
      return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => `## ${hit.title}\n${clip(hit.text, 900)}`).join("\n\n");
    },

    async "jobs.recent"({ state: which = "failed", limit = 5 }, context) {
      const request = asRequest({ id: context.readAs, role: context.readRole });
      const scope = seesEveryAccount(request) ? {} : { createdBy: context.readAs };
      const jobs = (state.listJobs?.(50, scope) ?? []).filter((job) => which === "all" || job.state === "failed").slice(0, limit);
      if (!jobs.length) return which === "failed" ? "No failed jobs to see." : "No jobs to see.";
      const pieces = [];
      for (const job of jobs) {
        const operationId = typeof job.type === "string" && job.type.startsWith("op:") ? job.type.slice(3) : null;
        const parameters = await maskedParameters(job, { registry, secretEnvNamesFor });
        pieces.push([
          `Job ${job.id}: ${job.title ?? "untitled"}${operationId ? ` (operation ${operationId})` : ""}, ${job.state}, last changed ${job.updatedAt ?? job.createdAt ?? "at an unknown time"}.`,
          job.error ? `Error: ${clip(job.error, 500)}` : null,
          job.timeout ? "It ran out of time." : null,
          parameters && Object.keys(parameters).length ? `Parameters: ${clip(JSON.stringify(parameters), 300)}` : null,
        ].filter(Boolean).join("\n"));
      }
      return pieces.join("\n\n");
    },

    async "alerts.active"(_input, context) {
      const sources = alertSources({ caller: { id: context.readAs, role: context.readRole }, state, focusKey: null, limit: 20 });
      return sources.length ? sources.map((source) => source.text).join("\n") : "No health alerts are live, and no news is waiting.";
    },

    async "backups.status"() {
      return backupSummary(state, { sourceChars: 3_000 }).text;
    },

    async "pihole.stats"(_input, context) {
      if (!appAllowed(context.spec, "pi-hole")) throw new ToolError("This agent may not look at Pi-hole");
      return describePihole(await read("app.pihole.inspect", {}, context));
    },

    async "records.query"({ collection, contains = null, limit = 10 }, context) {
      const request = asRequest({ id: context.readAs, role: context.readRole });
      const everyone = seesEveryAccount(request);
      const wanted = contains ? contains.toLowerCase() : null;
      const keep = (line) => !wanted || line.toLowerCase().includes(wanted);
      let lines = [];
      if (collection === "jobs") {
        const jobs = state.listJobs?.(100, everyone ? {} : { createdBy: context.readAs }) ?? [];
        lines = jobs.map((job) => `${job.createdAt ?? ""} ${job.type ?? ""} "${job.title ?? ""}" ${job.state}${job.error ? `: ${clip(job.error, 160)}` : ""}`);
      } else if (collection === "schedules") {
        const schedules = (state.listSchedules?.() ?? []).filter((schedule) => everyone || schedule.createdBy === context.readAs);
        lines = schedules.map((schedule) => `${schedule.operationId} ${schedule.frequency}${schedule.hour !== null && schedule.hour !== undefined ? ` at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")}` : ""}, ${schedule.enabled ? "on" : "off"}, next ${schedule.nextDueAt ?? "not set"}`);
      } else if (collection === "flows") {
        // Automations are shared (every role reads them); their steps are named, never their parameters.
        lines = (state.listFlows?.() ?? []).map((flow) => `"${flow.name}": ${(flow.steps ?? []).map((step) => step.operationId).join(" → ")}; ${flow.enabled === false ? "paused" : "on"}${flow.frequency ? `, ${flow.frequency}` : ""}${flow.lastRunAt ? `, last ran ${flow.lastRunAt}` : ""}`);
      } else if (collection === "backups") {
        lines = (state.listBackups?.(100) ?? []).filter((backup) => appAllowed(context.spec, backup.applicationId)).map((backup) => `${backup.createdAt} ${backup.applicationId} to ${backup.destination}, ${gigabytes(backup.sizeBytes)}${backup.restoreDrill?.verified === false ? ", restore check failed" : backup.restoreDrill ? ", restore checked" : ""}`);
      }
      const found = lines.filter(keep).slice(0, limit);
      return found.length ? `${found.length} of ${lines.length} ${collection}${wanted ? ` mentioning "${contains}"` : ""}:\n${found.join("\n")}` : `No ${collection}${wanted ? ` mention "${contains}"` : " to see"}.`;
    },

    async "document.read"({ title, from = 0 }, context) {
      if (context.spec?.knowledge?.documents === false) throw new ToolError("This agent does not read the owner's documents");
      const document = store.findDocument(title);
      if (!document) throw new ToolError(`There is no document called "${clip(title, 80)}"; docs.search lists them`);
      const piece = document.text.slice(from, from + 6_000);
      return `${document.title} (${document.characters} characters; from ${from}):\n${piece}${from + 6_000 < document.characters ? `\n… ${document.characters - from - 6_000} more characters: read again from ${from + 6_000}.` : ""}`;
    },

    async "web.search"({ query, limit = 5 }) {
      const settings = webSearch();
      if (!settings.enabled) throw new ToolError("Web search is off on this server");
      return searxSearch({ endpoint: settings.endpoint, query, limit }, { fetcher });
    },

    ...Object.fromEntries(Object.entries(exactTools).map(([id, fn]) => [id, (input) => Promise.resolve().then(() => fn(input, { now })).catch((error) => { throw new ToolError(error.message); })])),

    async "where.runs"({ name }, context) {
      const found = await whereRuns(name, context);
      return describePlaces(name, found.places, { unread: found.unread });
    },
  };

  /** Where something runs, as places: a BoxPilot app, another container, a unit on the host. */
  async function whereRuns(name, context = null) {
    const [apps, snapshot, units] = await Promise.all([
      readApps().catch(() => null),
      inventory?.inspect().catch(() => null),
      helper ? helper.request("service.list", {}, { timeoutMs: helperTimeoutMs }).catch(() => null) : null,
    ]);
    const places = locate(name, {
      applications: (apps?.applications ?? []).filter((entry) => appAllowed(context?.spec, entry?.id)),
      containers: snapshot?.docker?.containers ?? [],
      units: units?.units ?? [],
    });
    return { places, unread: !apps || !snapshot || !units };
  }

  /** Run one read tool. `context` carries the run's role, whom it reads as, and the agent's spec. */
  async function run(toolId, input, context) {
    const tool = tools[toolId];
    if (!tool) throw new ToolError(`${toolId} is not a read tool`);
    return tool(input ?? {}, context);
  }

  return { run, has: (toolId) => Object.hasOwn(tools, toolId), readApps, whereRuns };
}
