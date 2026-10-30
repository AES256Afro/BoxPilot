import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Comparison } from "./api";
import { Comparisons } from "./Evaluation";

/*
 * The routes side by side on the Evaluation tab (M45.7): how many each got right, how long a
 * question took, what Claude cost, and questions that ran locally when Claude could not take them.
 */

afterEach(cleanup);

const comparison: Comparison = {
  pairId: "p1", at: "2026-09-29T15:00:00Z", nightly: true,
  local: { evalId: "e1", state: "done", model: "unsloth/Qwen3.5-4B-GGUF", score: 0.6, right: 3, questions: 5, seconds: 41.2, dollars: 0, ranLocally: 0 },
  claude: { evalId: "e2", state: "done", model: "claude-opus-5-5", score: 1, right: 5, questions: 5, seconds: 6.4, dollars: 0.0312, ranLocally: 1 },
};

describe("local and Claude side by side", () => {
  it("shows each side's right answers, seconds and Claude's cost", () => {
    render(<Comparisons comparisons={[comparison]} now={Date.parse("2026-09-29T16:00:00Z")} nightly />);
    expect(screen.getByText("3 of 5 right (60%)")).toBeTruthy();
    expect(screen.getByText("5 of 5 right (100%)")).toBeTruthy();
    expect(screen.getByText(/6\.4 s a question · \$0\.0312 · 1 ran locally/)).toBeTruthy();
    expect(screen.getByText("compared every night")).toBeTruthy();
  });

  it("says a side is still asking", () => {
    render(<Comparisons comparisons={[{ ...comparison, claude: { ...comparison.claude!, state: "running" } }]} now={Date.parse("2026-09-29T16:00:00Z")} nightly={false} />);
    expect(screen.getByText("asking")).toBeTruthy();
  });
});
