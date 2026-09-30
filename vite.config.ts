import { readFileSync, readdirSync } from "node:fs";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { serviceWorkerSource } from "./src/pwa/serviceWorkerSource.ts";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// Counted from the catalog rather than typed into the copy, which drifted every time the catalog
// grew: the page claimed 128 apps when there were 161. Rounded down to the ten so it reads as the
// scale it is ("160+") and cannot be wrong the moment one more manifest lands.
//
// A missing catalog is not a build failure. The container build stage copies only what the web
// bundle needs, and the first version of this crashed it outright — a number on a chip is never
// worth that, so an absent directory just falls back to the vaguer wording.
function countManifests() {
  try { return readdirSync(new URL("./catalog", import.meta.url)).filter((name) => name.endsWith(".yaml")).length; } catch { return 0; }
}
const manifestCount = countManifests();
// The category count is read the same way, so "in 19 categories" cannot outlive a twentieth.
function countCategories() {
  try {
    const directory = new URL("./catalog/", import.meta.url);
    const categories = new Set<string>();
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".yaml"))) {
      const match = /^category:\s*["']?(.+?)["']?\s*$/m.exec(readFileSync(new URL(name, directory), "utf8"));
      if (match) categories.add(match[1]);
    }
    return categories.size;
  } catch { return 0; }
}
const categoryCount = countCategories();
const catalogSize = manifestCount >= 10 ? `${Math.floor(manifestCount / 10) * 10}+` : "Many";

// The typefaces in src/styles.css (M33.7) are under the SIL Open Font License, which asks that the
// licence travel with the fonts. The woff2 files carry their copyright in their own metadata; the
// build also writes each package's LICENSE next to them, from the installed package so it cannot
// fall out of step with the files it covers.
const fontPackages = ["@fontsource-variable/figtree", "@fontsource/ibm-plex-sans-condensed", "@fontsource-variable/jetbrains-mono"];
// The looks' typefaces (src/looks/fonts.css), fetched only by a page in the look that draws them.
const lookFontPackages = [
  "@fontsource-variable/archivo", "@fontsource/b612", "@fontsource/b612-mono", "@fontsource/barlow-condensed", "@fontsource-variable/fredoka",
  "@fontsource-variable/literata", "@fontsource-variable/martian-mono", "@fontsource-variable/overpass", "@fontsource/pt-sans",
  "@fontsource-variable/pixelify-sans", "@fontsource/share-tech-mono", "@fontsource/vt323",
];
function fontLicences(): Plugin {
  return {
    name: "boxpilot-font-licences",
    apply: "build",
    generateBundle() {
      for (const name of [...fontPackages, ...lookFontPackages]) {
        this.emitFile({ type: "asset", fileName: `licenses/${name.split("/")[1]}-OFL.txt`, source: readFileSync(new URL(`./node_modules/${name}/LICENSE`, import.meta.url)) });
      }
    },
  };
}

// The service worker (M25.1): the shell, the entry bundle and stylesheet, the fonts and the icons,
// kept so the installed app opens without a network. Written after the bundle is known, so its list
// names this build's hashed files; the rules live in src/pwa, where they are tested.
function serviceWorker(): Plugin {
  return {
    name: "boxpilot-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const precache = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk" && output.isEntry) {
          precache.push(`/${output.fileName}`, ...output.imports.map((name) => `/${name}`));
          precache.push(...[...(output.viteMetadata?.importedCss ?? [])].map((name) => `/${name}`));
        }
        // The entry's stylesheet, whether or not the bundler said the entry imports it; and the
        // interface's own fonts. A look's typefaces are cached when that look first draws them.
        if (output.type === "asset" && /^assets\/index-[\w-]+\.css$/.test(output.fileName)) precache.push(`/${output.fileName}`);
        if (output.type === "asset" && /^assets\/(figtree|ibm-plex-sans-condensed|jetbrains-mono)-[\w-]+\.woff2$/.test(output.fileName)) precache.push(`/${output.fileName}`);
      }
      const source = (file: string) => readFileSync(new URL(`./src/pwa/${file}`, import.meta.url), "utf8");
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource({ rules: source("swRules.js"), worker: source("sw.js"), precache, version }) });
    },
  };
}

export default defineConfig({
  define: { __BOXPILOT_VERSION__: JSON.stringify(version), __BOXPILOT_CATALOG_SIZE__: JSON.stringify(catalogSize), __BOXPILOT_CATALOG_CATEGORIES__: JSON.stringify(categoryCount) },
  plugins: [react(), fontLicences(), serviceWorker()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    css: true,
    // A git worktree under .claude/ holds a second copy of this repo, and collecting it runs the
    // whole suite twice against a stale tree — including the check that package.json and
    // docker-compose.yml agree, which fails there for a version that is not the one being built.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.git/**"],
  },
});
