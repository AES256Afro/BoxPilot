/*
 * The looks (M41, ADR-010): thirteen ways the whole interface can be drawn, chosen in Settings →
 * Appearance and kept per browser like light and dark. A look is a skin and a Home:
 *
 *   - the skin is one set of values for the tokens every page already draws from (the console's
 *     --cc-* family, the fonts, the radii) plus the look's own surfaces and nav, all in
 *     src/looks/<id>/skin.css and scoped to :root[data-look="<id>"], so no page carries look code;
 *   - the Home is src/looks/<id>/Home.tsx, reading the same facts as every other Home.
 *
 * The drawings each look is built to match are docs/design-directions/05-looks.html, with a
 * reference picture of every one in docs/design-directions/05-looks/.
 */

export const LOOK_IDS = ["blend", "launcher", "console", "aqua", "blueprint", "phosphor", "rack", "swiss", "toybox", "cockpit", "eink", "quest", "transit"] as const;
export type LookId = (typeof LOOK_IDS)[number];

/** Which of light and dark a look has. A look with one draws it whatever the device prefers. */
export type LookModes = "both" | "light" | "dark";

/**
 * How the areas are reached: the glass sidebar (Home + Ops), the floating dock (the Launcher), the
 * console's rail, soft keys along the bottom (the cockpit), or a line of words across the top.
 */
export type LookNav = "sidebar" | "dock" | "rail" | "keys" | "top";

export interface Look {
  id: LookId;
  name: string;
  /** Under the name on its card: which modes, or what it is today. */
  caption: string;
  modes: LookModes;
  nav: LookNav;
  /** One sentence for the card and the screen reader. */
  about: string;
  /** Takes the accent and wallpaper choices (the glass looks); the others keep their own colours. */
  personal: boolean;
}

export const LOOKS: readonly Look[] = [
  { id: "blend", name: "Home + Ops", caption: "Light and dark", modes: "both", nav: "sidebar", personal: true, about: "Home's wallpaper and glass as the frame, the console's numbers and compact tables inside it." },
  { id: "launcher", name: "Launcher", caption: "Today's Home", modes: "both", nav: "dock", personal: true, about: "Home's wallpaper, frosted glass and dock on every page." },
  { id: "console", name: "Command Center", caption: "Today's Ops", modes: "both", nav: "rail", personal: false, about: "The Ops console on every page, Home included." },
  { id: "aqua", name: "Aqua", caption: "Light only", modes: "light", nav: "sidebar", personal: false, about: "Mac OS X, 2001: pinstripes, gel buttons, a source list and a dock." },
  { id: "blueprint", name: "Blueprint", caption: "Dark only", modes: "dark", nav: "rail", personal: false, about: "The server as a technical drawing on blue drafting paper." },
  { id: "phosphor", name: "Phosphor", caption: "Dark only", modes: "dark", nav: "rail", personal: false, about: "A green CRT terminal with a key for every action." },
  { id: "rack", name: "Rack Panel", caption: "One look", modes: "dark", nav: "rail", personal: false, about: "Brushed-metal rack units, LEDs and segment displays." },
  { id: "swiss", name: "Swiss Poster", caption: "Light only", modes: "light", nav: "top", personal: false, about: "White, black and one red; type and rules, no boxes." },
  { id: "toybox", name: "Toybox", caption: "Light only", modes: "light", nav: "sidebar", personal: false, about: "Chunky pastel cards and buttons that press down." },
  { id: "cockpit", name: "Glass Cockpit", caption: "Dark only", modes: "dark", nav: "keys", personal: false, about: "Round gauges, a master caution lamp and soft keys." },
  { id: "eink", name: "E-Ink", caption: "No color", modes: "light", nav: "top", personal: false, about: "Black on e-paper grey: serif text, dithered bars, shapes and words for status." },
  { id: "quest", name: "Quest", caption: "Dark only", modes: "dark", nav: "rail", personal: false, about: "An RPG party screen: apps are party members, problems are quests." },
  { id: "transit", name: "Transit Map", caption: "Light only", modes: "light", nav: "rail", personal: false, about: "The box as a subway map, with a line status board." },
];

export const DEFAULT_LOOK: LookId = "blend";

export const isLookId = (value: unknown): value is LookId => typeof value === "string" && (LOOK_IDS as readonly string[]).includes(value);

export function lookById(id: LookId): Look {
  return LOOKS.find((look) => look.id === id) ?? LOOKS[0];
}

/** Where the look applies: every page, or every page but Home, which then keeps today's Launcher. */
export const LOOK_SCOPES = [
  { id: "all", label: "Every page" },
  { id: "not-home", label: "Not Home" },
] as const;
export type LookScope = (typeof LOOK_SCOPES)[number]["id"];

/** Buttons, selection and measured values, in the looks that take it (`personal`). */
export const ACCENTS = [
  { id: "sea", label: "Sea", swatch: "#17625f" },
  { id: "amber", label: "Amber", swatch: "#b45309" },
  { id: "blue", label: "Blue", swatch: "#2f6fe4" },
  { id: "violet", label: "Violet", swatch: "#9b45b8" },
  { id: "rose", label: "Rose", swatch: "#c8408a" },
  { id: "graphite", label: "Graphite", swatch: "#3f4654" },
] as const;
export type Accent = (typeof ACCENTS)[number]["id"];

/** What is behind the glass, in the looks that take it. */
export const WALLPAPERS = [
  { id: "sea", label: "Sea and sun" },
  { id: "dusk", label: "Dusk" },
  { id: "meadow", label: "Meadow" },
  { id: "plain", label: "Plain" },
] as const;
export type Wallpaper = (typeof WALLPAPERS)[number]["id"];

export const DENSITIES = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
] as const;
export type Density = (typeof DENSITIES)[number]["id"];
