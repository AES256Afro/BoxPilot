/**
 * The agent checks itself before it answers (M40). The owner's Server Keeper once wrote
 * "/dev/sda (primary drive): 528 GB total, 31% used [T1]" when its tool had said the 528 GB, 31%
 * used root filesystem was on the NVMe drive and /dev/sda was a 15 TB USB drive. The citation was
 * there; the claim did not match what it cited.
 *
 * So after the model drafts its answer, every claim is held to the tool output it cites, with no
 * model involved: the devices and paths it names must be in that output, and the sizes and
 * percentages it gives must be ones the output gives *for those things* - on the lines about them
 * (a line's subject, or the stretch of a line after the thing is named), and on the lines about
 * what they hold (a drive's line lists its mountpoints). The same goes for what a claim calls them:
 * the system disk, USB or NVMe, ext4 or exFAT, running or stopped. A claim with no citation is held
 * to every output. A claim that does not match is an issue, with the tool's own words about the
 * thing it named, so the runner can ask the model to correct it, or say plainly it is not sure.
 *
 * It is text work only: a few regular expressions over a few kilobytes, well under a millisecond.
 */

const devicePattern = /(?<![\w/.-])(?:\/dev\/)?((?:nvme\d+n\d+(?:p\d+)?)|(?:sd[a-z]{1,2}\d{0,2})|(?:x?vd[a-z]\d{0,2})|(?:mmcblk\d+(?:p\d+)?)|(?:md\d+)|(?:dm-\d+))(?![\w-])/g;
const mapperPattern = /\/dev\/mapper\/[A-Za-z0-9._+-]+/g;
// Absolute paths that are not devices or web addresses; a lone "/" is taken only where the text
// makes it one (at the start of a line's subject, "on /", "`/`", "(/").
const pathPattern = /(?<![\w/.:<>-])(\/(?:[A-Za-z0-9._-]+\/?)+)(?![\w/])/g;
const rootWords = /\broot (?:filesystem|file system|disk|partition|volume|drive)\b|`\/`|\b(?:mounted (?:at|on)|holds?|on|at|of)\s+\/(?=[\s,.;:()]|$)|\(\/\)|(?:^|\s)\/ \(the root filesystem\)/i;
const sizePattern = /(\d+(?:[.,]\d+)?)\s?(TiB|TB|GiB|GB|MiB|MB|KiB|kB|KB)\b/g;
const percentPattern = /(\d+(?:\.\d+)?)\s?%/g;
// [T1] a tool's output; [F1] another agent's finding (M44), held to its words the same way.
const citationPattern = /\[([TF]\d{1,3}(?:\s*[,;]\s*[TF]\d{1,3})*)\]/g;

const unitBytes = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3, tib: 1024 ** 4, gib: 1024 ** 3, mib: 1024 ** 2, kib: 1024 };
// A model writes GB for GiB and the other way round: a size is read either way.
const otherUnit = { tib: "tb", gib: "gb", mib: "mb", kib: "kb", tb: "tib", gb: "gib", mb: "mib", kb: "kib" };

/** Words that say what a thing is, in sets whose members contradict each other. */
const attributeSets = [
  { name: "transport", members: { usb: /\busb\b/i, nvme: /\bnvme\b/i, sata: /\bsata\b/i } },
  { name: "filesystem", members: { ext4: /\bext4\b/i, exfat: /\bexfat\b/i, ntfs: /\bntfs\b/i, xfs: /\bxfs\b/i, btrfs: /\bbtrfs\b/i, vfat: /\b(vfat|fat32)\b/i, zfs: /\bzfs\b/i } },
  { name: "state", members: { running: /\b(?<!not )running\b|\bis up\b/i, stopped: /\b(stopped|exited|not running|is down)\b/i } },
];
const systemClaim = /\b(primary|system|boot|root|main|os|operating[- ]system)\s+(drive|disk|ssd|device|nvme)\b|\bthe system disk\b|\bholds? (?:the )?(?:root|operating system|os)\b|\b(?:is|as) (?:the )?(?:root|boot) (?:drive|disk)\b/i;
const notSystemClaim = /\bnot (?:the )?(?:primary|system|boot|root|main|os)\b/i;

const clean = (text) => String(text ?? "").replace(/\*\*|__|`(?!\/`)/g, "").replace(/[“”]/g, "\"");

/** The sizes and percentages a text gives, each as a number with its kind. */
export function valuesIn(text) {
  const values = [];
  for (const match of String(text ?? "").matchAll(sizePattern)) {
    const unit = match[2].toLowerCase();
    const number = Number(match[1].replace(",", "."));
    const decimals = (match[1].split(/[.,]/)[1] ?? "").length;
    values.push({ kind: "size", text: match[0], number, unit, decimals, bytes: number * unitBytes[unit], at: match.index });
  }
  for (const match of String(text ?? "").matchAll(percentPattern)) values.push({ kind: "percent", text: match[0], number: Number(match[1]), at: match.index });
  return values;
}

/** Whether a value a claim gives is one a text gives: a size within its rounding, a percentage within a point. */
function sameValue(claimed, found) {
  if (claimed.kind !== found.kind) return false;
  if (claimed.kind === "percent") return Math.abs(claimed.number - found.number) <= 1;
  // The claim's own rounding (15 TB is 14.5 to 15.5 TB), and 2% besides.
  return [claimed.unit, otherUnit[claimed.unit]].some((unit) => {
    const bytes = claimed.number * unitBytes[unit];
    const half = 0.5 * 10 ** -claimed.decimals * unitBytes[unit];
    return Math.abs(bytes - found.bytes) <= Math.max(half, 0.02 * found.bytes, 0.02 * bytes);
  });
}

/** The things a text names: devices, mapper volumes, paths, and the root filesystem when it says so. */
export function entitiesIn(text, { subjects = [] } = {}) {
  const value = clean(text);
  const found = new Map();
  const add = (key, label) => { if (!found.has(key)) found.set(key, label); };
  for (const match of value.matchAll(mapperPattern)) add(match[0], match[0]);
  for (const match of value.matchAll(devicePattern)) add(`/dev/${match[1]}`, match[0]);
  for (const match of value.matchAll(pathPattern)) {
    const path = match[1].replace(/\/$/, "") || "/";
    if (path.startsWith("/dev/") || path.startsWith("/api/") || /^\/[A-Za-z]$/.test(path)) continue;
    add(path, path);
  }
  if (rootWords.test(value)) add("/", "the root filesystem");
  // Names the cited outputs use as their lines' subjects (an app's id): found as whole words.
  for (const subject of subjects) {
    if (subject.startsWith("/") || found.has(subject)) continue;
    const pattern = new RegExp(`(?<![\\w-])${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
    if (pattern.test(value)) add(subject, subject);
  }
  return [...found.entries()].map(([key, label]) => ({ key, label }));
}

/** Where a thing is named in a line: the device's short name, a path as a whole word, or a subject. */
function mentionsIn(line, key) {
  const positions = [];
  let pattern;
  if (key.startsWith("/dev/") && !key.startsWith("/dev/mapper/")) pattern = new RegExp(`(?<![\\w/.-])(?:/dev/)?${key.slice(5).replace(/[.+]/g, "\\$&")}(?![\\w-])`, "g");
  else if (key === "/") pattern = /(?<![\w/.:-])\/(?=[\s,.:;)]|$)/g;
  else if (key.startsWith("/")) pattern = new RegExp(`(?<![\\w/.:-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`, "g");
  else pattern = new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi");
  for (const match of line.matchAll(pattern)) positions.push(match.index);
  if (key === "/" && /\broot filesystem\b/i.test(line) && !positions.length) positions.push(line.search(/\broot filesystem\b/i));
  return positions;
}

/**
 * A line's subject: what it is about, the thing named first after its bullet, before a colon. A
 * device or a path is a subject on any line; a plain name (an app's id) only on a list item, so a
 * label line ("Blocking: on.", "Memory: ...") is not taken for a thing.
 */
function subjectOf(line) {
  const match = /^\s*([-*]\s+)?([^:]{1,120}?)(?:\s+\([^)]*\))?:\s/.exec(line);
  if (!match) return null;
  const head = match[2].trim();
  if (head === "/") return "/";
  const entity = entitiesIn(head)[0];
  if (entity) return entity.key;
  return match[1] && /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(head) ? head.toLowerCase() : null;
}

/**
 * The text an output gives about a thing: every line whose subject it is, the stretch of each other
 * line from where it is named to where the next thing is named, and - for a drive - the lines about
 * what it holds (the paths named on its own line).
 */
export function scopeOf(key, lines) {
  const parts = [];
  const held = new Set();
  for (const line of lines) {
    const subject = subjectOf(line);
    if (subject === key) {
      parts.push(line);
      for (const entity of entitiesIn(line)) if (entity.key.startsWith("/") && !entity.key.startsWith("/dev/") && entity.key !== key) held.add(entity.key);
      continue;
    }
    const at = mentionsIn(line, key);
    if (!at.length) continue;
    // From each mention to the next thing named on the line.
    const others = entitiesIn(line).filter((entity) => entity.key !== key).flatMap((entity) => mentionsIn(line, entity.key));
    for (const start of at) {
      const end = Math.min(...others.filter((position) => position > start), line.length);
      parts.push(line.slice(start, end));
    }
  }
  if (key.startsWith("/dev/")) {
    for (const line of lines) {
      const subject = subjectOf(line);
      if (subject && held.has(subject)) parts.push(line);
    }
  }
  return parts.join("\n");
}

/** Whether a scope says the thing is the system disk (true), is not (false), or does not say (null). */
function systemIn(scope) {
  if (/\bthe system disk\b/i.test(scope.replace(/\bnot the system disk\b/gi, ""))) return true;
  return /\bnot the system disk\b/i.test(scope) ? false : null;
}

/** The answer in claims: sentences and list items, each with the outputs it cites. */
export function claimsOf(answer) {
  const claims = [];
  for (const rawLine of String(answer ?? "").split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A sentence ends at a stop before a capital, a mark, a path or a device's name ("sda is ...").
    const pieces = line.split(/(?<=[.!?])\s+(?=[A-Z*_(["`/-]|(?:nvme\d|sd[a-z]\b|sd[a-z]\d|vd[a-z]|mmcblk))/);
    const cited = pieces.map((piece) => [...piece.matchAll(citationPattern)].flatMap((match) => match[1].split(/\s*[,;]\s*/)));
    pieces.forEach((piece, index) => {
      // A sentence without its own citation takes the next one's on the same line, else the last one's.
      const own = cited[index];
      const borrowed = own.length ? own : cited.slice(index + 1).find((entry) => entry.length) ?? cited.slice(0, index).reverse().find((entry) => entry.length) ?? [];
      const text = piece.replace(citationPattern, "").trim();
      if (text.replace(/[\s.,;:!?*_-]/g, "").length < 3) return;
      claims.push({ text, cites: [...new Set(borrowed)] });
    });
  }
  return claims;
}

/**
 * Check an answer against the tool outputs it was given. `outputs` are { id: "T1", title, text }.
 * Returns { claims, checked, issues } - checked counts the claims that named something checkable.
 */
export function verifyAnswer(answer, outputs, { maxIssues = 8 } = {}) {
  const byId = new Map((outputs ?? []).map((output) => [output.id, output]));
  const claims = claimsOf(answer);
  const issues = [];
  let checked = 0;
  for (const claim of claims) {
    const cited = claim.cites.map((id) => byId.get(id)).filter(Boolean);
    const sources = cited.length ? cited : [...byId.values()];
    if (!sources.length) break;
    const lines = sources.flatMap((source) => String(source.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
    const subjects = [...new Set(lines.map(subjectOf).filter(Boolean))];
    const text = clean(claim.text);
    const entities = entitiesIn(text, { subjects });
    const values = valuesIn(text);
    const attributes = attributeSets.map((set) => ({ set, said: Object.entries(set.members).filter(([, pattern]) => pattern.test(text)).map(([name]) => name) })).filter((entry) => entry.said.length === 1);
    const saysSystem = systemClaim.test(text) && !notSystemClaim.test(text);
    if (!entities.length && !values.length) continue;
    checked += 1;
    const where = cited.length ? cited.map((source) => source.id).join(", ") : "any tool output";
    const issue = (kind, said, detail, tool = null) => issues.push({ claim: claim.text.slice(0, 240), cites: claim.cites, kind, said, detail, tool: tool ?? where });
    const allText = lines.join("\n");
    const scopes = new Map();
    for (const entity of entities) {
      const scope = scopeOf(entity.key, lines);
      if (!scope) issue("unknown", entity.label, `${where} does not mention ${entity.label}`);
      else scopes.set(entity.key, scope);
    }
    const inScope = [...scopes.values()].join("\n");
    for (const value of values) {
      const anywhere = valuesIn(allText).some((found) => sameValue(value, found));
      if (!anywhere) { issue("value", value.text, `${where} does not say ${value.text}`); continue; }
      if (scopes.size && !valuesIn(inScope).some((found) => sameValue(value, found))) {
        const holder = lines.find((line) => valuesIn(line).some((found) => sameValue(value, found)));
        issue("value", value.text, `${where} gives ${value.text} for something else${holder ? `: "${holder.slice(0, 200)}"` : ""}, not for ${[...scopes.keys()].join(" or ")}`);
      }
    }
    for (const { set, said } of attributes) {
      if (!scopes.size) continue;
      const [word] = said;
      const holders = [...scopes.entries()].filter(([, scope]) => Object.values(set.members).some((pattern) => pattern.test(scope)));
      if (!holders.length) continue;
      if (!holders.some(([, scope]) => set.members[word].test(scope))) {
        const [key, scope] = holders[0];
        const actual = Object.entries(set.members).filter(([, pattern]) => pattern.test(scope)).map(([name]) => name).join(" or ");
        issue("attribute", word, `${where} says ${key} is ${actual}, not ${word}`);
      }
    }
    if (saysSystem) {
      const devices = [...scopes.entries()].filter(([key]) => key.startsWith("/dev/"));
      if (devices.length && devices.every(([, scope]) => systemIn(scope) === false)) {
        const system = lines.find((line) => /^\s*[-*]\s+\/dev\/\S+:/.test(line) && systemIn(line) === true);
        issue("attribute", "system disk", `${where} says ${devices.map(([key]) => key).join(" and ")} is not the system disk${system ? `; the system disk is ${subjectOf(system)}` : ""}`);
      }
    }
    if (issues.length >= maxIssues) break;
  }
  return { claims: claims.length, checked, issues: issues.slice(0, maxIssues) };
}

/**
 * The lines of the cited outputs a correction needs: those about the things the failing claims
 * name, and those holding the values they gave. At most `maxLines`, so the correction reads little.
 */
export function evidenceFor(issues, outputs, { maxLines = 14 } = {}) {
  const byId = new Map((outputs ?? []).map((output) => [output.id, output]));
  const picked = [];
  for (const entry of issues) {
    const sources = entry.cites.length ? entry.cites.map((id) => byId.get(id)).filter(Boolean) : [...byId.values()];
    for (const source of sources) {
      const lines = String(source.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
      const keys = entitiesIn(entry.claim).map((entity) => entity.key);
      for (const line of lines) {
        const relevant = keys.some((key) => subjectOf(line) === key || mentionsIn(line, key).length) || valuesIn(line).some((found) => valuesIn(entry.claim).some((value) => sameValue(value, found)));
        const tagged = `[${source.id}] ${line}`;
        if (relevant && !picked.includes(tagged)) picked.push(tagged);
      }
    }
  }
  return picked.slice(0, maxLines);
}

/** What the model is asked when a check fails: a short conversation of its own, the same system words every time. */
export const correctionSystem = "You correct an answer written by an agent on a home server so that every fact in it matches the tool output it cites. Keep what is right and keep its [T] and [F] citations. Change only what the checks say is wrong, using the tool output's own facts. If the tool output does not say, write that you are not sure. Reply with the corrected answer only, as short as the original.";

export function correctionMessages(answer, issues, outputs) {
  const evidence = evidenceFor(issues, outputs);
  return [
    { role: "system", content: correctionSystem },
    { role: "user", content: [
      "Tool output:", ...evidence, "",
      "The answer:", String(answer ?? "").trim(), "",
      "Checks that failed:", ...issues.map((entry) => `- "${entry.claim}": ${entry.detail}.`), "",
      "Write the corrected answer.",
    ].join("\n") },
  ];
}

/**
 * When the answer cannot be corrected in time, or a correction still fails: the answer as it was,
 * with what did not match said plainly under it, in the tools' own words.
 */
export function unsureNote(issues) {
  if (!issues.length) return "";
  const lines = issues.slice(0, 5).map((entry) => `- "${entry.claim.length > 120 ? `${entry.claim.slice(0, 119)}…` : entry.claim}": ${entry.detail}.`);
  return `\n\nChecked against the tools, some of this does not match what they said, so I am not sure of it:\n${lines.join("\n")}`;
}
