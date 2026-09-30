/**
 * The demo's password (antifascist.work).
 *
 * Everything the demo serves (the page, its scripts, the frozen API and the mockups) stays behind
 * one password, checked here on Cloudflare's side, so a crawler that does not have it gets a form
 * and nothing else to harvest. It keeps scrapers and AI crawlers out; it is not an account system,
 * and the demo holds nothing that belongs to anybody.
 *
 * The password is the Worker's secret DEMO_PASSWORD (`npx wrangler secret put DEMO_PASSWORD`),
 * never this repository. Without it every page says so rather than opening up. Unlocking sets a
 * cookie holding an HMAC of a fixed message keyed by the password: it cannot be turned back into
 * the password, and changing the password signs everyone out.
 */
const COOKIE = "boxpilot_demo";
const MESSAGE = "boxpilot-demo:v1";
const THIRTY_DAYS = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();

/** Asks search engines and AI crawlers to keep out of everything, the form included. */
export const noIndex = { "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noai, noimageai" };

async function sign(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Two strings compared to the end, so the time taken says nothing about where they differ. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function cookieOf(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** Where to go after unlocking: a path on this site, never another site ("//evil.example"). */
export function safeNext(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") && value.length <= 2000 ? value : "/";
}

const escape = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(status, { next = "/", wrong = false, unset = false } = {}) {
  const body = unset
    ? `<p>The demo's password is not set, so it stays closed. Whoever runs it sets it with <code>npx wrangler secret put DEMO_PASSWORD</code>.</p>`
    : `<p>This demo sits behind a password to keep scrapers and AI crawlers out. Whoever sent you the link can tell you what it is.</p>
      <form method="post" action="/__unlock">
        <input type="hidden" name="next" value="${escape(safeNext(next))}">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus${wrong ? ' aria-describedby="wrong" aria-invalid="true"' : ""}>
        ${wrong ? '<p id="wrong" class="wrong" role="alert">That is not the password.</p>' : ""}
        <button type="submit">Open the demo</button>
      </form>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive, noai, noimageai">
  <title>BoxPilot demo</title>
  <style>
    :root { color-scheme: light dark; --bg: #eef2f5; --card: #ffffff; --ink: #13212c; --muted: #52606b; --line: #c8d1d8; --accent: #0b7489; --danger: #b3261e; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111820; --card: #1a2430; --ink: #e8eef3; --muted: #9aa8b4; --line: #33414f; --accent: #56c8e0; --danger: #ff8a80; } }
    * { box-sizing: border-box; }
    body { display: grid; min-height: 100vh; margin: 0; padding: 16px; place-items: center; color: var(--ink); background: var(--bg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { width: 100%; max-width: 380px; padding: 28px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    .mark { display: inline-grid; width: 34px; height: 34px; margin-bottom: 14px; place-items: center; border-radius: 9px; color: #fff; background: #2f6fe4; font-weight: 800; font-size: 14px; }
    p { margin: 0 0 18px; color: var(--muted); }
    label { display: block; margin-bottom: 6px; font-weight: 600; }
    input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--bg); font: inherit; }
    input[type="password"]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .wrong { margin: 8px 0 0; color: var(--danger); font-weight: 600; }
    button { width: 100%; margin-top: 16px; padding: 10px 12px; border: 0; border-radius: 8px; color: #fff; background: #2f6fe4; font: inherit; font-weight: 700; cursor: pointer; }
    code { font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">BP</div>
    <h1>BoxPilot demo</h1>
    ${body}
  </main>
</body>
</html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...noIndex } });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops a request that has not given the password, or answers the form and robots.txt. Returns
 * null when the request may go on to the demo. `wait` slows every wrong guess down.
 */
export async function gate(request, env, { wait = () => sleep(800) } = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", ...noIndex } });
  }
  const password = typeof env.DEMO_PASSWORD === "string" ? env.DEMO_PASSWORD : "";
  if (!password) return page(503, { unset: true });
  const token = await sign(password, MESSAGE);

  if (url.pathname === "/__unlock" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get("password") ?? "");
    const next = safeNext(String(form?.get("next") ?? "/"));
    if (given && same(await sign(given, MESSAGE), token)) {
      return new Response(null, {
        status: 303,
        headers: { location: next, "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=${THIRTY_DAYS}; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store", ...noIndex },
      });
    }
    await wait();
    return page(401, { next, wrong: true });
  }

  if (same(cookieOf(request, COOKIE) ?? "", token)) return null;
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "The demo needs its password", code: "demo_locked" }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store", ...noIndex } });
  }
  return page(401, { next: `${url.pathname}${url.search}` });
}
