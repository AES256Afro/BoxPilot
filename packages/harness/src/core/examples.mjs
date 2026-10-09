/**
 * Which examples a model is shown (M46). A host keeps examples of work that went well: a request
 * and the plan, tools or answer that a person approved. Before the model plans a new request, a few
 * of them go into the prompt as demonstrations. Which few is decided here, by geometry rather than
 * by volume: not the most similar k (which are mostly the same example k times), not all of them
 * (which costs context a small model has none of to spare), but a small set that covers the
 * neighbourhood of the request and shows where its decisions fall.
 *
 * Each candidate is `{ key, text, label?, vector?, ... }`: the request's words, what was done for it
 * (`label`, say the first tool chosen), and its embedding when the host has one. The query is the
 * new request, with its embedding when the host could make one. Three rules pick the set:
 *
 * 1. **Nearest first.** The most relevant candidate: cosine between unit vectors when both sides
 *    have one, else the share of the query's words the candidate shares (vectors and words mix, so
 *    a candidate without a vector still competes).
 * 2. **One from the other side.** When a candidate relevant enough carries a different label from
 *    the first pick, one such is kept: the model then sees the boundary between two choices ("where
 *    does Pi-hole run" is one tool, "is Pi-hole blocking" another) rather than one choice repeated.
 * 3. **Then the rest by maximal marginal relevance** (Carbonell and Goldstein, 1998): each next
 *    pick is the candidate with the best λ·relevance − (1 − λ)·(similarity to what is already
 *    picked), so the set spreads across the neighbourhood. A candidate as good as a duplicate of a
 *    pick (similarity at or above `dedupeAbove`, or the same words) is never added.
 *
 * Nothing here calls a model: it is arithmetic on what the host already has, and a test can hold
 * every rule.
 */

export const exampleDefaults = Object.freeze({ limit: 3, lambda: 0.7, dedupeAbove: 0.95, minRelevance: 0.15, contrastShare: 0.6 });

// Words that say nothing about what a request is for. "where", "when" and "why" stay: they are what
// tells "where does X run" from "is X running".
const stopWords = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "it", "its", "this", "that", "these", "those", "of", "on", "in", "to", "for", "and", "or", "at", "by", "with", "from", "as", "what", "which", "how", "my", "our", "your", "i", "you", "we", "they", "me", "us", "there", "here", "now", "please", "can", "could", "should", "would", "will", "any", "some", "right", "just"]);
const words = (text) => new Set((String(text ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((word) => !stopWords.has(word)));

/** Cosine of two vectors (unit length or not); null when either is missing or they differ in size. */
export function cosineOf(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0; let la = 0; let lb = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index] * b[index]; la += a[index] * a[index]; lb += b[index] * b[index]; }
  const length = Math.sqrt(la) * Math.sqrt(lb);
  return length ? dot / length : null;
}

/** The share of the shorter text's words the two share: 1 for the same words, 0 for none. */
export function wordOverlap(a, b) {
  const wa = words(a); const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

/** How alike two candidates are: by vector when both have one, else by words. */
function similarity(a, b) {
  const byVector = cosineOf(a.vector, b.vector);
  return byVector ?? wordOverlap(a.text, b.text);
}

/** How relevant a candidate is to the query: by vector when both have one, else by words. */
function relevanceOf(candidate, { query, queryVector }) {
  const byVector = cosineOf(candidate.vector, queryVector);
  return byVector ?? wordOverlap(query, candidate.text);
}

const sameWords = (a, b) => {
  const wa = [...words(a)].sort().join(" "); const wb = [...words(b)].sort().join(" ");
  return wa.length > 0 && wa === wb;
};

/**
 * Pick up to `limit` examples for `query` from `candidates`.
 *
 * @param {{
 *   query: string, queryVector?: number[] | Float32Array | null,
 *   candidates: Array<{ key: string, text: string, label?: string | null, vector?: number[] | Float32Array | null }>,
 *   limit?: number, lambda?: number, dedupeAbove?: number, minRelevance?: number, contrastShare?: number,
 * }} input
 * @returns {Array<object & { relevance: number, why: "nearest" | "contrast" | "diverse" }>} the picks,
 *   each the candidate with its relevance (0 to 1, rounded) and why it is in: the nearest, the one
 *   from the other side of a decision, or one that spreads the set.
 */
export function selectExamples({ query = "", queryVector = null, candidates = [], limit = exampleDefaults.limit, lambda = exampleDefaults.lambda, dedupeAbove = exampleDefaults.dedupeAbove, minRelevance = exampleDefaults.minRelevance, contrastShare = exampleDefaults.contrastShare } = {}) {
  const pool = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate && typeof candidate.text === "string" && candidate.text.trim());
  if (!pool.length || limit <= 0) return [];
  const scored = pool.map((candidate) => ({ candidate, relevance: relevanceOf(candidate, { query, queryVector }) })).filter((entry) => entry.relevance >= minRelevance);
  if (!scored.length) return [];
  scored.sort((a, b) => b.relevance - a.relevance);
  const picks = [];
  const duplicate = (entry) => picks.some((pick) => sameWords(pick.candidate.text, entry.candidate.text) || similarity(pick.candidate, entry.candidate) >= dedupeAbove);
  const take = (entry, why) => picks.push({ ...entry, why });
  take(scored[0], "nearest");
  // One from the other side of the first pick's decision, when there is one that is relevant enough.
  const first = scored[0];
  const firstLabel = first.candidate.label ?? null;
  if (picks.length < limit && firstLabel !== null) {
    const other = scored.find((entry) => entry !== first && (entry.candidate.label ?? null) !== firstLabel && entry.relevance >= first.relevance * contrastShare && !duplicate(entry));
    if (other) take(other, "contrast");
  }
  // The rest by maximal marginal relevance.
  while (picks.length < limit) {
    let best = null; let bestScore = -Infinity;
    for (const entry of scored) {
      if (picks.some((pick) => pick.candidate === entry.candidate) || duplicate(entry)) continue;
      const nearestPick = Math.max(...picks.map((pick) => similarity(pick.candidate, entry.candidate)));
      const score = lambda * entry.relevance - (1 - lambda) * nearestPick;
      if (score > bestScore) { bestScore = score; best = entry; }
    }
    if (!best) break;
    take(best, "diverse");
  }
  return picks.map(({ candidate, relevance, why }) => ({ ...candidate, relevance: Math.round(relevance * 1_000) / 1_000, why }));
}

/**
 * A set of examples that covers a collection (M46): for an export or a review, the `limit` examples
 * farthest from one another, so a reader (or a fine-tune) sees the breadth rather than the bulk.
 * k-center greedy: start from the first, then always add the candidate farthest from every pick.
 * Candidates without vectors are placed by words.
 */
export function coverExamples({ candidates = [], limit = 10 } = {}) {
  const pool = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate && typeof candidate.text === "string" && candidate.text.trim());
  if (!pool.length || limit <= 0) return [];
  const picks = [pool[0]];
  while (picks.length < Math.min(limit, pool.length)) {
    let farthest = null; let farthestDistance = -Infinity;
    for (const candidate of pool) {
      if (picks.includes(candidate)) continue;
      const nearest = Math.max(...picks.map((pick) => similarity(pick, candidate)));
      const distance = 1 - nearest;
      if (distance > farthestDistance) { farthestDistance = distance; farthest = candidate; }
    }
    if (!farthest) break;
    picks.push(farthest);
  }
  return picks;
}
