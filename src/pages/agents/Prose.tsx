import { Fragment, type ReactNode } from "react";

/*
 * An agent's words as prose (M44). A small model writes markdown whether asked to or not - the
 * owner's Server Keeper began its digest with "**Daily digest complete.**" - and the Agents tab,
 * Home and Today showed the stars. This draws the part of markdown such a model writes: paragraphs
 * and line breaks, bullet and numbered lists, bold, italics and `code`. A heading is drawn as a bold
 * line, and a link as its words alone: nothing in an answer is a place to click. Everything else is
 * text: React escapes it, so <script> or any other HTML shows as written and never runs. Citations
 * - [T1] for a tool's output, [F1] for another agent's finding - are drawn as small marks.
 *
 * No dependency: a few patterns tried at each position, never a regular expression over the whole
 * answer that could run away on a long one.
 */

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] };

const bulletLine = /^\s*[-*•+]\s+(.*)$/;
const numberLine = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const headingLine = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const ruleLine = /^\s{0,3}(?:[-*_]\s*){3,}$/;

/** The text in blocks: paragraphs (their lines kept), headings, and runs of list items. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Extract<Block, { kind: "list" }> | null = null;
  const endParagraph = () => { if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph }); paragraph = []; };
  const endList = () => { if (list) blocks.push(list); list = null; };
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || ruleLine.test(line)) { endParagraph(); endList(); continue; }
    const bullet = bulletLine.exec(line);
    const numbered = bullet ? null : numberLine.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) { endList(); list = { kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items: [] }; }
      list.items.push(bullet ? bullet[1] : numbered![2]);
      continue;
    }
    // An indented line under an item goes on with that item.
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += `\n${line.trim()}`; continue; }
    const heading = headingLine.exec(line);
    if (heading) { endParagraph(); endList(); blocks.push({ kind: "heading", text: heading[1] }); continue; }
    endList();
    paragraph.push(line);
  }
  endParagraph();
  endList();
  return blocks;
}

const citation = /\[((?:T|F)\d{1,3}(?:\s*[,;]\s*(?:T|F)\d{1,3})*)\]/y;
// A link's address may hold one level of brackets: [text](javascript:alert(1)) is one link, all of it dropped.
const link = /\[([^\]\n]{1,300})\]\(((?:[^()\s]|\([^()\s]{0,200}\)){0,2000})(?:\s+"[^"\n]*")?\)/y;
const code = /`([^`\n]{1,500})`/y;
const strong = /(\*\*|__)(?=\S)([^\n]*?\S)\1/y;
const emphasisStar = /\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/y;
const emphasisUnderscore = /_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])/y;
const wordCharacter = /[A-Za-z0-9_]/;

function match(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** One citation list, [T1, F2], as marks. */
function marks(ids: string, key: string): ReactNode {
  const each = ids.split(/\s*[,;]\s*/);
  return (
    <Fragment key={key}>
      {each.map((id, index) => (
        <Fragment key={id + index}>
          {index > 0 ? " " : null}
          <code className="agents-answer__cite" title={id.startsWith("F") ? "Another agent's finding this comes from" : "The tool output this comes from, numbered as in the trace"}>{id}</code>
        </Fragment>
      ))}
    </Fragment>
  );
}

/** A line's words with their emphasis, code and citations drawn; everything else as text. */
export function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let buffer = "";
  let key = 0;
  const flush = () => { if (buffer) { out.push(buffer); buffer = ""; } };
  const push = (node: ReactNode) => { flush(); out.push(node); };
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    const before = at > 0 ? text[at - 1] : "";
    let found: RegExpExecArray | null = null;
    if (character === "[") {
      if ((found = match(citation, text, at))) { push(marks(found[1], `${keyPrefix}-${key++}`)); at += found[0].length; continue; }
      // A link is its words: an answer is no place to click.
      if ((found = match(link, text, at))) { push(<Fragment key={`${keyPrefix}-${key++}`}>{inline(found[1], `${keyPrefix}-${key}`)}</Fragment>); at += found[0].length; continue; }
    } else if (character === "`") {
      if ((found = match(code, text, at))) { push(<code key={`${keyPrefix}-${key++}`}>{found[1]}</code>); at += found[0].length; continue; }
    } else if (character === "*" || character === "_") {
      if ((found = match(strong, text, at))) { push(<strong key={`${keyPrefix}-${key++}`}>{inline(found[2], `${keyPrefix}-${key}`)}</strong>); at += found[0].length; continue; }
      // A star or an underscore inside a word (snake_case, 2*3) is the word's own.
      if (!wordCharacter.test(before)) {
        const pattern = character === "*" ? emphasisStar : emphasisUnderscore;
        if ((found = match(pattern, text, at))) { push(<em key={`${keyPrefix}-${key++}`}>{inline(found[1], `${keyPrefix}-${key}`)}</em>); at += found[0].length; continue; }
      }
    }
    buffer += character;
    at += 1;
  }
  flush();
  return out;
}

/** Lines of one block, each drawn, with a line break between them. */
function lines(list: string[], key: string): ReactNode[] {
  return list.flatMap((line, index) => [index > 0 ? <br key={`${key}-br${index}`} /> : null, <Fragment key={`${key}-l${index}`}>{inline(line, `${key}-l${index}`)}</Fragment>]).filter((node) => node !== null);
}

/** Markdown-ish text as safe prose: see the note at the top of this file. */
export function Prose({ text, className }: { text: string; className?: string }) {
  const blocks = blocksOf(text);
  return (
    <div className={`agents-prose${className ? ` ${className}` : ""}`}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === "heading") return <p key={key} className="agents-prose__heading"><strong>{inline(block.text, key)}</strong></p>;
        if (block.kind === "paragraph") return <p key={key}>{lines(block.lines, key)}</p>;
        const items = block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{lines(item.split("\n"), `${key}-${itemIndex}`)}</li>);
        return block.ordered ? <ol key={key} start={block.start}>{items}</ol> : <ul key={key}>{items}</ul>;
      })}
    </div>
  );
}
