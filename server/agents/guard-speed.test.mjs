import { describe, expect, it } from "vitest";
import { fill, slowness } from "../../test/hostile-text.mjs";
import { finalRedaction } from "../assistant/prompt.mjs";
import { createRedactor } from "../redaction.mjs";
import { boxLine, detectInjection, sanitizeUntrusted, stripWrapperBlocks } from "./guard.mjs";
import { chatText, messageWords, questionFrom, uploadsIn } from "./zulip.mjs";

/**
 * The guard reads every tool's output, every note and finding, and the chat formatter every post,
 * on the web process's event loop: text a log or a chat message put there (sweep 5). "<" and 64 KB
 * of spaces took the wrapper-tag rule over a second, a long run of spaces with no line end after it
 * did the same to stripWrapperBlocks' tidying, and many inline code spans were each checked against
 * every one before them.
 */
const hostile = {
  "< then spaces": (n) => `<${" ".repeat(n - 2)}x`,
  "< then new lines": (n) => `<${"\n".repeat(n - 2)}x`,
  "lines of < and spaces": (n) => fill(`<${" ".repeat(3_000)}x\n`, n),
  "< and spaces repeated": (n) => fill("<      ", n),
  "< spaces / spaces": (n) => `<${" ".repeat(n / 2 - 1)}/${" ".repeat(n / 2 - 2)}x`,
  "spaces with no line end": (n) => `${" ".repeat(n - 1)}x`,
  "spaces and tabs with no line end": (n) => `${fill(" \t", n - 1)}x`,
  "new lines": (n) => "\n".repeat(n),
  "inline code spans": (n) => fill("`a", n),
  "double and single backticks": (n) => fill("``a`", n),
  "backtick runs of every length": (n) => { let out = ""; for (let length = 1; out.length < n; length += 1) out += `${"`".repeat(length)}a`; return out.slice(0, n); },
  "fences": (n) => fill("```\n", n),
  "two kinds of fence": (n) => fill("```\n~~~~\n", n),
  "template token starts": (n) => fill("<|", n),
  "a long template token": (n) => `<|${"a".repeat(n - 4)}|>`,
  "instruction words": (n) => fill("ignore all ", n),
  "curl and pipes": (n) => fill("curl |", n),
  "fence and plan starts": (n) => fill("```", n),
  "fullwidth brackets and zero-width spaces": (n) => fill("＜ ​", n),
  "Cyrillic lookalikes": (n) => fill("ас", n),
  "a tag with many attributes": (n) => `<memory ${fill("id=", n - 9)}>`,
  "token_ repeated": (n) => fill("token_", n),
  "Markdown link starts": (n) => fill("[](", n),
  "upload links with no end": (n) => fill("[a](/user_uploads/x", n),
  "mention starts": (n) => fill("@_**a", n),
};

/** Many of our own tags: stripWrapperBlocks pairs them up tag by tag, and only ever reads a model's answer. */
const manyTags = {
  "open tags": (n) => fill("<memory>", n),
  "closing tags": (n) => fill("</memory>", n),
  "tags after words": (n) => fill("x <memory a>", n),
  "spaced tags with an id": (n) => fill("< memory id=1>", n),
  "tags in code": (n) => fill("`<memory>`", n),
  "tags and code": (n) => fill("`a` <memory> ", n),
  "pairs": (n) => fill("<memory>a</memory>", n),
  "mixed tags": (n) => fill("<memory><finding></tool_output>", n),
};

const redactor = createRedactor();
const redact = (text) => finalRedaction(text, redactor);

function slowShapes(apply, shapes, options) {
  const slow = [];
  for (const [name, make] of Object.entries(shapes)) {
    const problem = slowness(apply, make, options);
    if (problem) slow.push(`${name}: ${problem}`);
  }
  return slow;
}

describe("the guard and the chat formatter on text made to be slow (sweep 5)", () => {
  it("sanitizeUntrusted reads in linear time, redacting as a run does or not at all", () => {
    expect(slowShapes((text) => sanitizeUntrusted(text, { maxChars: 4_000, redact }), { ...hostile, ...manyTags }, { budgetMs: 200, floorMs: 40 })).toEqual([]);
    expect(slowShapes((text) => sanitizeUntrusted(text, { maxChars: 4_000 }), { ...hostile, ...manyTags })).toEqual([]);
  }, 120_000);

  it("detectInjection and boxLine read in linear time", () => {
    expect(slowShapes((text) => detectInjection(text), { ...hostile, ...manyTags })).toEqual([]);
    expect(slowShapes((text) => boxLine(text), { ...hostile, ...manyTags })).toEqual([]);
  }, 120_000);

  it("stripWrapperBlocks reads in linear time, and a model's answer full of tags quickly", () => {
    expect(slowShapes((text) => stripWrapperBlocks(text), hostile)).toEqual([]);
    // Pairing tags is quadratic in how many there are, and an answer is at most the model's longest
    // (4,096 tokens, about 16 KiB): there it stays quick.
    expect(slowShapes((text) => stripWrapperBlocks(text), manyTags, { sizes: [4 * 1024, 16 * 1024], budgetMs: 50 })).toEqual([]);
  }, 120_000);

  it("the chat formatter and a message's parsers read in linear time", () => {
    expect(slowShapes((text) => chatText(text, { redact }), { ...hostile, ...manyTags }, { budgetMs: 200, floorMs: 40 })).toEqual([]);
    expect(slowShapes((text) => questionFrom(text, { agents: ["Steve", "Pi-hole Watcher"] }), hostile)).toEqual([]);
    expect(slowShapes((text) => uploadsIn(text), hostile)).toEqual([]);
    // A message's words without its upload links: quadratic in links left open, and a Zulip message
    // is at most 10,000 characters, where it stays quick.
    expect(slowShapes((text) => messageWords(text), hostile, { sizes: [4 * 1024, 16 * 1024], budgetMs: 50 })).toEqual([]);
  }, 120_000);
});
