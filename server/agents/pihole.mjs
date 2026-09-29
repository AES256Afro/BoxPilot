/**
 * The Pi-hole adapter (M37): what the Pi-hole Watcher and the Server Keeper may know about Pi-hole,
 * read by the root helper as a registered read-only operation (app.pihole.inspect), never by the
 * agents runner itself.
 *
 * Privacy is the shape of the answer: counts for the whole network - queries and blocked queries
 * in the last day, each upstream's share and answer time, the blocklist's age and size, and the
 * most blocked domains as totals. Nothing names a client: no query below reads the client column,
 * so which device asked for what never leaves Pi-hole's database (M37 guardrail; the owner may opt
 * in to more later, and that would be a separate, owner-only read).
 *
 * It answers "is Pi-hole a BoxPilot container or running natively?" first, because every other
 * read depends on where it is: BoxPilot's own app (bp-pi-hole), another Docker container from the
 * pihole/pihole image, or pihole-FTL as a systemd service on the host. Every query is fixed text;
 * the only value put into one is a whole number of seconds this module computes.
 */

export const blockedStatuses = Object.freeze([1, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 18]);
const ftlDatabase = "/etc/pihole/pihole-FTL.db";
const gravityDatabase = "/etc/pihole/gravity.db";

/** The fixed reads, given the start of the window in Unix seconds. */
export function piholeQueries(since) {
  const from = Math.max(0, Math.floor(Number(since) || 0));
  const blocked = blockedStatuses.join(",");
  return {
    totals: `SELECT COUNT(*), COALESCE(SUM(CASE WHEN status IN (${blocked}) THEN 1 ELSE 0 END), 0) FROM queries WHERE timestamp >= ${from};`,
    topBlocked: `SELECT domain, COUNT(*) AS hits FROM queries WHERE timestamp >= ${from} AND status IN (${blocked}) GROUP BY domain ORDER BY hits DESC LIMIT 10;`,
    upstreams: `SELECT forward, COUNT(*) AS hits, AVG(reply_time) FROM queries WHERE timestamp >= ${from} AND forward IS NOT NULL AND forward != '' GROUP BY forward ORDER BY hits DESC LIMIT 8;`,
    gravity: "SELECT property, value FROM info WHERE property IN ('updated', 'gravity_count');",
  };
}

/** sqlite3 shell output with a tab separator, as rows of fields. */
export function parseRows(text) {
  return String(text ?? "").split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.trim()).map((line) => line.split("\t"));
}

const domainPattern = /^[A-Za-z0-9._-]{1,253}$/;
const upstreamPattern = /^[A-Za-z0-9.:#[\]_-]{1,120}$/;

/** The answer from the four reads' output, bounded and checked field by field. */
export function summarize({ totals, topBlocked, upstreams, gravity, blocking, now = new Date() }) {
  const [total = "0", blockedCount = "0"] = parseRows(totals)[0] ?? [];
  const queries = Number.parseInt(total, 10) || 0;
  const blocked = Number.parseInt(blockedCount, 10) || 0;
  const info = Object.fromEntries(parseRows(gravity).map(([property, value]) => [property, value]));
  const updated = Number.parseInt(info.updated, 10);
  const updatedAt = Number.isFinite(updated) && updated > 0 ? new Date(updated * 1000).toISOString() : null;
  const forwarded = parseRows(upstreams).filter(([upstream]) => upstreamPattern.test(upstream ?? "")).map(([upstream, hits, reply]) => ({ upstream, queries: Number.parseInt(hits, 10) || 0, averageReplyMs: Number.isFinite(Number.parseFloat(reply)) ? Math.round(Number.parseFloat(reply) * 1000) : null }));
  const forwardedTotal = forwarded.reduce((sum, entry) => sum + entry.queries, 0);
  return {
    blocking: blocking === "true" ? true : blocking === "false" ? false : null,
    last24h: { queries, blocked, blockedPercent: queries ? Math.round((blocked / queries) * 1000) / 10 : 0 },
    gravity: {
      domains: Number.parseInt(info.gravity_count, 10) || null,
      updatedAt,
      ageDays: updatedAt ? Math.round(((now.getTime() - Date.parse(updatedAt)) / 86_400_000) * 10) / 10 : null,
    },
    upstreams: forwarded.map((entry) => ({ ...entry, share: forwardedTotal ? Math.round((entry.queries / forwardedTotal) * 1000) / 10 : 0 })),
    topBlocked: parseRows(topBlocked).filter(([domain]) => domainPattern.test(domain ?? "")).map(([domain, hits]) => ({ domain, count: Number.parseInt(hits, 10) || 0 })),
  };
}

/**
 * The reader, for the helper. `apps.inspect()` says whether BoxPilot installed Pi-hole; `run` is
 * the helper's fixed-binary runner.
 */
export function createPiholeReader({
  run,
  apps = null,
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  systemctlBinary = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  ftlBinary = "/usr/bin/pihole-FTL",
  now = () => new Date(),
} = {}) {
  /** Where Pi-hole runs: BoxPilot's app, another container, the host, or nowhere. */
  async function locate() {
    const listed = apps ? await apps.inspect({}).catch(() => null) : null;
    const app = (listed?.applications ?? []).find((entry) => entry?.id === "pi-hole" && entry.installed);
    if (app) return { placement: "boxpilot-app", container: "bp-pi-hole", running: app.container?.running === true, unit: null };
    const containers = await run(dockerBinary, ["ps", "--all", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}"], { timeout: 15_000 }).catch(() => ({ ok: false, stdout: "" }));
    if (containers.ok) {
      for (const [name, image, state] of parseRows(containers.stdout)) {
        if (/(^|\/)pihole\/pihole(:|@|$)/.test(image ?? "") && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name ?? "")) return { placement: "container", container: name, running: state === "running", unit: null };
      }
    }
    const unit = await run(systemctlBinary, ["show", "pihole-FTL.service", "--property=LoadState,ActiveState"], { timeout: 10_000 }).catch(() => ({ ok: false, stdout: "" }));
    const values = Object.fromEntries(String(unit.stdout ?? "").split("\n").map((line) => line.split("=", 2)).filter((pair) => pair.length === 2));
    if (values.LoadState === "loaded") return { placement: "host", container: null, running: values.ActiveState === "active", unit: "pihole-FTL.service" };
    return { placement: "absent", container: null, running: false, unit: null };
  }

  async function inspect() {
    const readAt = now();
    const where = await locate();
    const base = { ...where, readAt: readAt.toISOString() };
    if (where.placement === "absent") return { ...base, available: false, reason: "Pi-hole is not installed on this server: not as a BoxPilot app, not as another container, not as a host service." };
    if (!where.running) return { ...base, available: false, reason: where.placement === "host" ? "pihole-FTL.service is not running." : `The ${where.container} container is not running.` };
    const exec = (args) => (where.container
      ? run(dockerBinary, ["exec", where.container, "pihole-FTL", ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })
      : run(ftlBinary, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }));
    const sql = (database, text) => exec(["sqlite3", "-readonly", "-separator", "\t", database, text]);
    const queries = piholeQueries(Math.floor(readAt.getTime() / 1000) - 86_400);
    const [totals, topBlocked, upstreams, gravity, blocking] = await Promise.all([
      sql(ftlDatabase, queries.totals), sql(ftlDatabase, queries.topBlocked), sql(ftlDatabase, queries.upstreams), sql(gravityDatabase, queries.gravity),
      exec(["--config", "dns.blocking.active"]),
    ].map((pending) => pending.catch(() => ({ ok: false, stdout: "" }))));
    if (!totals.ok) return { ...base, available: false, reason: "Pi-hole's query database could not be read." };
    return { ...base, available: true, ...summarize({ totals: totals.stdout, topBlocked: topBlocked.ok ? topBlocked.stdout : "", upstreams: upstreams.ok ? upstreams.stdout : "", gravity: gravity.ok ? gravity.stdout : "", blocking: blocking.ok ? String(blocking.stdout).trim() : null, now: readAt }) };
  }

  return { inspect, locate };
}

/** The answer as a few lines for an agent: counts, never clients. */
export function describePihole(result) {
  if (!result) return "Pi-hole could not be read.";
  const where = { "boxpilot-app": `Pi-hole runs as the BoxPilot app (container ${result.container}).`, container: `Pi-hole runs as a Docker container BoxPilot did not install (${result.container}).`, host: "Pi-hole runs natively on the host (pihole-FTL.service).", absent: "Pi-hole is not installed on this server." }[result.placement] ?? "Where Pi-hole runs is not known.";
  if (!result.available) return `${where} ${result.reason ?? ""}`.trim();
  const lines = [
    where,
    `Blocking: ${result.blocking === true ? "on" : result.blocking === false ? "OFF" : "unknown"}.`,
    `Last 24 hours: ${result.last24h.queries} queries, ${result.last24h.blocked} blocked (${result.last24h.blockedPercent}%).`,
    `Blocklists: ${result.gravity.domains ?? "unknown"} domains, updated ${result.gravity.updatedAt ?? "at an unknown time"}${result.gravity.ageDays !== null ? ` (${result.gravity.ageDays} days ago)` : ""}.`,
    result.upstreams.length ? `Upstreams: ${result.upstreams.map((entry) => `${entry.upstream} ${entry.share}% of forwarded, ${entry.averageReplyMs ?? "?"} ms average`).join("; ")}.` : "Upstreams: no forwarded queries in the last 24 hours.",
    result.topBlocked.length ? `Most blocked (network-wide totals): ${result.topBlocked.slice(0, 5).map((entry) => `${entry.domain} ${entry.count}`).join(", ")}.` : null,
  ];
  return lines.filter(Boolean).join("\n");
}
