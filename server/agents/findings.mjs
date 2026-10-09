/**
 * Findings (M44): what one agent found, kept for the others. The owner asked that an agent which
 * needs some data first check whether another agent already gathered it, so no run spends a CPU's
 * minutes reading what another read an hour ago (ADR-012).
 *
 * A finding is the result of an agent's routine run (its schedule, or the console's "run its routine
 * once") or of an answer it checked against its tools, kept as one shared note per agent and kind,
 * replaced each time. It stays fresh for about as long as the agent takes to look again, carries the
 * role of the run that learned it (another agent's run reads it only if it may read as much), and is
 * offered to the other agents as data they cite, like tool output. A supervisor that would hand a
 * question to a specialist takes the specialist's fresh finding instead of running it again.
 *
 * Everything here is plain text work: no model, no store. service.mjs decides when, store.mjs keeps.
 */
import { tokenize } from "../assistant/knowledge.mjs";

const hour = 3_600_000;
const day = 24 * hour;

/** Templates whose agents answer people and decide for themselves: they use findings, never share them. */
export const nonSharingTemplates = Object.freeze(["it-support", "house-guide"]);

/**
 * An agent's two switches. A spec saved before M44 has none: it shares and uses findings, except the
 * IT Support helper and the House Guide, which only use them.
 */
export function sharingOf(spec, template = null) {
  const saved = spec?.sharing;
  return {
    shareFindings: typeof saved?.shareFindings === "boolean" ? saved.shareFindings : !nonSharingTemplates.includes(template),
    useFindings: typeof saved?.useFindings === "boolean" ? saved.useFindings : true,
  };
}

/**
 * How long a finding stays fresh: about until the agent looks again on its own. Weekly, a week;
 * daily, 26 hours; every six hours, 7; hourly, 2; an agent that only answers questions, a day. An
 * answer to a question is never fresh for more than a day, whatever the schedule.
 */
export const findingFreshness = Object.freeze({ hourly: 2 * hour, "every-6-hours": 7 * hour, daily: 26 * hour, weekly: 7 * day, none: day });

export function findingFreshMs(spec, kind = "routine") {
  const every = spec?.triggers?.schedule?.every ?? "none";
  const byCadence = findingFreshness[every] ?? findingFreshness.none;
  return kind === "answer" ? Math.min(byCadence, findingFreshness.none) : byCadence;
}

/**
 * Which finding a run leaves, if any: "routine" for its schedule and the console's routine run,
 * "answer" for a question (asked, handed to it, or put together by a supervisor's follow-up). An
 * evaluation, a learning run, an event or a webhook leaves none: they answer something narrower
 * than the agent's job, or measure the agent itself.
 */
export function findingKind(run) {
  if (run?.kind === "schedule" || (run?.kind === "manual" && !run.question)) return "routine";
  if (["ask", "handoff", "continue"].includes(run?.kind) || (run?.kind === "manual" && run.question)) return "answer";
  return null;
}

/** Runs that are offered other agents' findings before they plan. An evaluation reads its own tools. */
export const findingReaderKinds = Object.freeze(["ask", "manual", "schedule", "event", "webhook", "handoff"]);

// [T3] (or [F1]) in a finding means the third tool output (the first finding) of another run:
// nothing to the run that reads it.
const toolCitations = /[ \t]*\[(?:[TF]\d{1,3}(?:\s*[,;]\s*[TF]\d{1,3})*)\]/g;
export const withoutToolCitations = (text) => String(text ?? "").replace(toolCitations, "");

/**
 * A finding's words: the answer without its tool citations, whole when it fits, else its lead and
 * the first sentence of each item, said to be shortened. `max` is a note's size.
 */
export function compactFinding(text, max = 2_000) {
  const clean = withoutToolCitations(text).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= max) return clean;
  const tail = "\n… (shortened; the whole answer is on its run)";
  const room = max - tail.length;
  const firstSentence = (line) => {
    const match = /^(\s*(?:[-*•]|\d+[.)])\s+)?(.*)$/.exec(line);
    const sentence = match[2].split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
    return `${match[1] ?? ""}${sentence}`;
  };
  const kept = [];
  let size = 0;
  for (const line of clean.split("\n")) {
    const short = line.length > 240 ? firstSentence(line) : line;
    const piece = short.length > 240 ? `${short.slice(0, 239)}…` : short;
    if (size + piece.length + 1 > room) break;
    kept.push(piece);
    size += piece.length + 1;
  }
  return `${kept.join("\n").trim()}${tail}`;
}

/**
 * Whether the person asked for a fresh look rather than what is already known: "check now", "check
 * again", "re-check", "look again", "a fresh look", "right now", "live", "freshly". "Its lists are
 * fresh" is about the lists, not the asking, so a bare "fresh" counts only where it is the request.
 */
const freshWords = /\b(?:check(?:ing)?\s+(?:it\s+|this\s+|them\s+|that\s+)?(?:now|again)|re-?check|look\s+again|(?:a|do\s+a|get\s+a|take\s+a)\s+fresh\s+(?:check|look|read|reading|survey|run)|fresh\s+(?:data|numbers|reading|check|look)|freshly|right\s+now|this\s+(?:minute|instant)|live\s+(?:data|numbers|status|reading)|(?:don'?t|do\s+not)\s+use\s+(?:the\s+)?(?:old|earlier|cached|last)|not\s+(?:from\s+)?(?:the\s+)?(?:cache|old\s+(?:one|answer|finding)))\b|^\s*fresh\b|\bfresh(?:,)?\s+please\b|\(fresh\)/i;
export const wantsFresh = (...texts) => texts.some((text) => freshWords.test(String(text ?? "")));

/**
 * A text's words as a request is matched by: stemmed, without the commonest, and a name like
 * "pi-hole" or "server.facts" as one word, so a name of two parts does not count twice.
 */
const terms = (text) => [...new Set((String(text ?? "").toLowerCase().match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? []).flatMap((word) => (/[.-]/.test(word) ? [word] : tokenize(word))))];

// Words that say how to ask, not what about.
const askingWords = new Set(terms("say tell check look find give show whether please now know answer report server box agent findings finding question asked"));

/**
 * How well a finding answers a request: the share of the request's own words it holds (without
 * the words of asking), and how many. 0 when none.
 */
export function findingScore(query, finding) {
  const wanted = terms(query).filter((word) => !askingWords.has(word));
  if (!wanted.length) return { score: 0, shared: 0 };
  const held = new Set(terms(`${finding?.title ?? ""}\n${finding?.body ?? ""}\n${finding?.source?.question ?? ""}`));
  const shared = wanted.filter((word) => held.has(word)).length;
  return { score: shared / wanted.length, shared };
}

/** Whether a specialist's finding answers the subtask a supervisor would hand it: two words, or half of a short one. */
export function findingAnswers(task, finding) {
  const { score, shared } = findingScore(task, finding);
  return shared >= 2 || (shared >= 1 && score >= 0.5);
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
export function ageWords(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
