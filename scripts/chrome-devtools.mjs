/**
 * Headless Chrome over the DevTools protocol, for the scripts that photograph or measure the
 * interface (demo-screenshots.mjs, look-check.mjs): find a browser, start it with a window of the
 * given size, and send it commands. No dependency beyond Node's own WebSocket.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

export function findChrome() {
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

export class Devtools {
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

export async function launchChrome(chrome, profile, viewport) {
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
