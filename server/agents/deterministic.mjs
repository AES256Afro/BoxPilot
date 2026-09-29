/**
 * Exact work for agents (M37): arithmetic, dates, units, JSON and patterns, done by code rather
 * than by a small model in its head (which gets sums wrong). Each takes checked input from the
 * tool registry and returns text for the model; none reads or changes anything on the server.
 *
 * The calculator parses its own small grammar - never eval - and the pattern tool runs the regular
 * expression in a worker it stops after half a second, so a pattern that backtracks forever cannot
 * hold the web process.
 */
import { Worker } from "node:worker_threads";

export class ExactError extends Error {
  constructor(message) { super(message); this.expose = true; }
}

// ---- the calculator ----

const functions = {
  round: (value, digits = 0) => { const scale = 10 ** Math.max(0, Math.min(12, Math.trunc(digits))); return Math.round(value * scale) / scale; },
  floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: (value) => { if (value < 0) throw new ExactError("No square root of a negative number"); return Math.sqrt(value); },
  min: (...values) => Math.min(...values), max: (...values) => Math.max(...values),
};

function tokenize(expression) {
  const tokens = [];
  const text = String(expression);
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (/\s/.test(char)) { at += 1; continue; }
    const number = /^(\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(at));
    if (number) { tokens.push({ kind: "number", value: Number(number[0]) }); at += number[0].length; continue; }
    const word = /^[a-z]+/i.exec(text.slice(at));
    if (word) { tokens.push({ kind: "name", value: word[0].toLowerCase() }); at += word[0].length; continue; }
    if ("+-*/%^(),".includes(char)) { tokens.push({ kind: char }); at += 1; continue; }
    throw new ExactError(`The calculator does not know "${char}"`);
  }
  if (tokens.length > 400) throw new ExactError("The expression is too long");
  return tokens;
}

/** Evaluate an arithmetic expression exactly as written: precedence ^, then * / %, then + -. */
export function calculate(expression) {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const take = (kind) => { const token = tokens[at]; if (!token || (kind && token.kind !== kind)) throw new ExactError(`Expected ${kind ?? "more"} in the expression`); at += 1; return token; };
  const primary = () => {
    const token = peek();
    if (!token) throw new ExactError("The expression ends too soon");
    if (token.kind === "number") { at += 1; return token.value; }
    if (token.kind === "-") { at += 1; return -power(); }
    if (token.kind === "+") { at += 1; return power(); }
    if (token.kind === "(") { at += 1; const value = sum(); take(")"); return value; }
    if (token.kind === "name") {
      at += 1;
      if (token.value === "pi") return Math.PI;
      const fn = functions[token.value];
      if (!fn) throw new ExactError(`The calculator has no ${token.value}`);
      take("(");
      const args = [sum()];
      while (peek()?.kind === ",") { at += 1; args.push(sum()); }
      take(")");
      return fn(...args);
    }
    throw new ExactError("The expression is not arithmetic");
  };
  const power = () => { const base = primary(); if (peek()?.kind === "^") { at += 1; return base ** power(); } return base; };
  const product = () => {
    let value = power();
    while (peek() && ["*", "/", "%"].includes(peek().kind)) {
      const operator = take().kind;
      const right = power();
      if ((operator === "/" || operator === "%") && right === 0) throw new ExactError("Division by zero");
      value = operator === "*" ? value * right : operator === "/" ? value / right : value % right;
    }
    return value;
  };
  function sum() {
    let value = product();
    while (peek() && ["+", "-"].includes(peek().kind)) value = take().kind === "+" ? value + product() : value - product();
    return value;
  }
  const value = sum();
  if (at !== tokens.length) throw new ExactError("The expression has something left over");
  if (!Number.isFinite(value)) throw new ExactError("The result is not a finite number");
  return value;
}

const shown = (value) => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12))));

// ---- dates and times ----

const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
function dateOf(text, what) {
  if (text === undefined || text === null || text === "") return null;
  const value = new Date(text);
  if (Number.isNaN(value.getTime())) throw new ExactError(`${what} is not a date`);
  return value;
}

export function timeCalc({ op, at, to, amount, unit, timeZone }, { now = () => new Date() } = {}) {
  const start = dateOf(at, "at") ?? now();
  if (op === "now") return `Now: ${start.toISOString()} (${start.toLocaleString("en-GB", { timeZoneName: "short" })} on this server).`;
  if (op === "add") {
    if (!Number.isInteger(amount) || !unitMs[unit]) throw new ExactError("add needs an amount and a unit");
    const result = new Date(start.getTime() + amount * unitMs[unit]);
    return `${start.toISOString()} ${amount < 0 ? "minus" : "plus"} ${Math.abs(amount)} ${unit} is ${result.toISOString()}.`;
  }
  if (op === "between") {
    const end = dateOf(to, "to");
    if (!end) throw new ExactError("between needs a second date in to");
    const ms = end.getTime() - start.getTime();
    const days = ms / 86_400_000;
    return `From ${start.toISOString()} to ${end.toISOString()}: ${shown(days)} days, ${shown(ms / 3_600_000)} hours, ${shown(ms / 60_000)} minutes.`;
  }
  if (op === "format") {
    let text;
    try { text = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "long", ...(timeZone ? { timeZone } : {}) }).format(start); } catch { throw new ExactError(`There is no time zone called ${timeZone}`); }
    return `${start.toISOString()} is ${text}.`;
  }
  throw new ExactError("op is now, add, between or format");
}

// ---- units ----

const units = {
  b: ["size", 1], kb: ["size", 1e3], mb: ["size", 1e6], gb: ["size", 1e9], tb: ["size", 1e12],
  kib: ["size", 1024], mib: ["size", 1024 ** 2], gib: ["size", 1024 ** 3], tib: ["size", 1024 ** 4],
  ms: ["time", 1], s: ["time", 1_000], sec: ["time", 1_000], min: ["time", 60_000], h: ["time", 3_600_000], hr: ["time", 3_600_000], d: ["time", 86_400_000], day: ["time", 86_400_000],
  c: ["temperature", null], f: ["temperature", null], k: ["temperature", null],
};

export function convertUnits({ value, from, to }) {
  const number = Number(value);
  const a = units[String(from).toLowerCase()];
  const b = units[String(to).toLowerCase()];
  if (!Number.isFinite(number)) throw new ExactError("value is not a number");
  if (!a || !b) throw new ExactError(`Units are sizes (B, kB, MB, GB, TB, KiB, MiB, GiB, TiB), times (ms, s, min, h, d) or temperatures (C, F, K)`);
  if (a[0] !== b[0]) throw new ExactError(`${from} and ${to} measure different things`);
  let result;
  if (a[0] === "temperature") {
    const kelvin = { c: (x) => x + 273.15, f: (x) => (x - 32) * 5 / 9 + 273.15, k: (x) => x }[String(from).toLowerCase()](number);
    result = { c: (x) => x - 273.15, f: (x) => (x - 273.15) * 9 / 5 + 32, k: (x) => x }[String(to).toLowerCase()](kelvin);
  } else {
    result = (number * a[1]) / b[1];
  }
  return `${value} ${from} is ${shown(result)} ${to}.`;
}

// ---- JSON ----

function pathTokens(path) {
  const tokens = [];
  for (const part of String(path).split(".")) {
    const match = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part);
    if (!match) throw new ExactError(`The path has a part it cannot read: ${part}`);
    if (match[1]) tokens.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+|\*)\]/g)) tokens.push(index[1] === "*" ? "*" : Number(index[1]));
  }
  return tokens;
}

export function extractJson({ json, path }) {
  let value;
  try { value = JSON.parse(json); } catch { throw new ExactError("The text is not JSON"); }
  let current = [value];
  for (const token of pathTokens(path)) {
    const next = [];
    for (const node of current) {
      if (node === null || typeof node !== "object") continue;
      if (token === "*") next.push(...(Array.isArray(node) ? node : Object.values(node)));
      else if (Object.hasOwn(node, token)) next.push(node[token]);
    }
    current = next.slice(0, 200);
  }
  if (!current.length) return `Nothing at ${path}.`;
  const text = JSON.stringify(current.length === 1 ? current[0] : current, null, 1);
  return `${path}: ${text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text}`;
}

// ---- patterns ----

const matcher = `
const { parentPort, workerData } = require("node:worker_threads");
const { pattern, flags, text } = workerData;
let regex;
try { regex = new RegExp(pattern, flags.replace(/g/g, "") + "g"); } catch (error) { parentPort.postMessage({ error: "The pattern is not a regular expression: " + error.message }); return; }
const lines = text.split("\\n");
const found = [];
let total = 0;
for (let index = 0; index < lines.length; index += 1) {
  regex.lastIndex = 0;
  for (const match of lines[index].matchAll(regex)) {
    total += 1;
    if (found.length < 50) found.push({ line: index + 1, match: match[0].slice(0, 200), groups: match.slice(1, 6).map((group) => (group ?? "").slice(0, 120)) });
    if (match[0] === "") break;
  }
}
parentPort.postMessage({ found, total });
`;

/** Matches line by line, in a worker stopped after `timeoutMs`: a runaway pattern costs half a second. */
export function matchPattern({ pattern, text, flags = "" }, { timeoutMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`(() => {${matcher}})()`, { eval: true, workerData: { pattern, flags, text }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new ExactError(`The pattern took longer than ${timeoutMs} ms and was stopped`)); }, timeoutMs);
    worker.once("message", (reply) => {
      clearTimeout(timer);
      void worker.terminate();
      if (reply.error) { reject(new ExactError(reply.error)); return; }
      if (!reply.total) { resolve("No matches."); return; }
      const lines = reply.found.map((entry) => `line ${entry.line}: ${entry.match}${entry.groups.some(Boolean) ? ` (groups: ${entry.groups.join(" | ")})` : ""}`);
      resolve(`${reply.total} ${reply.total === 1 ? "match" : "matches"}${reply.total > reply.found.length ? `, the first ${reply.found.length}` : ""}:\n${lines.join("\n")}`);
    });
    worker.once("error", (error) => { clearTimeout(timer); reject(new ExactError(`The pattern failed: ${error.message}`)); });
  });
}

/** The exact tools by id, for the tool runner. */
export const exactTools = {
  calc: ({ expression }) => `${expression} = ${shown(calculate(expression))}`,
  "time.calc": (input, context) => timeCalc(input, context),
  "units.convert": (input) => convertUnits(input),
  "json.extract": (input) => extractJson(input),
  "regex.match": (input) => matchPattern(input),
};
