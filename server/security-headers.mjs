import { createHash } from "node:crypto";

/**
 * The response headers every page and API answer carries, including a Content-Security-Policy.
 *
 * The four headers below have been set since early on, and so has a policy - one that said
 * `script-src 'self'` while the shell carries an inline script (the theme bootstrap), so the
 * browser refused that script on every page load: a wrong-theme flash and a console error nobody
 * was looking at. The policy is strict on purpose: nothing loads from any origin but this one, no inline script runs unless its hash is
 * listed, no inline style unless likewise. That is affordable here because the shell has exactly
 * one inline script (the theme bootstrap, so the page does not flash the wrong theme before React
 * mounts), React sets inline styles through the CSSOM (which CSP does not police - only <style>
 * elements and style="" attributes are), and blob: URLs appear only as download links (navigation,
 * which CSP does not police either). Everything else the app does - fetch, EventSource - is same
 * origin.
 *
 * The hashes are taken from the HTML actually served rather than typed in, so editing the theme
 * script does not silently break it. Pages that render their own HTML with their own inline pieces
 * (the OIDC consent page) set their own policy on the response, which replaces this one.
 */

/** Inline <script> and <style> bodies in an HTML string, exactly as the browser will hash them. */
export function inlineSources(html) {
  const scripts = [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const styles = [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
  return { scripts, styles };
}

const hash = (source) => `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;

/** The policy string for a page whose inline pieces are the given sources. */
export function contentSecurityPolicy({ scripts = [], styles = [] } = {}) {
  const scriptSources = ["'self'", ...scripts.map(hash)];
  const styleSources = ["'self'", ...styles.map(hash)];
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${styleSources.join(" ")}`,
    // data: for the inline SVG icons some manifests carry; blob: is never fetched as an image.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Middleware. `html` is the shell (and anything else that will be inlined into it) so the hashes
 * match what is served. Routes that send different HTML set their own header afterwards.
 */
export function securityHeaders({ html = "" } = {}) {
  const policy = contentSecurityPolicy(inlineSources(html));
  return function setSecurityHeaders(request, response, next) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", policy);
    // API answers are the state of this server right now, for the person signed in right now. They
    // must not sit in a disk cache or the back-forward cache to be shown again later, or to someone
    // else on a shared machine. This was set before the headers moved here and was lost in the move;
    // the review of that release caught it.
    if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    next();
  };
}
