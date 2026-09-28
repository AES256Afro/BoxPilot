// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRedactor } from "../redaction.mjs";
import { buildPrompt, fallbackAnswer, finalRedaction, systemPrompt, verifyCitations } from "./prompt.mjs";
import { createPlanFilter } from "./index.mjs";

const sources = [
  { kind: "doc", title: "docs/BACKUPS.md › Restore", ref: { path: "docs/BACKUPS.md", heading: "Restore" }, text: "Open the app's card and pick a backup." },
  { kind: "job", title: "Job Back up Jellyfin (failed)", ref: { jobId: "j1" }, text: "Error: disk full" },
];

describe("buildPrompt", () => {
  it("numbers the sources in order and tells the model who is asking", () => {
    const prompt = buildPrompt({ question: "Why did the backup fail?", sources, role: "operator", now: new Date("2026-09-28T12:00:00Z") });
    expect(prompt.sources.map((source) => source.id)).toEqual(["S1", "S2"]);
    expect(prompt.messages[0]).toEqual({ role: "system", content: systemPrompt });
    const user = prompt.messages[1].content;
    expect(user).toContain("Question: Why did the backup fail?");
    expect(user).toContain("[S1] Document: docs/BACKUPS.md › Restore\nOpen the app's card");
    expect(user).toContain("[S2] Job: Job Back up Jellyfin (failed)\nError: disk full");
    expect(user).toContain("The person asking is an operator");
    expect(user).toContain("Now: 2026-09-28T12:00:00.000Z");
  });

  it("leaves out a source that would not fit, whole, rather than cutting it", () => {
    const big = { kind: "doc", title: "big", ref: {}, text: "x".repeat(5000) };
    const prompt = buildPrompt({ question: "q", sources: [sources[0], big, sources[1]], role: "owner", promptChars: systemPrompt.length + 1500 });
    expect(prompt.sources.map((source) => source.title)).toEqual([sources[0].title, sources[1].title]);
    expect(prompt.sources.map((source) => source.id)).toEqual(["S1", "S2"]);
    expect(prompt.messages[1].content).not.toContain("xxxxx");
  });

  it("passes every source and the question through the redactor on the way in", () => {
    const leaky = { kind: "log", title: "Last lines", ref: {}, text: "RESTIC_PASSWORD=hunter22\nAuthorization: Bearer abc.def.ghi\nhttps://user:pw@example.test/x" };
    const prompt = buildPrompt({ question: "my token=abcd1234 does not work", sources: [leaky], role: "owner", redactor: createRedactor({ additionalLiterals: ["private-literal"] }) });
    const user = prompt.messages[1].content;
    for (const secret of ["hunter22", "abc.def.ghi", "user:pw", "abcd1234"]) expect(user).not.toContain(secret);
    expect(finalRedaction("a private-literal b", createRedactor({ additionalLiterals: ["private-literal"] }))).toBe("a [REDACTED_LITERAL] b");
    // Longer than the redactor takes at once, and still redacted to the end.
    const long = `${"line of text\n".repeat(600)}password=hunter22`;
    expect(finalRedaction(long, createRedactor())).not.toContain("hunter22");
  });
});

describe("verifyCitations", () => {
  const given = [{ id: "S1" }, { id: "S2" }];

  it("separates ids the model was given from ids it made up, and accepts a list in one bracket", () => {
    const result = verifyCitations("The backup failed because the disk was full [S2, S9]. Restore from the card [S1].", given);
    expect(result.cited).toEqual(["S2", "S1"]);
    expect(result.unknown).toEqual(["S9"]);
    expect(result.uncited).toEqual([]);
  });

  it("lists each sentence that states something without a source", () => {
    const answer = "The backup failed because the disk was full [S2].\nThe server also needs a new power supply right now.\nIs the drive mounted?\nI am not sure why it stopped at night.";
    expect(verifyCitations(answer, given).uncited).toEqual(["The server also needs a new power supply right now."]);
  });

  it("does not count the plan block as a claim", () => {
    const answer = 'Restart it [S1].\n```plan\n[{"operationId": "app.restart", "parameters": {"id": "jellyfin"}, "why": "It should come back up after this."}]\n```';
    expect(verifyCitations(answer, given).uncited).toEqual([]);
  });
});

describe("fallbackAnswer", () => {
  it("says why there is no answer and lists what was found, each with its id", () => {
    const text = fallbackAnswer({ reason: "no-model", sources: [{ id: "S1", title: "docs/BACKUPS.md › Restore", text: "Open the app's card and pick a backup." }] });
    expect(text).toContain("No local model is set up");
    expect(text).toContain("- [S1] docs/BACKUPS.md › Restore: Open the app's card and pick a backup.");
  });
});

describe("streaming", () => {
  it("never sends the plan block, even when its fence arrives in pieces", () => {
    const sent = [];
    const filter = createPlanFilter((piece) => sent.push(piece));
    let full = "";
    for (const piece of ["Restart it [S1].\n", "`", "``", "pl", "an\n[{\"operationId\"", ": \"app.restart\"}]\n```"]) {
      full += piece;
      filter(full);
    }
    expect(sent.join("")).toBe("Restart it [S1].\n");
  });
});
