/**
 * Text out of a PDF (M37), for the agents' learning library, with no dependency: BoxPilot ships
 * none for this. It reads what most PDFs written by office software and browsers hold - Flate-
 * compressed content streams, object streams, and fonts with ToUnicode maps - walks the pages in
 * order, and turns the text operators into lines. Scanned images have no text to read; encrypted
 * files are refused. Everything is bounded: the file, the pages, the streams, the text.
 */
import { inflateSync } from "node:zlib";

export class PdfError extends Error {
  constructor(message) { super(message); this.expose = true; }
}

const limits = { bytes: 10 * 1024 * 1024, pages: 300, streamBytes: 8 * 1024 * 1024, chars: 256_000 };

// ---- objects ----

function readObjects(buffer) {
  const text = buffer.toString("latin1");
  const objects = new Map();
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const streamAt = body.search(/\bstream\r?\n/);
    let dict = body;
    let stream = null;
    if (streamAt >= 0) {
      dict = body.slice(0, streamAt);
      const dataStart = start + streamAt + body.slice(streamAt).match(/^stream\r?\n/)[0].length;
      const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = declared ? dataStart + Number(declared[1]) : text.indexOf("endstream", dataStart);
      if (dataEnd < dataStart || dataEnd > end) dataEnd = text.indexOf("endstream", dataStart);
      if (dataEnd > dataStart && dataEnd - dataStart <= limits.streamBytes) stream = buffer.subarray(dataStart, dataEnd);
    }
    objects.set(Number(match[1]), { dict, stream });
    pattern.lastIndex = end;
  }
  return { text, objects };
}

function decodeStream(object) {
  if (!object?.stream) return null;
  const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict)?.[1] ?? "";
  if (!filters) return object.stream;
  if (!/FlateDecode/.test(filters) || /\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(filters)) return null;
  try {
    const data = inflateSync(object.stream, { maxOutputLength: limits.streamBytes });
    return /\/DecodeParms[\s\S]*\/Predictor\s+1[0-5]/.test(object.dict) ? null : data;
  } catch {
    return null;
  }
}

/** Objects kept inside compressed object streams (PDF 1.5 and later). */
function expandObjectStreams(objects) {
  for (const [, object] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(object.dict)) continue;
    const data = decodeStream(object);
    if (!data) continue;
    const count = Number(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const content = data.toString("latin1");
    const header = content.slice(0, first).trim().split(/\s+/).map(Number);
    for (let index = 0; index < Math.min(count, 5_000); index += 1) {
      const number = header[index * 2];
      const offset = header[index * 2 + 1];
      const next = index + 1 < count ? header[index * 2 + 3] : content.length - first;
      if (!Number.isFinite(number) || objects.has(number)) continue;
      objects.set(number, { dict: content.slice(first + offset, first + next), stream: null });
    }
  }
}

const ref = (text, key) => { const found = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text); return found ? Number(found[1]) : null; };
const refs = (text) => [...String(text).matchAll(/(\d+)\s+\d+\s+R/g)].map((found) => Number(found[1]));

/** The value of a key that is an inline dictionary: `<< ... >>` with nesting. */
function inlineDict(text, key) {
  const at = text.search(new RegExp(`/${key}\\s*<<`));
  if (at < 0) return null;
  let depth = 0;
  for (let index = text.indexOf("<<", at); index < text.length - 1; index += 1) {
    if (text[index] === "<" && text[index + 1] === "<") { depth += 1; index += 1; } else if (text[index] === ">" && text[index + 1] === ">") { depth -= 1; index += 1; if (depth === 0) return text.slice(text.indexOf("<<", at) + 2, index - 1); }
  }
  return null;
}

// ---- fonts ----

function hexToCodes(hex) { return hex.replace(/\s+/g, ""); }
function utf16(hex) {
  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
  let out = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) out += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
  return out;
}

/** A ToUnicode CMap: code (as hex) to text, and how many bytes a code takes. */
export function parseCMap(text) {
  const map = new Map();
  let width = 1;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]*)>/g)) {
      const code = hexToCodes(pair[1]).toLowerCase();
      width = Math.max(width, code.length / 2);
      map.set(code, utf16(hexToCodes(pair[2])));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const low = Number.parseInt(range[1], 16);
      const high = Math.min(Number.parseInt(range[2], 16), low + 65_535);
      const digits = range[1].length;
      width = Math.max(width, digits / 2);
      if (range[3].startsWith("[")) {
        const targets = [...range[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((found) => utf16(found[1]));
        for (let code = low; code <= high && code - low < targets.length; code += 1) map.set(code.toString(16).padStart(digits, "0"), targets[code - low]);
      } else {
        const base = hexToCodes(range[3].slice(1, -1));
        const start = Number.parseInt(base.slice(-4) || "0", 16);
        const prefix = base.slice(0, -4);
        for (let code = low; code <= high; code += 1) map.set(code.toString(16).padStart(digits, "0"), utf16(prefix + (start + code - low).toString(16).padStart(4, "0")));
      }
    }
  }
  return { map, width };
}

function fontsFor(resources, objects, cache) {
  const fonts = new Map();
  if (!resources) return fonts;
  const fontDict = inlineDict(resources, "Font") ?? (() => { const at = ref(resources, "Font"); return at !== null ? objects.get(at)?.dict ?? null : null; })();
  if (!fontDict) return fonts;
  for (const entry of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const number = Number(entry[2]);
    if (!cache.has(number)) {
      const font = objects.get(number);
      const unicode = font ? ref(font.dict, "ToUnicode") : null;
      const data = unicode !== null ? decodeStream(objects.get(unicode)) : null;
      cache.set(number, data ? parseCMap(data.toString("latin1")) : null);
    }
    fonts.set(entry[1], cache.get(number));
  }
  return fonts;
}

// ---- content streams ----

function literalBytes(source, start) {
  const bytes = [];
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (next in escapes) { bytes.push(escapes[next]); index += 2; continue; }
      const octal = /^[0-7]{1,3}/.exec(source.slice(index + 1, index + 4));
      if (octal) { bytes.push(Number.parseInt(octal[0], 8) & 0xff); index += 1 + octal[0].length; continue; }
      index += 2; continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") { depth -= 1; if (depth === 0) { index += 1; break; } }
    bytes.push(source.charCodeAt(index) & 0xff);
    index += 1;
  }
  return { bytes: Buffer.from(bytes), end: index };
}

function decodeText(bytes, font) {
  if (!font) return bytes.toString("latin1");
  const hex = bytes.toString("hex");
  const step = font.width * 2;
  let out = "";
  for (let index = 0; index < hex.length; index += step) {
    const code = hex.slice(index, index + step);
    out += font.map.get(code) ?? (font.width === 1 ? String.fromCharCode(Number.parseInt(code, 16)) : "");
  }
  return out;
}

/** The text of one content stream, a line per text line. */
export function contentText(source, fonts) {
  let out = "";
  let font = null;
  const operands = [];
  let index = 0;
  const push = (value) => { operands.push(value); if (operands.length > 64) operands.shift(); };
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "%") { const end = source.indexOf("\n", index); index = end < 0 ? source.length : end; continue; }
    if (char === "(") { const read = literalBytes(source, index + 1); push({ string: read.bytes }); index = read.end; continue; }
    if (char === "<" && source[index + 1] !== "<") { const end = source.indexOf(">", index); push({ string: Buffer.from(source.slice(index + 1, end).replace(/\s+/g, ""), "hex") }); index = end + 1; continue; }
    if (char === "[") {
      const items = [];
      index += 1;
      while (index < source.length && source[index] !== "]") {
        const inner = source[index];
        if (/\s/.test(inner)) { index += 1; continue; }
        if (inner === "(") { const read = literalBytes(source, index + 1); items.push({ string: read.bytes }); index = read.end; continue; }
        if (inner === "<") { const end = source.indexOf(">", index); items.push({ string: Buffer.from(source.slice(index + 1, end).replace(/\s+/g, ""), "hex") }); index = end + 1; continue; }
        const number = /^-?\d*\.?\d+/.exec(source.slice(index, index + 20));
        if (number) { items.push(Number(number[0])); index += number[0].length; continue; }
        index += 1;
      }
      push({ array: items });
      index += 1;
      continue;
    }
    if (char === "<" && source[index + 1] === "<") { const end = source.indexOf(">>", index); index = end < 0 ? source.length : end + 2; continue; }
    if (char === "/") { const name = /^\/([^\s/<>[\]()%]*)/.exec(source.slice(index, index + 128)); push({ name: name[1] }); index += name[0].length; continue; }
    const number = /^[+-]?\d*\.?\d+/.exec(source.slice(index, index + 32));
    if (number) { push(Number(number[0])); index += number[0].length; continue; }
    const operator = /^[A-Za-z'"*]+/.exec(source.slice(index, index + 8));
    if (!operator) { index += 1; continue; }
    index += operator[0].length;
    const op = operator[0];
    if (op === "Tf") { const name = operands.findLast((value) => value?.name); font = name ? fonts.get(name.name) ?? null : null; }
    else if (op === "Tj" || op === "'" || op === "\"") { const value = operands.at(-1); if (op !== "Tj") out += "\n"; if (value?.string) out += decodeText(value.string, font); }
    else if (op === "TJ") { for (const item of operands.at(-1)?.array ?? []) { if (item?.string) out += decodeText(item.string, font); else if (typeof item === "number" && item < -180) out += " "; } }
    else if (op === "Td" || op === "TD") { const ty = operands.at(-1); if (typeof ty === "number" && Math.abs(ty) > 0.5) out += "\n"; else out += " "; }
    else if (op === "T*" || op === "ET") out += "\n";
    else if (op === "BI") { const end = source.indexOf("EI", index); index = end < 0 ? source.length : end + 2; }
    operands.length = 0;
    if (out.length > limits.chars * 2) break;
  }
  return out;
}

// ---- the document ----

/** The text of a PDF, page by page, and how many pages it had. */
export function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) throw new PdfError("That is not a PDF");
  if (buffer.length > limits.bytes) throw new PdfError(`A PDF can be at most ${limits.bytes / 1024 / 1024} MB`);
  if (buffer.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) throw new PdfError("That is not a PDF");
  const { text, objects } = readObjects(buffer);
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) throw new PdfError("The PDF is encrypted; save it without a password first");
  expandObjectStreams(objects);
  const root = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].map((found) => Number(found[1])).find((number) => objects.has(number));
  const pagesRoot = root !== undefined ? ref(objects.get(root).dict, "Pages") : null;
  const fontCache = new Map();
  const pages = [];
  const visit = (number, inherited, seen) => {
    if (pages.length >= limits.pages || seen.has(number)) return;
    seen.add(number);
    const node = objects.get(number);
    if (!node) return;
    const resources = inlineDict(node.dict, "Resources") ?? (ref(node.dict, "Resources") !== null ? objects.get(ref(node.dict, "Resources"))?.dict ?? null : null) ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.dict)?.[1] ?? "";
      for (const kid of refs(kids)) visit(kid, resources, seen);
      return;
    }
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(node.dict)?.[1] ?? "";
    const fonts = fontsFor(resources, objects, fontCache);
    const parts = refs(contents).map((at) => decodeStream(objects.get(at))).filter(Boolean).map((data) => data.toString("latin1"));
    pages.push(contentText(parts.join("\n"), fonts));
  };
  if (pagesRoot !== null) visit(pagesRoot, null, new Set());
  const cleaned = pages.map((page) => page.split("\n").map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
  let all = cleaned.join("\n\n").trim();
  if (all.length > limits.chars) all = `${all.slice(0, limits.chars)}…`;
  if (!all) throw new PdfError(pages.length ? "The PDF has no text to read: it may be scanned images" : "No pages could be read from the PDF");
  return { text: all, pages: pages.length };
}
