#!/usr/bin/env node
/**
 * Capture the README screenshots from the demo server (npm run demo) with headless Chrome,
 * driven over the DevTools protocol so every page gets the same viewport and settle time.
 * The demo shows the fictional "homebox" fixtures, so nothing personal ends up in the repo.
 *
 *   npm run build && npm run demo &
 *   npm run demo:screenshots             # writes docs/screenshots/<page>.jpg (png off macOS)
 *
 * Environment: CHROME (browser binary), DEMO_URL (default http://127.0.0.1:8799),
 * OUT_DIR (default docs/screenshots), WIDTH (default 1600, the stored image width).
 */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.OUT_DIR ?? path.join(root, "docs", "screenshots");
const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:8799";
const storedWidth = Number.parseInt(process.env.WIDTH ?? "1600", 10);
const viewport = { width: 1440, height: 960, deviceScaleFactor: 2, mobile: false };
const settleMs = 2500;

/** page file name → view id (see src/data.ts navItems) */
const pages = [
  ["overview", "overview"], ["catalog", "catalog"], ["firewall", "firewall"], ["storage", "storage"],
  ["backups", "backups"], ["network", "network"], ["updates", "updates"], ["system", "system"],
];

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
}

async function launch(chrome, profile) {
  const child = spawn(chrome, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
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
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)); });
  });
  const { host } = new URL(endpoint);
  return { child, host };
}

async function main() {
  const chrome = findChrome();
  const profile = mkdtempSync(path.join(os.tmpdir(), "boxpilot-shots-"));
  mkdirSync(outDir, { recursive: true });
  const { child, host } = await launch(chrome, profile);
  try {
    const targets = await (await fetch(`http://${host}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome opened no page target");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const devtools = new Devtools(socket);
    await devtools.send("Page.enable");
    await devtools.send("Emulation.setDeviceMetricsOverride", viewport);
    for (const [name, view] of pages) {
      const loaded = devtools.once("Page.loadEventFired");
      await devtools.send("Page.navigate", { url: `${baseUrl}/?view=${view}` });
      await loaded;
      await sleep(settleMs);
      const title = await devtools.send("Runtime.evaluate", { expression: "document.querySelector('main h1, h1')?.textContent ?? ''", returnByValue: true });
      const { data } = await devtools.send("Page.captureScreenshot", { format: "png" });
      const capture = path.join(outDir, `${name}.png`);
      writeFileSync(capture, Buffer.from(data, "base64"));
      let file = capture;
      if (process.platform === "darwin") {
        // A 1600 px JPEG is a fifth of the size of the retina PNG and still crisp in a README.
        file = path.join(outDir, `${name}.jpg`);
        execFileSync("sips", ["--resampleWidth", String(storedWidth), "-s", "format", "jpeg", "-s", "formatOptions", "85", capture, "--out", file], { stdio: "ignore" });
        unlinkSync(capture);
      }
      console.log(`${file}  (${title.result.value.trim() || "no heading"})`);
    }
    socket.close();
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
