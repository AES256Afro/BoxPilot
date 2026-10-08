/**
 * How the person approves a change (M45.8): asked at the terminal, one change at a time, or answered
 * for them by `--yes` or `--read-only`. With no one at the terminal and neither flag, nothing that
 * changes anything is approved.
 *
 * What is shown came from the model (a path, a command, a file's text), so it is shown with every
 * control character made visible: a model cannot move the cursor or recolour the prompt.
 */
import { createInterface } from "node:readline/promises";

/** Text from a model or a tool, safe to print to a terminal: control characters made visible. */
export const terminalSafe = (text) => String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const preview = (text, lines = 12) => {
  const all = String(text ?? "").split("\n");
  const shown = all.slice(0, lines).map((line) => `  | ${terminalSafe(line).slice(0, 160)}`);
  return `${shown.join("\n")}${all.length > lines ? `\n  | … ${all.length - lines} more lines` : ""}\n`;
};

/**
 * @param {{ mode?: "ask" | "yes" | "no", input?: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream, signal?: AbortSignal | null }} options
 *   `signal`: a run stopped while a question waits is a no to it.
 */
export function createApprover({ mode = "ask", input = null, output, signal = null }) {
  const say = (line) => output.write(`${line}\n`);
  if (mode === "yes") return { approve: (request) => { say(`Approved (--yes): ${terminalSafe(request.summary)}`); return true; }, close() {} };
  if (mode === "no" || !input?.isTTY) {
    const why = mode === "no" ? "--read-only" : "no one at the terminal to ask; --yes approves changes";
    return { approve: (request) => { say(`Not approved (${why}): ${terminalSafe(request.summary)}`); return false; }, close() {} };
  }
  let lines = null;
  return {
    async approve(request) {
      lines ??= createInterface({ input, output, terminal: false });
      say(`\nThe agent wants to: ${terminalSafe(request.summary)}`);
      if (typeof request.input?.text === "string") output.write(preview(request.input.text));
      const answer = await lines.question("Allow it? [y/N] ", signal ? { signal } : {});
      return /^\s*y(?:es)?\s*$/i.test(answer);
    },
    close() { lines?.close(); },
  };
}
