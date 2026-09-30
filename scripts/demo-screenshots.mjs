#!/usr/bin/env node
/**
 * Capture screenshots of the demo server (npm run demo) with headless Chrome, driven over the
 * DevTools protocol so every page gets the same viewport and settle time, in dark and in light
 * (prefers-color-scheme is emulated, so the page follows it exactly as it follows a device set to
 * light or dark). The demo shows the fictional "homebox" fixtures, so nothing personal ends up
 * in the repo.
 *
 *   npm run build && npm run demo &
 *   npm run demo:screenshots                  # README pages, dark and light: <page>-<scheme>
 *   SCHEMES=dark npm run demo:screenshots     # the README images themselves: docs/screenshots/<page>.jpg
 *
 * Environment:
 *   CHROME       browser binary (found in the usual places otherwise)
 *   CHROME_ARGS  extra flags for it, space-separated (CI passes --no-sandbox)
 *   DEMO_URL     default http://127.0.0.1:8799
 *   OUT_DIR      default docs/screenshots
 *   PAGES        comma-separated page names, or "all": every page in the navigation, the setup
 *                wizard and the design system gallery. Default: the pages the README shows.
 *   SCHEMES      comma-separated, from dark and light. Default: dark,light. With one scheme the
 *                files are named <page>, with more <page>-<scheme>.
 *   FULL_PAGE    1 to capture each page's full height instead of the first screen
 *   SCALE        device pixel ratio, default 2
 *   WIDTH        the stored JPEG width on macOS, default 1600
 *   VIEWPORT     the window, as WIDTHxHEIGHT, default 1440x960. Under 768 px wide the page is
 *                emulated as a phone (VIEWPORT=375x812 is an iPhone's portrait width).
 *   SCENARIO     the demo world for every page: default, fresh or trouble. Files get a suffix.
 *   STATES       extra captures of states a page only reaches by clicking, separated by ";":
 *                name=query>click>click, for example
 *                "home-trouble=?scenario=trouble;activity=?scenario=trouble>Activity".
 *                Each click presses the first button, link or summary whose text or aria-label
 *                is that text (exact match first, then the first one starting with it); "text@2"
 *                presses the second. With STATES and no PAGES, only the states are photographed.
 *
 * It fails only when Chrome or the demo cannot run. A page that does not load is reported and
 * skipped, so one broken page still leaves every other screenshot to look at.
 */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.OUT_DIR ?? path.join(root, "docs", "screenshots");
const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:8799";
const storedWidth = Number.parseInt(process.env.WIDTH ?? "1600", 10);
const scale = Number.parseFloat(process.env.SCALE ?? "2") || 2;
const fullPage = process.env.FULL_PAGE === "1";
const [viewportWidth, viewportHeight] = (process.env.VIEWPORT ?? "1440x960").split("x").map((part) => Number.parseInt(part, 10));
if (!(viewportWidth >= 320 && viewportHeight >= 320)) throw new Error(`VIEWPORT takes WIDTHxHEIGHT, such as 375x812, not ${process.env.VIEWPORT}`);
// Under 768 px the page is a phone: the mobile flag makes Chrome honour the page's meta viewport.
const viewport = { width: viewportWidth, height: viewportHeight, deviceScaleFactor: scale, mobile: viewportWidth < 768 };
const scenario = (process.env.SCENARIO ?? "").trim();
if (scenario && !["default", "fresh", "trouble"].includes(scenario)) throw new Error(`SCENARIO takes default, fresh or trouble, not ${scenario}`);
const settleMs = 2500;
// Ops draws a sparkline from its own reads, one every five seconds from when it opens (M33.7);
// three reads are the first picture with a line worth looking at.
const settleFor = (query) => (/[?&]view=ops(&|$)/.test(query) ? 11_500 : settleMs);
const tallest = 12_000;

/** page file name → query string. The README's pages, in its order ("overview" is its first picture, now Home). */
const readmePages = [
  ["overview", "?view=home"], ["catalog", "?view=catalog"], ["automations", "?view=automations"], ["firewall", "?view=firewall"],
  ["storage", "?view=storage"], ["backups", "?view=backups"], ["network", "?view=network"], ["updates", "?view=updates"], ["system", "?view=system"],
  ["repairs", "?view=repairs"],
];

/**
 * Every page, read out of the navigation in src/data.ts as demo-sweep.mjs does, so a new page is
 * photographed without anyone remembering to add it; then the setup wizard and the gallery.
 */
function allPages() {
  const navSource = readFileSync(path.join(root, "src", "data.ts"), "utf8");
  const views = [...navSource.matchAll(/\{ id: "([a-z-]+)", label: "[^"]+", short: "[A-Z]{2}" \}/g)].map((match) => match[1]);
  if (views.length < 15) throw new Error("Reading the navigation from src/data.ts found too few pages");
  return [...views.map((view) => [view, `?view=${view}`]), ["setup", "?view=setup"], ["gallery", "?gallery"]];
}

/** STATES: name=query>click>click entries, each a page and the clicks that reach the state. */
function chooseStates() {
  return (process.env.STATES ?? "").split(";").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [name, rest = ""] = entry.split(/=(.*)/s);
    const [query, ...clicks] = rest.split(">").map((part) => part.trim());
    if (!/^[a-z0-9-]+$/.test(name ?? "") || !query?.startsWith("?")) throw new Error(`STATES entries look like name=?view=storage>Check this drive, not ${entry}`);
    return [name, query, clicks.filter(Boolean)];
  });
}

function choosePages() {
  const asked = (process.env.PAGES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (asked.length === 0 && (process.env.STATES ?? "").trim()) return [];
  if (asked.length === 0) return readmePages;
  const every = allPages();
  if (asked.includes("all")) return every;
  const known = new Map(every.map((entry) => [entry[0], entry]));
  const unknown = asked.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`Unknown page(s): ${unknown.join(", ")}. Known: ${[...known.keys()].join(", ")}`);
  return asked.map((name) => known.get(name));
}

function chooseSchemes() {
  const asked = (process.env.SCHEMES ?? "dark,light").split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = asked.filter((name) => name !== "dark" && name !== "light");
  if (unknown.length || asked.length === 0) throw new Error(`SCHEMES takes dark and/or light, not ${asked.join(",") || "nothing"}`);
  return [...new Set(asked)];
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error("No Chrome/Chromium binary found; set CHROME=/path/to/chrome");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Press the first control named `text` exactly, or else the first whose name starts with it;
 * `text@2` presses the second of them instead.
 */
const clickScript = (target) => `(() => {
  const [, want, nth] = ${JSON.stringify(target)}.match(/^(.*?)(?:@(\\d+))?$/);
  const index = Number(nth ?? 1) - 1;
  const names = (element) => [element.getAttribute("aria-label"), element.textContent].filter(Boolean).map((name) => name.replace(/\\s+/g, " ").trim());
  const controls = [...document.querySelectorAll("button:not([disabled]), a, summary, [role=button], [role=radio]")];
  const exact = controls.filter((element) => names(element).includes(want));
  const hit = (exact.length ? exact : controls.filter((element) => names(element).some((name) => name.startsWith(want))))[index];
  if (!hit) return false;
  hit.scrollIntoView({ block: "center" });
  hit.click();
  return true;
})()`;

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
    // A browser that dies mid-run must fail loudly rather than leave every request hanging.
    socket.addEventListener("close", () => {
      for (const [, { reject }] of this.pending) reject(new Error("The browser connection closed"));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const listener = (message) => {
        if (message.method !== method) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }
  async evaluate(expression) {
    const { result } = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    return result.value;
  }
}

async function launch(chrome, profile) {
  const extra = (process.env.CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);
  const child = spawn(chrome, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", ...extra,
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${viewport.width},${viewport.height}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not announce its DevTools endpoint")), 20_000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code}): ${buffer.trim().split("\n").slice(-3).join(" | ")}`)); });
  });
  const { host } = new URL(endpoint);
  return { child, host };
}

/** Write one capture, as PNG, or as a 1600 px JPEG on macOS (a fifth of the size, still crisp). */
function store(name, data) {
  const capture = path.join(outDir, `${name}.png`);
  writeFileSync(capture, Buffer.from(data, "base64"));
  if (process.platform !== "darwin") return capture;
  const file = path.join(outDir, `${name}.jpg`);
  execFileSync("sips", ["--resampleWidth", String(storedWidth), "-s", "format", "jpeg", "-s", "formatOptions", "85", capture, "--out", file], { stdio: "ignore" });
  unlinkSync(capture);
  return file;
}

async function capture(devtools) {
  if (!fullPage) return (await devtools.send("Page.captureScreenshot", { format: "png" })).data;
  // Grow the window to the page, so 100vh layouts (the sidebar) stretch with it, then put it back.
  const height = Math.min(tallest, Math.max(viewport.height, Number(await devtools.evaluate("Math.ceil(document.documentElement.scrollHeight)")) || viewport.height));
  await devtools.send("Emulation.setDeviceMetricsOverride", { ...viewport, height });
  await sleep(400);
  const { data } = await devtools.send("Page.captureScreenshot", { format: "png" });
  await devtools.send("Emulation.setDeviceMetricsOverride", viewport);
  return data;
}

async function main() {
  const pages = choosePages();
  const states = chooseStates();
  const schemes = chooseSchemes();
  // Say plainly when there is no demo to photograph, rather than timing out on the first page.
  try {
    const health = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`answered ${health.status}`);
  } catch (error) {
    throw new Error(`The demo is not answering at ${baseUrl} (${error.message}). Start it with: npm run build && npm run demo`);
  }
  const chrome = findChrome();
  const profile = mkdtempSync(path.join(os.tmpdir(), "boxpilot-shots-"));
  mkdirSync(outDir, { recursive: true });
  const { child, host } = await launch(chrome, profile);
  const skipped = [];
  let written = 0;
  try {
    const targets = await (await fetch(`http://${host}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome opened no page target");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const devtools = new Devtools(socket);
    await devtools.send("Page.enable");
    await devtools.send("Emulation.setDeviceMetricsOverride", viewport);
    // A phone is a touch screen (M25): the page's (pointer: coarse) rules - 44 px targets - apply.
    if (viewport.mobile) await devtools.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    // Pages in the chosen world, then the states, each reached from its page by its clicks.
    const inWorld = (query) => (scenario && scenario !== "default" ? `${query}${query.includes("?") ? "&" : "?"}scenario=${scenario}` : query);
    const suffix = scenario && scenario !== "default" ? `-${scenario}` : "";
    const captures = [...pages.map(([name, query]) => [`${name}${suffix}`, inWorld(query), []]), ...states];
    for (const [name, query, clicks] of captures) {
      try {
        await devtools.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: schemes[0] }] });
        const loaded = devtools.once("Page.loadEventFired");
        await devtools.send("Page.navigate", { url: `${baseUrl}/${query}` });
        await loaded;
        await sleep(settleFor(query));
        for (const text of clicks) {
          if (!(await devtools.evaluate(clickScript(text)))) throw new Error(`nothing to click named "${text}"`);
          await sleep(900);
        }
        const title = String(await devtools.evaluate("document.querySelector('main h1, h1')?.textContent ?? ''")).trim() || "no heading";
        // Each scheme on the same load: the stylesheet follows the emulated preference live.
        for (const [index, scheme] of schemes.entries()) {
          if (index > 0) {
            await devtools.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
            await sleep(400);
          }
          const applied = await devtools.evaluate("getComputedStyle(document.documentElement).colorScheme");
          // A page wider than the window scrolls sideways, which a picture clipped to the window hides.
          const overflow = Number(await devtools.evaluate("document.documentElement.scrollWidth - window.innerWidth")) || 0;
          // The typefaces are served by BoxPilot itself (M33.7): say so when one did not arrive.
          const fonts = String(await devtools.evaluate("[...document.fonts].filter((face) => face.status === 'error').map((face) => face.family).join(', ')") ?? "");
          const file = store(schemes.length > 1 ? `${name}-${scheme}` : name, await capture(devtools));
          written += 1;
          const mismatch = applied && !String(applied).includes(scheme) ? `  WARNING: the page rendered color-scheme "${applied}"` : "";
          const wide = overflow > 0 ? `  WARNING: ${overflow}px wider than the window` : "";
          const missing = fonts ? `  WARNING: fonts failed to load: ${fonts}` : "";
          console.log(`${file}  (${title}, ${scheme})${mismatch}${wide}${missing}`);
          if (index === 0 && (name === "home" || name === "ops")) {
            const loaded = await devtools.evaluate("[...new Set([...document.fonts].filter((face) => face.status === 'loaded').map((face) => `${face.family} ${face.weight}`))].join(', ')");
            console.log(`  fonts loaded from ${baseUrl}: ${loaded || "none"}`);
          }
        }
      } catch (error) {
        skipped.push(`${name}: ${error.message}`);
        console.log(`skipped ${name}: ${error.message}`);
        if (/connection closed|exited/i.test(error.message)) throw error;
      }
    }
    socket.close();
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(`\n${written} screenshot(s) in ${outDir}${skipped.length ? `; ${skipped.length} page(s) skipped:\n  ${skipped.join("\n  ")}` : ""}`);
  if (written === 0) throw new Error("No screenshot was taken");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
