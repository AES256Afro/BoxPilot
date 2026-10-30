/**
 * dist/sw.js, put together (M25.1): the build's version and the files to keep first, then the rules
 * (src/pwa/swRules.js) with their `export`s taken off, then the worker's events (src/pwa/sw.js). One
 * classic script, because a module worker is not yet safe in every browser the owner may use, and
 * pure, so the tests build exactly what the build builds and run it.
 */
export interface ServiceWorkerParts {
  /** src/pwa/swRules.js as written. */
  rules: string;
  /** src/pwa/sw.js as written. */
  worker: string;
  /** Paths to keep when the worker installs: "/" (the shell), the entry bundle, its stylesheet, fonts, icons. */
  precache: string[];
  /** The product version; the precache list's digest is added so two builds of one version differ. */
  version: string;
}

/** FNV-1a over the list: a short, stable tag for "these files", not a security measure. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function serviceWorkerSource({ rules, worker, precache, version }: ServiceWorkerParts): string {
  const plain = rules.replace(/^export\s+(?=(const|function|let|async)\b)/gm, "");
  if (/^\s*(import|export)\b/m.test(plain) || /^\s*(import|export)\b/m.test(worker)) throw new Error("The service worker is a classic script: its sources may not import or export");
  const paths = [...new Set(precache)].filter((path) => path.startsWith("/") && !path.startsWith("//"));
  // The worker keeps the app, never an answer about the server or its people.
  const private_ = paths.filter((path) => /^\/(api|oidc|\.well-known)(\/|$)|^\/ca\.crt$/i.test(path));
  if (private_.length) throw new Error(`The service worker may not keep ${private_.join(", ")}`);
  const tag = `${version}-${digest(paths.join("\n"))}`;
  return [
    `/* BoxPilot's service worker, ${tag}. Built from src/pwa by vite.config.ts; edit those, not this. */`,
    `"use strict";`,
    `const VERSION = ${JSON.stringify(tag)};`,
    `const PRECACHE = ${JSON.stringify(paths)};`,
    plain.trim(),
    worker.trim(),
    "",
  ].join("\n");
}
