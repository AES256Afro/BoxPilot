/**
 * Which automation this server in particular should have (M24.1).
 *
 * The shelf has always listed every built-in flow. What it could not say is why any of them is
 * worth adding *here*, so it read as a catalogue: three equally plausible options, no reason to
 * pick one, and the owner picks none. A suggestion is the same shelf item with the evidence
 * attached - "fourteen backups on this box and nothing copies them off it" - which is the part
 * that turns a list into a decision.
 *
 * Rules, deliberately:
 * - Nothing is ever created. A suggestion is an argument for pressing the button that was already
 *   there; the owner presses it.
 * - Every suggestion cites a fact read from this server. No suggestion fires on a hunch, and one
 *   whose evidence has gone away stops being made.
 * - A flow already on the shelf is never suggested again, however good the argument.
 *
 * Pure: it is handed facts and returns reasons.
 */

const GiB = 1024 ** 3;

/** Bytes as the shortest sensible unit, for a sentence rather than a table. */
function size(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 * GiB) return `${(bytes / (1024 * GiB)).toFixed(1)} TB`;
  if (bytes >= GiB) return `${Math.round(bytes / GiB)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} MB`;
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * The case for each built-in flow, made only from what this server actually reports. Each returns
 * a sentence or null; null means there is no argument to make today.
 */
const arguments_ = {
  "belt-and-braces": ({ backups, offBox }) => {
    if (!backups?.total) return null;                       // nothing to lose yet
    if (offBox?.configured && offBox?.lastSyncAt) return null; // already covered
    const one = backups.total === 1;
    if (offBox?.configured) return `${plural(backups.total, "backup is", "backups are")} on this box and the off-box destination has never been used.`;
    return `${plural(backups.total, "backup is", "backups are")} on this box and nothing copies ${one ? "it" : "them"} anywhere else. A dead disk takes ${one ? "it" : "all of them"}.`;
  },
  "tidy-docker": ({ reclaimable }) => {
    if (!Number.isFinite(reclaimable) || reclaimable < 5 * GiB) return null;
    return `${size(reclaimable)} of Docker layers and build cache nothing is using. It comes back on its own if it is ever needed.`;
  },
  "update-night": ({ updates }) => {
    if (!updates?.total) return null;
    if (updates.security) return `${plural(updates.total, "update is", "updates are")} waiting, ${updates.security} of them security.`;
    return `${plural(updates.total, "update is", "updates are")} waiting.`;
  },
};

/**
 * Suggestions for the shelf, strongest first.
 *
 * `shelf` is what the library offers, `flows` what the owner already has. A shelf item counts as
 * taken when a flow runs the same operations, not merely when the names match: renaming a copy of
 * Update night must not make BoxPilot start recommending it again.
 */
export function suggestFlows({ shelf = [], flows = [], facts = {} } = {}) {
  const taken = new Set(flows.flatMap((flow) => [
    flow.slug ?? null,
    (flow.steps ?? []).map((step) => step.operationId).join(">"),
  ]).filter(Boolean));

  const suggestions = [];
  for (const item of shelf) {
    const signature = (item.steps ?? []).map((step) => step.operationId).join(">");
    if (taken.has(item.slug) || (signature && taken.has(signature))) continue;
    const because = arguments_[item.slug]?.(facts);
    if (!because) continue;
    suggestions.push({ slug: item.slug, name: item.name, description: item.description, because });
  }
  return suggestions;
}

/**
 * Reduce what the pages already read into the handful of facts the arguments above need. Kept
 * beside them so adding an argument means adding its evidence here, in one place.
 */
export function suggestionFacts({ backups = [], offBoxDestination = null, offBoxLastSyncAt = null, housekeeping = null, updates = null } = {}) {
  const reclaimable = (housekeeping?.groups ?? [])
    .filter((group) => group.safe && ["docker-unused", "docker-build-cache"].includes(group.id))
    .reduce((total, group) => total + (Number(group.bytes) || 0), 0);
  return {
    backups: { total: Array.isArray(backups) ? backups.length : 0 },
    offBox: { configured: Boolean(offBoxDestination), lastSyncAt: offBoxLastSyncAt ?? null },
    reclaimable,
    updates: { total: Number(updates?.total) || 0, security: Number(updates?.security) || 0 },
  };
}
