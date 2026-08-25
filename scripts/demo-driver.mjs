/**
 * Drive the demo in a headless browser: load a page, read what is there, click something, read
 * what changed. Used by `demo-sweep.mjs` and by hand when checking a single screen.
 *
 * This exists because looking at the interface is the only way to find out what it does. Types and
 * unit tests both agreed the router form was fine while its button could not be clicked, and agreed
 * every page rendered while six of them were blank.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const chromePaths = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const findChrome = () => chromePaths.find((candidate) => existsSync(candidate)) ?? null;
/** Whether anything answers on the port; used both to refuse a stale server and to wait for ours. */
async function reachable(port) {
  try { await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(700) }); return true; } catch { return false; }
}
async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await condition()) return true; await sleep(150); }
  return false;
}

export const chromeHint = `No Chrome found; this needs one of:\n  ${chromePaths.join("\n  ")}`;

/** Start the demo server and a browser attached to it. Returns the handles and a `close`. */
export async function open({ port = 8799, startDemo = true, width = 1440, height = 1600 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error(chromeHint);
  // A demo left running from an earlier session keeps the port and serves its own, older fixtures,
  // so a freshly started one loses the race silently and everything you then read is about code you
  // are not looking at. That cost a round of chasing a crash that had already been fixed.
  if (startDemo && await reachable(port)) {
    throw new Error(`Something is already serving http://127.0.0.1:${port} — probably a demo left running.\nStop it first, or the sweep reports on whatever that is:\n  pkill -f boxpilot-demo.mjs`);
  }
  const demo = startDemo ? spawn(process.execPath, [path.join(import.meta.dirname, "boxpilot-demo.mjs")], { stdio: "ignore" }) : null;
  if (demo) {
    const ready = await waitFor(() => reachable(port), 8000);
    if (!ready) { demo.kill(); throw new Error("The demo server did not start"); }
  }

  const profile = mkdtempSync(path.join(os.tmpdir(), "boxpilot-drive-"));
  const browser = spawn(chrome, ["--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not report a debugging endpoint")), 20_000);
    browser.stderr.on("data", (chunk) => { buffer += chunk; const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json();
  const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

  let nextId = 1;
  const pending = new Map();
  let noticed = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const promise = pending.get(message.id); pending.delete(message.id);
      message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") noticed.push({ kind: "exception", text: String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).split("\n")[0].slice(0, 180) });
    else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") noticed.push({ kind: "console", text: message.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" ").split("\n")[0].slice(0, 180) });
    else if (message.method === "Network.responseReceived" && message.params.response.status >= 500) noticed.push({ kind: "http", text: `${message.params.response.status} ${message.params.response.url.replace(/^https?:\/\/[^/]+/, "")}` });
  });

  const send = (method, params = {}) => { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const go = async (view, { scenario = "default", settle = 1700 } = {}) => {
    noticed = [];
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?view=${view}${scenario === "default" ? "" : `&scenario=${scenario}`}` });
    await sleep(settle);
  };
  /** Text of a panel by a phrase in it, which is how a person finds one. */
  const panelText = (phrase) => evaluate(`([...document.querySelectorAll("section.panel")].find((s) => /${phrase}/.test(s.innerText))?.innerText ?? "PANEL NOT FOUND")`);
  const shot = async (file, selector = 'document.querySelector("main")') => {
    const box = await evaluate(`(() => { const element = ${selector}; if (!element) return null; const rectangle = element.getBoundingClientRect(); const scroller = document.scrollingElement; return JSON.stringify({ x: Math.max(0, rectangle.left - 8), y: Math.max(0, rectangle.top + scroller.scrollTop - 8), width: Math.min(${width} - 10, rectangle.width + 16), height: Math.min(2400, rectangle.height + 16) }); })()`);
    if (!box) return false;
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { ...JSON.parse(box), scale: 1 }, captureBeyondViewport: true });
    writeFileSync(file, Buffer.from(data, "base64"));
    return true;
  };
  const close = () => {
    socket.close(); browser.kill(); demo?.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the profile is a temp dir; a straggling handle is not worth reporting */ }
  };
  return { send, evaluate, go, panelText, shot, close, problems: () => [...noticed] };
}
