/**
 * Agents' memory (M37), kept dependency-light: SQLite and plain arithmetic.
 *
 * Short-term: a conversation per agent and person. The last turns go to the model word for word;
 * older ones are folded into a running summary, so the conversation always fits the model's
 * 8,192-token context (-c 8192) beside the rules, the tools and the tool output. The summary is
 * extractive (each question and the first sentence of its answer), so keeping it costs no model
 * time.
 *
 * Long-term: facts agents learned (their notes, shared with other agents when the writer allows,
 * each only as far as the reader's runs may read), what past runs found (episodes), and what the
 * owner pinned (facts and documents). Each item may carry an embedding, stored as a BLOB of 32-bit
 * floats beside it; search is brute-force cosine over a few thousand vectors, fused with BM25 by
 * reciprocal rank, so meaning and exact words both count and a server without embeddings still
 * finds things by their words.
 */
import { createBm25, tokenize } from "../assistant/knowledge.mjs";

// ---- vectors ----

/** A vector as stored: little-endian 32-bit floats, unit length. */
export function encodeVector(values) {
  const vector = Float32Array.from(values, (value) => (Number.isFinite(value) ? value : 0));
  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= length;
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeVector(blob) {
  if (!blob || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** Cosine of two unit vectors: their dot product. Vectors of different sizes never compare. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

/** A vector from what the runner sent: numbers only, a sane size. */
export function readVector(value, { maxDims = 4_096 } = {}) {
  if (!Array.isArray(value) || value.length < 8 || value.length > maxDims || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) return null;
  return value;
}

// ---- search ----

/**
 * Hybrid retrieval: BM25 over the words and cosine over the vectors, fused by reciprocal rank
 * (1 / (60 + rank)) so neither scale swamps the other. `items` are { key, title, text, vector? }
 * with vectors already decoded; `queryVector` may be null (words only).
 */
export function hybridSearch(items, { query, queryVector = null, limit = 5, minCosine = 0.35 } = {}) {
  if (!items.length) return [];
  const fused = new Map();
  const add = (index, rank, via) => {
    const entry = fused.get(index) ?? { index, score: 0, via: new Set() };
    entry.score += 1 / (60 + rank);
    entry.via.add(via);
    fused.set(index, entry);
  };
  const words = [...createBm25(items.map((item) => ({ title: item.title ?? "", text: item.text ?? "", weight: item.weight ?? 1 }))).search(tokenize(query))]
    .sort((a, b) => b[1] - a[1]).slice(0, 50);
  words.forEach(([index], rank) => add(index, rank, "words"));
  if (queryVector) {
    const query32 = Float32Array.from(queryVector);
    let length = 0;
    for (const value of query32) length += value * value;
    length = Math.sqrt(length) || 1;
    for (let index = 0; index < query32.length; index += 1) query32[index] /= length;
    const meaning = items.map((item, index) => [index, cosine(item.vector, query32)]).filter(([, score]) => score !== null && score >= minCosine)
      .sort((a, b) => b[1] - a[1]).slice(0, 50);
    meaning.forEach(([index], rank) => add(index, rank, "meaning"));
  }
  // The best few by fused score, then spread (M46.2): the top k alone is often one fact k times.
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(limit * 3, 12)).map((entry) => ({ ...items[entry.index], score: Math.round(entry.score * 10_000) / 10_000, via: [...entry.via] }));
  return diversify(ranked, { limit });
}

const itemWords = (item) => new Set(tokenize(`${item.title ?? ""} ${String(item.text ?? "").slice(0, 1_000)}`));

/**
 * How alike two remembered items are: cosine when both have vectors, else the share of the shorter
 * one's words the two share (a finding that quotes a note shares all of the note's words).
 */
export function itemSimilarity(a, b) {
  const byVector = cosine(a.vector, b.vector);
  if (byVector !== null) return byVector;
  const wa = itemWords(a); const wb = itemWords(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

/**
 * Spread what recall returns (M46.2, ADR-014): from items ranked by score, pick `limit` by maximal
 * marginal relevance - each next pick the one with the best λ·relevance − (1 − λ)·(similarity to
 * what is already picked), relevance being the score against the best - and never a near-copy of a
 * pick (similarity at or above `dedupeAbove`). The same fact as a note, an episode and a finding
 * then fills one place, not three.
 */
export function diversify(ranked, { limit = 5, lambda = 0.7, dedupeAbove = 0.95 } = {}) {
  if (!ranked.length || limit <= 0) return [];
  const top = ranked[0].score || 1;
  const picks = [];
  while (picks.length < limit) {
    let best = null; let bestScore = -Infinity;
    for (const item of ranked) {
      if (picks.includes(item)) continue;
      const nearest = picks.length ? Math.max(...picks.map((pick) => itemSimilarity(pick, item))) : 0;
      if (nearest >= dedupeAbove) continue;
      const score = lambda * (item.score / top) - (1 - lambda) * nearest;
      if (score > bestScore) { bestScore = score; best = item; }
    }
    if (!best) break;
    picks.push(best);
  }
  return picks;
}

// ---- conversations ----

const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const firstSentence = (text) => clip(String(text ?? "").replace(/\[[TF]\d+(?:\s*[,;]\s*[TF]\d+)*\]/g, "").split(/(?<=[.!?])\s/)[0], 160);

/** How much conversation reaches the model: about 1,100 tokens of turns and 300 of summary. */
export const threadBudget = Object.freeze({ turnChars: 4_400, summaryChars: 1_200, perTurnChars: 900 });

/**
 * Fold a conversation to fit: keep the last `keep` exchanges word for word (each turn clipped),
 * while they fit the budget; fold everything older into the running summary, oldest dropped first
 * when the summary itself is full. Returns what to keep and what the model sees.
 */
export function foldThread({ summary = "", turns = [] }, { keep = 6, budget = threadBudget } = {}) {
  const kept = [];
  let chars = 0;
  // Newest first, whole exchanges (a question and its answer) at a time.
  const exchanges = [];
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].role === "user") exchanges.push([turns[index]]);
    else if (exchanges.length) exchanges[exchanges.length - 1].push(turns[index]);
  }
  const older = [];
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index].map((turn) => ({ ...turn, text: clip(turn.text, budget.perTurnChars) }));
    const size = exchange.reduce((sum, turn) => sum + turn.text.length, 0);
    if (kept.length < keep && chars + size <= budget.turnChars) { kept.unshift(exchange); chars += size; } else older.unshift(exchanges[index]);
  }
  let folded = summary ? [summary] : [];
  for (const exchange of older) {
    const question = exchange.find((turn) => turn.role === "user");
    const answer = exchange.find((turn) => turn.role !== "user");
    folded.push(`Asked "${clip(question?.text, 100)}"${answer ? `; answered: ${firstSentence(answer.text)}` : ""}.`);
  }
  let text = folded.join(" ");
  while (text.length > budget.summaryChars && folded.length > 1) { folded = folded.slice(1); text = folded.join(" "); }
  if (text.length > budget.summaryChars) text = `…${text.slice(-(budget.summaryChars - 1))}`;
  return { summary: text, turns: kept.flat(), folded: older.length };
}

// ---- tiers ----

export const memoryTiers = Object.freeze({
  fact: "Facts it learned",
  episode: "What past runs found",
  pinned: "Pinned by the owner",
});

/** An episode: what a run found, in a line or two, for later runs to recall. */
export function episodeOf(run, { maxChars = 400 } = {}) {
  const asked = run.question ? `Asked "${clip(run.question, 120)}". ` : run.trigger?.title ? `${clip(run.trigger.title, 120)}. ` : "";
  const found = run.answer ? clip(String(run.answer).replace(/[ \t]*\[[TF]\d+(?:\s*[,;]\s*[TF]\d+)*\]/g, ""), maxChars) : "";
  return found ? `${asked}${found}` : null;
}
