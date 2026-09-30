#!/usr/bin/env node
/**
 * Measure a look against its drawing (M41). The looks in src/looks/ are built to match
 * docs/design-directions/05-looks.html; this draws that study's reference pictures and compares
 * the demo's screenshots with them.
 *
 *   node scripts/look-check.mjs refs
 *       Draws every reference picture into docs/design-directions/05-looks/refs/ at 1440x900:
 *       <look>-<page>[-<scheme>].jpg, pages home, storage and appearance (Settings → Appearance).
 *
 *   node scripts/look-check.mjs compare <reference> <screenshot> [out.jpg]
 *       Scores one screenshot against one reference and writes them side by side.
 *
 *   node scripts/look-check.mjs look <id> [shots-dir] [out-dir]
 *       Every reference of one look against the demo's screenshots of it, taken with
 *         LOOK=<id> VIEWPORT=1440x900 SCALE=1 SCHEMES=light,dark PAGES=home,storage \
 *         STATES="appearance=?view=settings&tab=appearance" OUT_DIR=<shots-dir> npm run demo:screenshots
 *       (a look with one mode is compared on its light capture). Prints a score per picture.
 *
 * The score is a guide, not a verdict: 0-100 from how close the colours are block by block (40%),
 * how closely the edges line up, which is the layout (35%), and how alike the palettes are (25%).
 * Two renders of the same drawing score above 95; a different look scores under 50. A person, or an
 * agent looking at the side-by-side picture, decides whether a look matches its drawing.
 *
 * Environment: CHROME and CHROME_ARGS as for demo-screenshots.mjs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Devtools, findChrome, launchChrome } from "./chrome-devtools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const study = path.join(root, "docs", "design-directions", "05-looks.html");
const refsDir = path.join(root, "docs", "design-directions", "05-looks", "refs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** reference name → the study's mockup, and whether it has a light and a dark picture. */
export const references = [
  ["blend-home", "blendHome", true],
  ["blend-storage", "blendStorage", true],
  ["blend-appearance", "settings", true],
  ["launcher-storage", "homeStorage", true],
  ["console-home", "opsHome", true],
  ["aqua-home", "aqua", false],
  ["blueprint-home", "blueprint", false],
  ["phosphor-home", "phosphor", false],
  ["rack-home", "rack", false],
  ["swiss-home", "swiss", false],
  ["toybox-home", "toybox", false],
  ["cockpit-home", "cockpit", false],
  ["eink-home", "eink", false],
  ["quest-home", "quest", false],
  ["transit-home", "transit", false],
];

/** The study's typefaces from node_modules, so the references never depend on Google Fonts. */
const localFaces = [
  ["Figtree", "300 900", "@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2"],
  ["JetBrains Mono", "100 800", "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"],
  ["IBM Plex Sans Condensed", "400", "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-400-normal.woff2"],
  ["IBM Plex Sans Condensed", "600", "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-600-normal.woff2"],
  ["IBM Plex Sans Condensed", "700", "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-700-normal.woff2"],
  ["Archivo", "100 900", "@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2"],
  ["B612", "400", "@fontsource/b612/files/b612-latin-400-normal.woff2"],
  ["B612", "700", "@fontsource/b612/files/b612-latin-700-normal.woff2"],
  ["B612 Mono", "400", "@fontsource/b612-mono/files/b612-mono-latin-400-normal.woff2"],
  ["B612 Mono", "700", "@fontsource/b612-mono/files/b612-mono-latin-700-normal.woff2"],
  ["Barlow Condensed", "500", "@fontsource/barlow-condensed/files/barlow-condensed-latin-500-normal.woff2"],
  ["Barlow Condensed", "600", "@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2"],
  ["Barlow Condensed", "700", "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2"],
  ["Fredoka", "300 700", "@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2"],
  ["Literata", "200 900", "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2"],
  ["Martian Mono", "100 800", "@fontsource-variable/martian-mono/files/martian-mono-latin-wght-normal.woff2"],
  ["Overpass", "100 900", "@fontsource-variable/overpass/files/overpass-latin-wght-normal.woff2"],
  ["PT Sans", "400", "@fontsource/pt-sans/files/pt-sans-latin-400-normal.woff2"],
  ["PT Sans", "700", "@fontsource/pt-sans/files/pt-sans-latin-700-normal.woff2"],
  ["Pixelify Sans", "400 700", "@fontsource-variable/pixelify-sans/files/pixelify-sans-latin-wght-normal.woff2"],
  ["Share Tech Mono", "400", "@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2"],
  ["VT323", "400", "@fontsource/vt323/files/vt323-latin-400-normal.woff2"],
];

async function withChrome(width, height, run) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "boxpilot-looks-"));
  const { child, host } = await launchChrome(findChrome(), profile, { width, height, deviceScaleFactor: 1, mobile: false });
  try {
    const targets = await (await fetch(`http://${host}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const devtools = new Devtools(socket);
    await devtools.send("Page.enable");
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const result = await run(devtools);
    socket.close();
    return result;
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function drawReferences() {
  mkdirSync(refsDir, { recursive: true });
  const faces = localFaces.map(([family, weight, file]) => {
    const source = path.join(root, "node_modules", file);
    if (!existsSync(source)) throw new Error(`Missing ${file}: run npm ci first`);
    return `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;src:url("${pathToFileURL(source).href}") format("woff2")}`;
  }).join("");
  await withChrome(1440, 900, async (devtools) => {
    for (const [name, mockup, twoModes] of references) {
      for (const scheme of twoModes ? ["light", "dark"] : ["light"]) {
        await devtools.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        const loaded = devtools.once("Page.loadEventFired");
        // A query per picture, so each is a fresh load rather than a jump within the page.
        await devtools.send("Page.navigate", { url: `${pathToFileURL(study).href}?ref=${name}-${scheme}#only=${mockup}` });
        await loaded;
        await devtools.evaluate(`(() => { document.querySelectorAll('link[href*="fonts.googleapis"]').forEach((link) => link.remove()); const style = document.createElement("style"); style.textContent = ${JSON.stringify(faces)}; document.head.append(style); })()`);
        await devtools.evaluate("document.fonts.ready.then(() => true)");
        await sleep(600);
        const { data } = await devtools.send("Page.captureScreenshot", { format: "jpeg", quality: 82, clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });
        const file = path.join(refsDir, `${name}${twoModes ? `-${scheme}` : ""}.jpg`);
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(path.relative(root, file));
      }
    }
  });
}

const dataUrl = (file) => `data:image/${file.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(file).toString("base64")}`;

/** Runs in the browser: the three measures and the side-by-side picture. */
const measure = `async (reference, shot) => {
  const load = async (source) => { const image = new Image(); image.src = source; await image.decode(); return image; };
  const [a, b] = await Promise.all([load(reference), load(shot)]);
  const W = 1440, H = 900;
  const pixels = (image, width, height, gray) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, image.width, Math.min(image.height, image.width * H / W), 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    if (!gray) return data;
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i += 1) out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    return out;
  };
  // Colour, block by block.
  const ca = pixels(a, 48, 30), cb = pixels(b, 48, 30);
  let difference = 0;
  for (let i = 0; i < ca.length; i += 4) difference += (Math.abs(ca[i] - cb[i]) + Math.abs(ca[i + 1] - cb[i + 1]) + Math.abs(ca[i + 2] - cb[i + 2])) / 3;
  const colour = 1 - difference / (ca.length / 4) / 255;
  // Layout: where the edges are, softened, correlated.
  const EW = 240, EH = 150;
  const edges = (gray) => {
    const out = new Float32Array(EW * EH);
    for (let y = 1; y < EH - 1; y += 1) for (let x = 1; x < EW - 1; x += 1) {
      const at = (dx, dy) => gray[(y + dy) * EW + x + dx];
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      out[y * EW + x] = Math.hypot(gx, gy);
    }
    const soft = new Float32Array(EW * EH);
    for (let y = 2; y < EH - 2; y += 1) for (let x = 2; x < EW - 2; x += 1) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) sum += out[(y + dy) * EW + x + dx];
      soft[y * EW + x] = sum / 25;
    }
    return soft;
  };
  const ea = edges(pixels(a, EW, EH, true)), eb = edges(pixels(b, EW, EH, true));
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(ea), mb = mean(eb);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < ea.length; i += 1) { cov += (ea[i] - ma) * (eb[i] - mb); va += (ea[i] - ma) ** 2; vb += (eb[i] - mb) ** 2; }
  const layout = Math.max(0, cov / Math.sqrt(va * vb || 1));
  // Palette: 3 bits a channel, histogram intersection.
  const pa = pixels(a, EW, EH), pb = pixels(b, EW, EH);
  const histogram = (p) => { const h = new Float32Array(512); for (let i = 0; i < p.length; i += 4) h[((p[i] >> 5) << 6) | ((p[i + 1] >> 5) << 3) | (p[i + 2] >> 5)] += 1; const n = p.length / 4; return h.map((x) => x / n); };
  const ha = histogram(pa), hb = histogram(pb);
  let palette = 0;
  for (let i = 0; i < 512; i += 1) palette += Math.min(ha[i], hb[i]);
  const score = Math.round(100 * (0.4 * colour + 0.35 * layout + 0.25 * palette));
  // The picture: reference | screenshot above, colour difference | edges of both below.
  const canvas = new OffscreenCanvas(W, H);
  const context = canvas.getContext("2d");
  context.fillStyle = "#111"; context.fillRect(0, 0, W, H);
  context.drawImage(a, 0, 0, a.width, Math.min(a.height, a.width * H / W), 0, 0, W / 2, H / 2);
  context.drawImage(b, 0, 0, b.width, Math.min(b.height, b.width * H / W), W / 2, 0, W / 2, H / 2);
  const half = (image) => pixels(image, W / 2, H / 2);
  const ra = half(a), rb = half(b);
  const diff = context.createImageData(W / 2, H / 2);
  for (let i = 0; i < ra.length; i += 4) {
    const d = Math.min(255, 2 * (Math.abs(ra[i] - rb[i]) + Math.abs(ra[i + 1] - rb[i + 1]) + Math.abs(ra[i + 2] - rb[i + 2])) / 3);
    diff.data[i] = d; diff.data[i + 1] = d * 0.35; diff.data[i + 2] = 0; diff.data[i + 3] = 255;
  }
  context.putImageData(diff, 0, H / 2);
  const overlay = context.createImageData(W / 2, H / 2);
  const ga = pixels(a, W / 2, H / 2, true), gb = pixels(b, W / 2, H / 2, true);
  const edge = (g, i, w) => Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]);
  for (let i = W / 2 + 1; i < ga.length - W / 2 - 1; i += 1) {
    overlay.data[i * 4] = Math.min(255, edge(ga, i, W / 2) * 3);
    overlay.data[i * 4 + 1] = Math.min(255, edge(gb, i, W / 2) * 3);
    overlay.data[i * 4 + 2] = Math.min(255, edge(gb, i, W / 2) * 3);
    overlay.data[i * 4 + 3] = 255;
  }
  context.putImageData(overlay, W / 2, H / 2);
  context.font = "bold 18px sans-serif"; context.fillStyle = "#fff";
  context.fillText("reference", 10, 24); context.fillText("screenshot", W / 2 + 10, 24);
  context.fillText("colour difference (brighter = further apart)", 10, H / 2 + 24);
  context.fillText("edges: red = reference only, cyan = screenshot only, white = both", W / 2 + 10, H / 2 + 24);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = ""; for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { score, colour: Math.round(colour * 100), layout: Math.round(layout * 100), palette: Math.round(palette * 100), picture: btoa(binary) };
}`;

async function compareAll(pairs) {
  return withChrome(800, 600, async (devtools) => {
    const results = [];
    for (const { reference, shot, out } of pairs) {
      const { result, exceptionDetails } = await devtools.send("Runtime.evaluate", { expression: `(${measure})(${JSON.stringify(dataUrl(reference))}, ${JSON.stringify(dataUrl(shot))})`, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(`Measuring ${path.basename(shot)} failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      const { picture, ...scores } = result.value;
      if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, Buffer.from(picture, "base64")); }
      results.push({ reference, shot, out, ...scores });
    }
    return results;
  });
}

const print = (results) => {
  for (const r of results) console.log(`${String(r.score).padStart(3)}  colour ${r.colour}  layout ${r.layout}  palette ${r.palette}  ${path.relative(root, r.shot)}${r.out ? `  → ${path.relative(root, r.out)}` : ""}`);
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "refs") return drawReferences();
  if (command === "compare") {
    const [reference, shot, out] = args;
    if (!reference || !shot) throw new Error("compare takes <reference> <screenshot> [out.jpg]");
    return print(await compareAll([{ reference, shot, out }]));
  }
  if (command === "look") {
    const [id, shots = path.join(root, "look-shots"), out = path.join(shots, "compare")] = args;
    if (!id) throw new Error("look takes <id> [shots-dir] [out-dir]");
    const pairs = [];
    for (const file of readdirSync(refsDir).filter((name) => name.startsWith(`${id}-`)).sort()) {
      const stem = file.replace(/\.jpg$/, "");
      const scheme = /-(light|dark)$/.exec(stem)?.[1];
      const shot = path.join(shots, scheme ? `${stem}.png` : `${stem}-light.png`);
      if (!existsSync(shot)) { console.log(`no screenshot for ${stem}: expected ${path.relative(root, shot)}`); continue; }
      pairs.push({ reference: path.join(refsDir, file), shot, out: path.join(out, `${stem}.jpg`) });
    }
    if (pairs.length === 0) throw new Error(`No reference of ${id} had a screenshot to compare`);
    return print(await compareAll(pairs));
  }
  throw new Error("Usage: node scripts/look-check.mjs refs | compare <reference> <screenshot> [out.jpg] | look <id> [shots-dir] [out-dir]");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
