// @vitest-environment node
import { describe, expect, it } from "vitest";
import { coverExamples, cosineOf, exampleDefaults, selectExamples, wordOverlap } from "../src/index.mjs";

/*
 * Which examples a model is shown (M46): the nearest first, one from the other side of its decision,
 * the rest spread by maximal marginal relevance, duplicates never, by vectors when there are some
 * and by words when there are none.
 */

// Unit vectors in a plane: where (1,0) is "where does X run", (0,1) is "is X blocking", and so on.
const at = (angle) => [Math.cos(angle), Math.sin(angle)];
const deg = (value) => (value * Math.PI) / 180;

const pool = [
  { key: "where-pihole", text: "Where does Pi-hole run on this server?", label: "where.runs", vector: at(deg(0)) },
  { key: "where-pihole-2", text: "Where does Pi-hole run on this server?", label: "where.runs", vector: at(deg(1)) },
  { key: "where-jellyfin", text: "Is Jellyfin a BoxPilot app or something else?", label: "where.runs", vector: at(deg(20)) },
  { key: "blocking", text: "Is Pi-hole blocking ads right now?", label: "pihole.stats", vector: at(deg(45)) },
  { key: "stopped", text: "Which BoxPilot apps are stopped?", label: "apps.list", vector: at(deg(70)) },
  { key: "drives", text: "Which drives are connected?", label: "storage.health", vector: at(deg(150)) },
];

describe("relevance and similarity", () => {
  it("measures cosine for vectors and word overlap for text", () => {
    expect(cosineOf([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineOf([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineOf([1, 0], [1, 0, 0])).toBeNull();
    expect(cosineOf(null, [1])).toBeNull();
    expect(wordOverlap("where does pi-hole run", "Where does Pi-hole run on this server?")).toBe(1);
    expect(wordOverlap("drives connected", "Is Pi-hole blocking?")).toBe(0);
    // Words that say nothing about the request do not count as shared.
    expect(wordOverlap("What time is it?", "Is Pi-hole blocking ads right now?")).toBe(0);
    expect(wordOverlap("", "anything")).toBe(0);
  });
});

describe("selecting examples", () => {
  it("takes the nearest, then one with another label, then spreads the rest", () => {
    const picks = selectExamples({ query: "Where does Pi-hole run?", queryVector: at(deg(2)), candidates: pool, limit: 3 });
    // The twin a degree away is nearest; Pi-hole's other tool is the contrast; the third is the relevant
    // example that is not a copy of either (the far-off drives question is below the floor).
    expect(picks.map((pick) => [pick.key, pick.why])).toEqual([["where-pihole-2", "nearest"], ["blocking", "contrast"], ["where-jellyfin", "diverse"]]);
    // Rounded relevance, the candidate's own fields kept.
    expect(picks[0].relevance).toBeCloseTo(1, 2);
    expect(picks[0].label).toBe("where.runs");
  });

  it("never adds a duplicate of a pick, by vector or by words", () => {
    // Two copies of the same request with near-identical vectors: one is enough. The next pick is
    // a different example; a third that is near enough to count as a copy (cosine 0.95, about 18
    // degrees) is left out too.
    const picks = selectExamples({ query: "Where does Pi-hole run?", queryVector: at(deg(0)), candidates: pool.slice(0, 3), limit: 3 });
    expect(picks.map((pick) => pick.key)).toEqual(["where-pihole", "where-jellyfin"]);
    const nearCopy = selectExamples({ query: "Where does Pi-hole run?", queryVector: at(deg(0)), candidates: [pool[0], { ...pool[2], vector: at(deg(8)) }], limit: 3 });
    expect(nearCopy.map((pick) => pick.key)).toEqual(["where-pihole"]);
    const byWords = selectExamples({ query: "where does pi-hole run", candidates: pool.slice(0, 2).map(({ vector: _vector, ...rest }) => rest), limit: 3 });
    expect(byWords.map((pick) => pick.key)).toEqual(["where-pihole"]);
  });

  it("works by words alone when there are no vectors, mixing in a candidate that has none", () => {
    const noVectors = pool.map(({ vector: _vector, ...rest }) => rest);
    const picks = selectExamples({ query: "Is Pi-hole blocking?", candidates: noVectors, limit: 2 });
    expect(picks[0].key).toBe("blocking");
    expect(picks[0].why).toBe("nearest");
    // A candidate with no vector still competes against ones with vectors: relevance falls back to words for it.
    const mixed = [{ ...pool[3], vector: null }, pool[0], pool[4]];
    const withQuery = selectExamples({ query: "Is Pi-hole blocking ads?", queryVector: at(deg(60)), candidates: mixed, limit: 1 });
    expect(withQuery[0].key).toBe("blocking");
  });

  it("drops candidates below the minimum relevance, and empty input gives nothing", () => {
    expect(selectExamples({ query: "What time is it?", candidates: pool.map(({ vector: _vector, ...rest }) => rest) })).toEqual([]);
    expect(selectExamples({ query: "x", candidates: [] })).toEqual([]);
    expect(selectExamples({ query: "x", candidates: pool, limit: 0 })).toEqual([]);
    // Far from everything: nothing relevant enough even with vectors.
    expect(selectExamples({ query: "other", queryVector: at(deg(-90)), candidates: pool, minRelevance: 0.5 })).toEqual([]);
  });

  it("keeps the contrast only when the other side is relevant enough", () => {
    // The only differently labelled example is far away: no contrast, the set spreads instead.
    const picks = selectExamples({ query: "where", queryVector: at(deg(0)), candidates: [pool[0], pool[2], pool[5]], limit: 2, minRelevance: -1 });
    expect(picks.map((pick) => pick.why)).toEqual(["nearest", "diverse"]);
    // With no labels there is nothing to contrast.
    const unlabelled = selectExamples({ query: "where", queryVector: at(deg(0)), candidates: pool.map(({ label: _label, ...rest }) => rest), limit: 2 });
    expect(unlabelled.map((pick) => pick.why)).toEqual(["nearest", "diverse"]);
  });

  it("has the documented defaults", () => {
    expect(exampleDefaults).toEqual({ limit: 3, lambda: 0.7, dedupeAbove: 0.95, minRelevance: 0.15, contrastShare: 0.6 });
  });
});

describe("covering a collection", () => {
  it("picks the examples farthest from one another, first one first", () => {
    const picks = coverExamples({ candidates: pool, limit: 3 });
    expect(picks.map((pick) => pick.key)).toEqual(["where-pihole", "drives", "stopped"]);
    expect(coverExamples({ candidates: pool, limit: 10 })).toHaveLength(pool.length);
    expect(coverExamples({ candidates: [], limit: 3 })).toEqual([]);
  });
});
