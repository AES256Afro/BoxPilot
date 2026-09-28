#!/usr/bin/env node
/**
 * Check the design tokens in src/styles.css (M33.1, ADR-004), in light and dark:
 *
 *   - the main text pairs reach WCAG contrast: 4.5:1 for body text, 3:1 for large text and for
 *     marks and bars that carry meaning;
 *   - the two light blocks (System on a light device, and Light chosen) are identical;
 *   - every dark token that holds a colour has a light value, so no page keeps a dark colour in
 *     light mode;
 *   - unknown is never drawn green (M28.5).
 *
 *   node scripts/check-contrast.mjs      prints every pair; exits 1 when anything falls short
 *
 * The same checks run in `npm test` through scripts/check-contrast.test.mjs. There is one dark
 * look and one light one; the older dark palettes were retired.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** [foreground, background, minimum, what it is]. Tokens only; each is resolved per theme. */
export const pairs = [
  ["--text", "--canvas", 4.5, "body text on the page"],
  ["--text", "--surface", 4.5, "body text on a panel"],
  ["--text-strong", "--surface", 4.5, "headings and values"],
  ["--text-strong", "--surface-raised", 4.5, "button text"],
  ["--text-muted", "--canvas", 4.5, "secondary text on the page"],
  ["--text-muted", "--surface", 4.5, "secondary text on a panel"],
  ["--text-muted", "--surface-muted", 4.5, "secondary text in an inset"],
  ["--text-muted", "--surface-raised", 4.5, "secondary text on a raised surface"],
  ["--text-muted", "--surface-header", 4.5, "table headings"],
  ["--text-secondary", "--surface-raised", 4.5, "classic secondary buttons"],
  ["--text-code", "--code-bg", 4.5, "code"],
  ["--text-inverted", "--bg-active-start", 4.5, "the current navigation item"],
  ["--text-strong", "--accent-bg", 4.5, "feature chips"],
  ["--link", "--surface", 4.5, "links"],
  ["--accent", "--canvas", 4.5, "eyebrows on the page"],
  ["--accent", "--surface", 4.5, "ghost buttons and accents on a panel"],
  ["--accent-text-on", "--accent", 4.5, "primary buttons"],
  ["--accent-light", "--accent-bg", 4.5, "classic good pills"],
  ["--warn", "--surface-warn", 4.5, "classic warning pills"],
  ["--danger", "--danger-bg", 4.5, "classic danger pills"],
  ["--danger-light", "--danger-bg", 4.5, "error messages"],
  ["--warn-text", "--warn-bg", 4.5, "warning notices"],
  ["--status-good-text", "--status-good-bg", 4.5, "good chip"],
  ["--status-warning-text", "--status-warning-bg", 4.5, "warning chip"],
  ["--status-danger-text", "--status-danger-bg", 4.5, "danger chip"],
  ["--status-neutral-text", "--status-neutral-bg", 4.5, "neutral chip"],
  ["--status-unknown-text", "--surface", 4.5, "unknown chip"],
  ["--status-warning-text", "--surface", 4.5, "a tile's warning detail"],
  ["--status-danger-text", "--surface", 4.5, "a tile's danger detail"],
  ["--risk-low-text", "--risk-low-bg", 4.5, "low risk tag"],
  ["--risk-medium-text", "--risk-medium-bg", 4.5, "medium risk tag"],
  ["--risk-high-text", "--risk-high-bg", 4.5, "high risk tag, the Password tag"],
  ["--surface", "--text-strong", 4.5, "a count on a dock badge"],
  ["--status-good", "--surface", 3, "good mark and bar"],
  ["--status-warning", "--surface", 3, "warning mark and bar"],
  ["--status-danger", "--surface", 3, "danger mark and bar"],
  ["--status-unknown", "--surface", 3, "unknown mark"],
  ["--risk-medium", "--surface-raised", 3, "the medium bar on a button"],
  ["--risk-high", "--surface-raised", 3, "the high bar on a button"],
  ["--accent", "--meter-track", 3, "a bar's fill against its track"],
];

/** Top-level rules and the rules one level inside @media, as { media, selector, declarations }. */
function rules(css) {
  const text = css.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  const walk = (source, media) => {
    let at = 0;
    while (at < source.length) {
      const open = source.indexOf("{", at);
      if (open < 0) break;
      let depth = 1;
      let close = open + 1;
      for (; close < source.length && depth; close += 1) {
        if (source[close] === "{") depth += 1;
        else if (source[close] === "}") depth -= 1;
      }
      const prelude = source.slice(at, open).trim();
      const body = source.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else found.push({ media, selector: prelude.replace(/\s+/g, " "), declarations: declarations(body) });
      at = close;
    }
  };
  walk(text, null);
  return found;
}

/** Custom properties in a block, in order. Values may hold parentheses and commas. */
function declarations(body) {
  const out = new Map();
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if ((char === ";" || index === body.length) && depth === 0) {
      const piece = body.slice(start, index).trim();
      start = index + 1;
      const match = /^(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(piece);
      if (match) out.set(match[1], match[2].trim().replace(/\s+/g, " "));
    }
  }
  return out;
}

const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\(/i;

function resolve(value, theme, seen = new Set()) {
  return value.replace(/var\((--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_match, name, fallback) => {
    if (seen.has(name)) throw new Error(`${name} refers to itself`);
    const next = theme.get(name) ?? fallback;
    if (next === undefined) throw new Error(`${name} is not defined`);
    return resolve(next, theme, new Set([...seen, name]));
  });
}

/** A colour as [r, g, b, alpha] (0-255, 0-1), from hex or rgb()/rgba() in either syntax. */
export function parseColor(value) {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join("");
    const channel = (i) => Number.parseInt(digits.slice(i, i + 2), 16);
    return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  if (text === "transparent") return [0, 0, 0, 0];
  throw new Error(`not a single colour: ${value}`);
}

const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
const linear = (channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG contrast of two opaque colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Hue in degrees and saturation 0-1, for the "unknown is never green" rule. */
function hueAndSaturation([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === R ? 60 * (((G - B) / delta) % 6) : max === G ? 60 * ((B - R) / delta + 2) : 60 * ((R - G) / delta + 4);
  return { hue: (hue + 360) % 360, saturation };
}

/** Every check, for both themes. Pure: pass the stylesheet's text. */
export function checkTokens(css) {
  const all = rules(css);
  const dark = new Map();
  for (const rule of all) if (!rule.media && rule.selector === ":root") for (const [name, value] of rule.declarations) dark.set(name, value);
  const chosen = all.find((rule) => !rule.media && rule.selector === ':root[data-theme="light"]');
  const system = all.find((rule) => rule.media?.includes("prefers-color-scheme: light") && rule.selector === ':root:not([data-theme="dark"])');
  if (!chosen || !system) throw new Error("the light blocks are missing from the stylesheet");

  const lightBlocksMatch = JSON.stringify([...chosen.declarations]) === JSON.stringify([...system.declarations]);
  const light = new Map([...dark, ...chosen.declarations]);
  const missingLight = [...dark].filter(([name, value]) => colorLiteral.test(value) && !chosen.declarations.has(name)).map(([name]) => name);

  const themes = { dark, light };
  const results = [];
  for (const [themeName, theme] of Object.entries(themes)) {
    const canvas = parseColor(resolve("var(--canvas)", theme));
    const solid = (token, under) => over(parseColor(resolve(`var(${token})`, theme)), under);
    for (const [fg, bg, minimum, what] of pairs) {
      const background = solid(bg, canvas);
      const ratio = contrast(solid(fg, background), background);
      const ok = ratio >= minimum;
      results.push({ theme: themeName, fg, bg, minimum, what, ratio, ok, line: `${ok ? "ok  " : "FAIL"}  ${ratio.toFixed(2).padStart(5)}  ${themeName.padEnd(5)}  ${fg} on ${bg} (${what}, needs ${minimum})` });
    }
  }

  const unknownGreen = Object.entries(themes).filter(([, theme]) => {
    const { hue, saturation } = hueAndSaturation(parseColor(resolve("var(--status-unknown)", theme)));
    return saturation > 0.2 && hue >= 75 && hue <= 165;
  }).map(([name]) => name);

  return { results, lightBlocksMatch, missingLight, unknownGreen };
}

if (import.meta.main) {
  const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"), "utf8");
  const { results, lightBlocksMatch, missingLight, unknownGreen } = checkTokens(css);
  for (const result of results) console.log(result.line);
  const problems = [
    ...results.filter((result) => !result.ok).map((result) => result.line),
    ...(lightBlocksMatch ? [] : ["The two light blocks in src/styles.css differ; keep them identical."]),
    ...missingLight.map((name) => `${name} has a dark colour and no light value.`),
    ...unknownGreen.map((name) => `--status-unknown is green in ${name}.`),
  ];
  console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join("\n")}` : `\nAll ${results.length} pairs pass; the light blocks match; every colour has a light value.`);
  process.exit(problems.length ? 1 : 0);
}
