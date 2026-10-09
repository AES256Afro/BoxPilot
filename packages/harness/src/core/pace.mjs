/**
 * How long a model call will take, worked out before it starts (M45.8, from BoxPilot's runner).
 *
 * On a CPU, reading the prompt is most of a call's time, so a call's time comes from the tokens it
 * will read and write at the model's measured speed, within what the run has left. A call that
 * cannot fit is not started. The speed starts from what the host measured before (or slow
 * defaults), and each call that reports its timings teaches it.
 */

export const paceDefaults = Object.freeze({
  // Before a model has been measured: one CPU thread's speeds, slow on purpose.
  promptPerSecond: 8,
  generatePerSecond: 4,
  charsPerToken: 4,
  // Kept back from the run's time for the tools' facts and the finish when the model runs out.
  reserveMs: 15_000,
  // A call is only started when it can read its prompt (at the measured speed, with this margin)
  // and still write this many tokens in what is left.
  fitMargin: 1.2,
  minAnswerTokens: 48,
  // A tool's output is cut to what the model can read in this long, never below 1,200 characters.
  toolReadSeconds: 25,
  // The check before answering: a correction is asked for only when it fits in what is left, and
  // writes at most this much more than the answer it corrects.
  correctionExtraTokens: 48,
});

/**
 * The model's speed, in tokens a second: reading the prompt and writing the answer. It starts from
 * what was measured before (or slow defaults); this run's first measurement replaces that (the
 * machine may be busier or quieter now), and later ones are averaged in.
 */
export function createSpeed({ promptPerSecond, generatePerSecond, source = "default" }) {
  const speed = { promptPerSecond, generatePerSecond, source, samples: 0 };
  const blend = (old, sample, fresh) => (fresh ? sample : Math.round((old * 0.5 + sample * 0.5) * 100) / 100);
  let freshPrompt = true;
  let freshGenerate = true;
  return {
    get: () => ({ ...speed }),
    /** One call's measurement: tokens read and the milliseconds it took, tokens written and theirs. */
    learn({ readTokens = 0, readMs = 0, writtenTokens = 0, writeMs = 0, from = "runner" }) {
      let learned = false;
      if (readTokens >= 16 && readMs > 0) { speed.promptPerSecond = blend(speed.promptPerSecond, Math.round((readTokens / readMs) * 1000 * 100) / 100, freshPrompt); freshPrompt = false; learned = true; }
      if (writtenTokens >= 8 && writeMs > 0) { speed.generatePerSecond = blend(speed.generatePerSecond, Math.round((writtenTokens / writeMs) * 1000 * 100) / 100, freshGenerate); freshGenerate = false; learned = true; }
      if (learned) { speed.samples += 1; speed.source = from; }
      return learned;
    },
  };
}

/** A tool's output cut to `maxChars` of its text, the wrapper and its first lines kept whole. */
export function clipToolOutput(content, maxChars) {
  const text = String(content ?? "");
  if (text.length <= maxChars) return text;
  const close = text.lastIndexOf("</tool_output>");
  const head = text.indexOf("\n\n");
  if (close < 0 || head < 0 || head > close) return `${text.slice(0, maxChars)}\n[… cut here: the model could not read more in time]`;
  const body = text.slice(head + 2, close);
  const room = Math.max(200, maxChars - head - 2 - 20);
  const cut = body.lastIndexOf("\n", room);
  const kept = body.slice(0, cut > room * 0.6 ? cut : room);
  return `${text.slice(0, head + 2)}${kept}\n[… ${body.length - kept.length} more characters not shown: the model could not read them in time]\n</tool_output>`;
}

/** The characters a conversation sends: its tools, and each message with its tool calls. */
export const promptChars = (conversation) => (conversation.tools?.length ? JSON.stringify(conversation.tools).length : 0)
  + conversation.messages.reduce((sum, message) => sum + String(typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).length + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0) + 16, 0);
