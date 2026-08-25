import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// Counted from the catalog rather than typed into the copy, which drifted every time the catalog
// grew: the page claimed 128 apps when there were 161. Rounded down to the ten so it reads as the
// scale it is ("150+") and cannot be wrong the moment one more manifest lands.
const manifestCount = readdirSync(new URL("./catalog", import.meta.url)).filter((name) => name.endsWith(".yaml")).length;
const catalogSize = `${Math.floor(manifestCount / 10) * 10}+`;

export default defineConfig({
  define: { __BOXPILOT_VERSION__: JSON.stringify(version), __BOXPILOT_CATALOG_SIZE__: JSON.stringify(catalogSize) },
  plugins: [react()],
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
