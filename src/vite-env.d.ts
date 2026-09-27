/// <reference types="vite/client" />

/** Product version injected at build time from package.json (see vite.config.ts). */
declare const __BOXPILOT_VERSION__: string;
declare const __BOXPILOT_CATALOG_SIZE__: string;
/** Distinct catalog categories, counted at build time; 0 when the catalog was not there to count. */
declare const __BOXPILOT_CATALOG_CATEGORIES__: number;
