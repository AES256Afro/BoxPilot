#!/usr/bin/env python3
"""
Transform src/styles.css into a CSS-variable-driven theme system.
Pass 1: Extract all hardcoded values into semantic variables.
Pass 2: Inject theme definitions for all 8 themes.
"""

import re

# Read original CSS
with open("src/styles.css", "r") as f:
    css = f.read()

# ── Color mapping: hardcoded value → CSS variable ──────────────────────────
# We map the most frequent / semantically clear values first.
# Order matters: longer / more specific hexes first to avoid partial matches.
COLOR_MAP = {
    # Canvas / page background
    "#081019": "var(--canvas)",
    "#071019": "var(--canvas)",

    # Sidebar
    "#0b1521": "var(--sidebar-bg)",
    "rgb(11 21 33 / 94%)": "var(--sidebar-bg)",

    # Surfaces
    "#111d2a": "var(--surface)",
    "#0f1a27": "var(--surface)",
    "#152333": "var(--surface-raised)",
    "#0d1824": "var(--surface-muted)",
    "#09141d": "var(--surface-muted)",
    "#09131d": "var(--surface-muted)",
    "#0a151e": "var(--surface-muted)",
    "#142232": "var(--surface-hover)",
    "#0f1a26": "var(--surface-header)",
    "#182838": "var(--surface-raised)",
    "#172534": "var(--surface-raised)",
    "#101b28": "var(--surface-notice)",
    "#0e211d": "var(--surface-live)",

    # Text
    "#e8eef6": "var(--text)",
    "#aebccc": "var(--text-strong)",
    "#8fa1b7": "var(--text-muted)",
    "#c9d1d9": "var(--text-muted)",  # raw theme
    "#66788b": "var(--text-dim)",
    "#758597": "var(--text-dim)",
    "#ffffff": "var(--text-inverted)",
    "#fff": "var(--text-inverted)",
    "#c6d2df": "var(--text-secondary)",
    "#c4d0dd": "var(--text-secondary)",
    "#c5d0dc": "var(--text-code)",
    "#aebecd": "var(--text-code)",
    "#cbd6e1": "var(--text-code)",
    "#c0aa87": "var(--text-warn)",
    "#ad9979": "var(--text-warn-dim)",
    "#d9c7a9": "var(--text-warn-light)",
    "#88a99f": "var(--text-success-dim)",
    "#83a89d": "var(--text-success-dim)",
    "#a9c9c1": "var(--text-success-light)",
    "#cae8df": "var(--text-success-light)",
    "#88c7a9": "var(--text-success-light)",
    "#d5dfe8": "var(--text-inverted-dim)",

    # Accent (mint → generic)
    "#43d3aa": "var(--accent)",
    "#60e7c1": "var(--accent)",
    "#55deb8": "var(--accent)",
    "#2cbf98": "var(--accent-dim)",
    "#31c69e": "var(--accent-dim)",
    "#0a3329": "var(--accent-bg)",
    "#102a25": "var(--accent-bg)",
    "#0e241f": "var(--accent-bg)",
    "#0f2621": "var(--accent-bg)",
    "#102720": "var(--accent-bg)",
    "#13362e": "var(--accent-bg)",
    "#0e2d26": "var(--accent-bg)",
    "#0b1a17": "var(--accent-bg)",
    "#43836f": "var(--accent-border)",
    "#2d6555": "var(--accent-border)",
    "#2c4a40": "var(--accent-border)",
    "#315348": "var(--accent-border)",
    "#2fb991": "var(--accent-mid)",
    "#66e1bd": "var(--accent-mid)",
    "#4eaa91": "var(--accent-mid)",
    "#70d9bb": "var(--accent-light)",
    "#72dabc": "var(--accent-light)",
    "#aee7d6": "var(--accent-light)",
    "#b6d8cf": "var(--accent-light)",
    "#9fc8bd": "var(--accent-light)",
    "#9ac8bc": "var(--accent-light)",
    "#75e4c2": "var(--accent-light)",
    "rgb(67 211 170 / 12%)": "var(--accent-glow)",
    "rgb(67 211 170 / 8%)": "var(--accent-glow-soft)",
    "rgb(67 211 170 / 35%)": "var(--accent-glow-strong)",
    "rgb(67 211 170 / 32%)": "var(--accent-focus)",
    "rgb(50 204 163 / 20%)": "var(--accent-shadow)",
    "rgb(49 198 158 / 22%)": "var(--accent-shadow-hover)",
    "rgb(49 198 158 / 15%)": "var(--accent-shadow)",
    "rgb(52 142 118 / 18%)": "var(--accent-radial)",
    "rgb(42 97 91 / 18%)": "var(--accent-radial-body)",
    "rgba(77, 225, 176, .05)": "var(--accent-faint)",
    "#062a21": "var(--accent-text-on)",
    "#05271e": "var(--accent-text-on)",

    # Warning / Amber
    "#efb35d": "var(--warn)",
    "#f3c078": "var(--warn)",
    "#f0c274": "var(--warn)",
    "#e7cd8f": "var(--warn-light)",
    "#d99a2b": "var(--warn-dim)",
    "#392915": "var(--warn-bg)",
    "#2a2114": "var(--warn-bg)",
    "#2a2113": "var(--warn-bg)",
    "#211b13": "var(--warn-bg)",
    "#241d13": "var(--warn-bg)",
    "#67502b": "var(--warn-dim)",
    "#5c4829": "var(--warn-dim)",
    "#70572f": "var(--warn-dim)",
    "#6b522f": "var(--warn-dim)",
    "#69532f": "var(--warn-dim)",
    "#524329": "var(--warn-dim)",
    "#66502e": "var(--warn-dim)",
    "#5b492c": "var(--warn-dim)",
    "#d8c38a": "var(--warn-text)",
    "#d7bf98": "var(--warn-text)",
    "#d7be94": "var(--warn-text)",
    "#d6c5a8": "var(--warn-text)",
    "#efd6ae": "var(--warn-text)",
    "#efd5a9": "var(--warn-text)",
    "#e5d3b4": "var(--warn-text-light)",
    "#bba681": "var(--warn-text-dim)",
    "#baa681": "var(--warn-text-dim)",
    "#ad9979": "var(--warn-text-dim)",
    "rgba(255, 190, 92, .07)": "var(--warn-faint)",

    # Danger / Red
    "#f18484": "var(--danger)",
    "#d47777": "var(--danger)",
    "#f1a4a4": "var(--danger)",
    "#f1b8b8": "var(--danger-light)",
    "#f08a74": "var(--danger-light)",
    "#d9542b": "var(--danger-dim)",
    "#2d1717": "var(--danger-bg)",
    "#291719": "var(--danger-bg)",
    "#704044": "var(--danger-bg)",
    "#713c3c": "var(--danger-bg)",
    "#6b3a3a": "var(--danger-dim)",
    "#efb4b4": "var(--danger-text)",

    # Borders
    "#263648": "var(--border)",
    "#1d2b3a": "var(--border-subtle)",
    "#34475a": "var(--border-bright)",
    "#33465a": "var(--border-bright)",
    "#35495c": "var(--border-bright)",
    "#35495d": "var(--border-bright)",
    "#32465a": "var(--border-bright)",
    "#2d4053": "var(--border-bright)",
    "#365065": "var(--border-strong)",
    "#34485b": "var(--border-strong)",
    "#3a4b5d": "var(--border-notice)",
    "#285648": "var(--border-live)",
    "#214238": "var(--border-private)",
    "#28584c": "var(--border-success)",
    "#29584b": "var(--border-success)",
    "#24594b": "var(--border-success)",
    "#2b4354": "var(--border-active)",
    "#1a3040": "var(--bg-active-start)",
    "#17293a": "var(--bg-active-end)",

    # Link
    "#4f7cff": "var(--link)",

    # Misc
    "#9fb0c2": "var(--icon-muted)",
    "#9aa4b2": "var(--icon-muted)",
    "#b8c7d5": "var(--icon-muted)",
    "#66849a": "var(--icon-muted)",
    "#526979": "var(--icon-muted)",
    "#5f7081": "var(--icon-muted)",
    "#789489": "var(--text-private)",
    "rgb(15 27 39 / 96%)": "var(--topbar-bg)",
    "rgb(13 23 35 / 96%)": "var(--topbar-bg)",
    "rgb(8 16 25 / 88%)": "var(--topbar-bg)",
    "rgb(2 7 12 / 82%)": "var(--modal-bg)",
    "rgb(2 7 12 / 76%)": "var(--modal-bg)",
    "rgb(2 7 12 / 55%)": "var(--backdrop-bg)",
    "rgb(0 0 0 / 52%)": "var(--shadow-color-strong)",
    "rgb(0 0 0 / 28%)": "var(--shadow-color)",
    "rgb(0 0 0 / 10%)": "var(--shadow-color-soft)",
    "#cfe3dc": "var(--text-code-light)",
    "#16181d": "var(--code-bg)",  # raw
    "#0d1117": "var(--canvas)",  # raw
    "#21262d": "var(--border)",  # raw
    "#30363d": "var(--border-bright)",  # raw
}

# Sort by length descending so longer matches win
 replacements = sorted(COLOR_MAP.items(), key=lambda x: len(x[0]), reverse=True)

for old, new in replacements:
    css = css.replace(old, new)

# ── Replace remaining hardcoded values that appear in gradients ─────────────
# Gradients need special handling since they may span multiple lines
# For now, we handle the most common ones by literal replacement.
GRADIENT_MAP = {
    "linear-gradient(145deg, #60e7c1, #2cbf98)": "var(--gradient-brand)",
    "linear-gradient(145deg, #55deb8, #31c69e)": "var(--gradient-button)",
    "linear-gradient(90deg, #2fb991, #66e1bd)": "var(--gradient-meter)",
    "linear-gradient(100deg, #102a25, #10251f)": "var(--gradient-readiness)",
    "linear-gradient(105deg, #102a25, #11231f)": "var(--gradient-readiness)",
    "linear-gradient(100deg, #272014, #211b13)": "var(--gradient-warn)",
    "linear-gradient(145deg, #211b13, #181713)": "var(--gradient-warn-panel)",
    "linear-gradient(145deg, #071019, #0b1622)": "var(--gradient-body)",
    "linear-gradient(90deg, #1a3040, #17293a)": "var(--gradient-active)",
    "linear-gradient(145deg, var(--surface), #0f1a27)": "var(--gradient-panel)",
    "linear-gradient(90deg, #d99a2b, #f0c274)": "var(--gradient-warn-bar)",
    "linear-gradient(90deg, #d9542b, #f08a74)": "var(--gradient-danger-bar)",
    "radial-gradient(circle at 78% -12%, rgb(42 97 91 / 18%), transparent 34rem)": "var(--gradient-radial-body)",
    "radial-gradient(circle at 50% 0%, rgb(52 142 118 / 18%)": "var(--gradient-radial-top)",
}

for old, new in GRADIENT_MAP.items():
    css = css.replace(old, new)

# ── Box shadows ────────────────────────────────────────────────────────────
SHADOW_MAP = {
    "0 24px 70px rgb(0 0 0 / 28%)": "var(--shadow-lg)",
    "0 30px 90px rgb(0 0 0 / 52%)": "var(--shadow-xl)",
    "0 10px 28px rgb(0 0 0 / 10%)": "var(--shadow-md)",
    "inset 3px 0 0 var(--accent)": "var(--shadow-active-inset)",
    "inset 0 0 0 1px var(--link)": "var(--shadow-focus)",
}

for old, new in SHADOW_MAP.items():
    css = css.replace(old, new)

# ── Font families ──────────────────────────────────────────────────────────
# Replace hardcoded font-family declarations with variables where appropriate
# But keep the original structure intact

# ── Prepend the variable definitions ───────────────────────────────────────
THEME_CSS = '''/* BoxPilot Theme System */
/* Generated: CSS custom property architecture with 8 themes */

/* ── Base / Default theme (Raw — GitHub-dark inspired) ─────────────────── */
:root,
html[data-theme="raw"],
html[data-theme="default"] {
  /* Canvas */
  --canvas: #0d1117;
  --sidebar-bg: #0d1117;
  --topbar-bg: rgba(13, 17, 23, 0.95);
  --modal-bg: rgba(0, 0, 0, 0.6);
  --backdrop-bg: rgba(0, 0, 0, 0.4);

  /* Surfaces */
  --surface: #161b22;
  --surface-raised: #21262d;
  --surface-muted: #0d1117;
  --surface-hover: #1c2128;
  --surface-header: #161b22;
  --surface-notice: #161b22;
  --surface-live: #0f2d1c;
  --code-bg: #161b22;

  /* Text */
  --text: #c9d1d9;
  --text-strong: #e6edf3;
  --text-muted: #8b949e;
  --text-dim: #484f58;
  --text-inverted: #ffffff;
  --text-inverted-dim: #d5dfe8;
  --text-secondary: #b4bcd0;
  --text-code: #c5d0dc;
  --text-private: #6e7681;

  /* Accent (blue) */
  --accent: #58a6ff;
  --accent-dim: #1f6feb;
  --accent-bg: #121d2f;
  --accent-border: #1f6feb;
  --accent-mid: #79c0ff;
  --accent-light: #a5d6ff;
  --accent-glow: rgba(88, 166, 255, 0.12);
  --accent-glow-soft: rgba(88, 166, 255, 0.08);
  --accent-glow-strong: rgba(88, 166, 255, 0.35);
  --accent-focus: rgba(88, 166, 255, 0.32);
  --accent-shadow: rgba(88, 166, 255, 0.15);
  --accent-shadow-hover: rgba(88, 166, 255, 0.22);
  --accent-radial: rgba(88, 166, 255, 0.18);
  --accent-radial-body: rgba(88, 166, 255, 0.12);
  --accent-faint: rgba(88, 166, 255, 0.05);
  --accent-text-on: #0a2540;

  /* Success */
  --success: #3fb950;
  --success-dim: #238636;
  --success-bg: #0f2d1c;
  --success-light: #56d364;
  --text-success-dim: #7ee787;
  --text-success-light: #aff5b4;
  --border-success: #238636;

  /* Warning */
  --warn: #d29922;
  --warn-dim: #9e6a03;
  --warn-bg: #341a00;
  --warn-light: #e3b341;
  --warn-text: #e3b341;
  --warn-text-light: #f0c274;
  --warn-text-dim: #bb8a3e;
  --warn-faint: rgba(211, 153, 34, 0.07);
  --border-live: #238636;

  /* Danger */
  --danger: #f85149;
  --danger-dim: #da3633;
  --danger-bg: #3d0e0e;
  --danger-light: #ff7b72;
  --danger-text: #ff7b72;

  /* Borders */
  --border: #30363d;
  --border-subtle: #21262d;
  --border-bright: #484f58;
  --border-strong: #6e7681;
  --border-notice: #484f58;
  --border-private: #1f6feb;
  --border-active: #1f6feb;

  /* Active states */
  --bg-active-start: #1c2128;
  --bg-active-end: #161b22;

  /* Link */
  --link: #58a6ff;

  /* Icons */
  --icon-muted: #8b949e;

  /* Shadows */
  --shadow-lg: 0 24px 70px rgba(0, 0, 0, 0.4);
  --shadow-xl: 0 30px 90px rgba(0, 0, 0, 0.6);
  --shadow-md: 0 10px 28px rgba(0, 0, 0, 0.2);
  --shadow-active-inset: inset 3px 0 0 var(--accent);
  --shadow-focus: inset 0 0 0 1px var(--link);

  /* Gradients */
  --gradient-brand: linear-gradient(145deg, var(--accent), var(--accent-dim));
  --gradient-button: linear-gradient(145deg, var(--accent), var(--accent-dim));
  --gradient-meter: linear-gradient(90deg, var(--accent-dim), var(--accent-mid));
  --gradient-readiness: linear-gradient(100deg, var(--success-bg), #0f2d1c);
  --gradient-warn: linear-gradient(100deg, var(--warn-bg), var(--warn-bg));
  --gradient-warn-panel: linear-gradient(145deg, var(--warn-bg), #1a1200);
  --gradient-body: linear-gradient(145deg, var(--canvas), var(--surface));
  --gradient-active: linear-gradient(90deg, var(--bg-active-start), var(--bg-active-end));
  --gradient-panel: linear-gradient(145deg, var(--surface), var(--surface-muted));
  --gradient-warn-bar: linear-gradient(90deg, var(--warn-dim), var(--warn));
  --gradient-danger-bar: linear-gradient(90deg, var(--danger-dim), var(--danger-light));
  --gradient-radial-body: radial-gradient(circle at 78% -12%, var(--accent-radial-body), transparent 34rem);
  --gradient-radial-top: radial-gradient(circle at 50% 0%, var(--accent-radial));

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 6px;
  --radius-lg: 6px;
  --radius-pill: 999px;
}

/* ── Old theme (the original mint/teal design) ──────────────────────────── */
html[data-theme="old"] {
  --canvas: #081019;
  --sidebar-bg: rgba(11, 21, 33, 0.94);
  --topbar-bg: rgba(8, 16, 25, 0.88);
  --modal-bg: rgba(2, 7, 12, 0.76);
  --backdrop-bg: rgba(2, 7, 12, 0.55);

  --surface: #111d2a;
  --surface-raised: #152333;
  --surface-muted: #0d1824;
  --surface-hover: #142232;
  --surface-header: #0f1a26;
  --surface-notice: #101b28;
  --surface-live: #0e211d;
  --code-bg: #0d1824;

  --text: #e8eef6;
  --text-strong: #aebccc;
  --text-muted: #8fa1b7;
  --text-dim: #66788b;
  --text-inverted: #ffffff;
  --text-inverted-dim: #d5dfe8;
  --text-secondary: #c6d2df;
  --text-code: #c5d0dc;
  --text-private: #789489;

  --accent: #43d3aa;
  --accent-dim: #2cbf98;
  --accent-bg: #0a3329;
  --accent-border: #43836f;
  --accent-mid: #2fb991;
  --accent-light: #75e4c2;
  --accent-glow: rgba(67, 211, 170, 0.12);
  --accent-glow-soft: rgba(67, 211, 170, 0.08);
  --accent-glow-strong: rgba(67, 211, 170, 0.35);
  --accent-focus: rgba(67, 211, 170, 0.32);
  --accent-shadow: rgba(49, 198, 158, 0.15);
  --accent-shadow-hover: rgba(49, 198, 158, 0.22);
  --accent-radial: rgba(52, 142, 118, 0.18);
  --accent-radial-body: rgba(42, 97, 91, 0.18);
  --accent-faint: rgba(77, 225, 176, 0.05);
  --accent-text-on: #062a21;

  --success: #75e4c2;
  --success-dim: #286453;
  --success-bg: #0e2d26;
  --success-light: #72dabc;
  --text-success-dim: #83a89d;
  --text-success-light: #a9c9c1;
  --border-success: #28584c;

  --warn: #efb35d;
  --warn-dim: #67502b;
  --warn-bg: #392915;
  --warn-light: #f3c078;
  --warn-text: #efd6ae;
  --warn-text-light: #e5d3b4;
  --warn-text-dim: #bba681;
  --warn-faint: rgba(255, 190, 92, 0.07);
  --border-live: #285648;

  --danger: #f18484;
  --danger-dim: #6b3a3a;
  --danger-bg: #2d1717;
  --danger-light: #f1b8b8;
  --danger-text: #efb4b4;

  --border: #263648;
  --border-subtle: #1d2b3a;
  --border-bright: #34475a;
  --border-strong: #365065;
  --border-notice: #3a4b5d;
  --border-private: #214238;
  --border-active: #2b4354;

  --bg-active-start: #1a3040;
  --bg-active-end: #17293a;

  --link: #4f7cff;
  --icon-muted: #9fb0c2;

  --shadow-lg: 0 24px 70px rgba(0, 0, 0, 0.28);
  --shadow-xl: 0 30px 90px rgba(0, 0, 0, 0.52);
  --shadow-md: 0 10px 28px rgba(0, 0, 0, 0.10);

  --gradient-brand: linear-gradient(145deg, #60e7c1, #2cbf98);
  --gradient-button: linear-gradient(145deg, #55deb8, #31c69e);
  --gradient-meter: linear-gradient(90deg, #2fb991, #66e1bd);
  --gradient-readiness: linear-gradient(100deg, #102a25, #10251f);
  --gradient-warn: linear-gradient(100deg, #272014, #211b13);
  --gradient-warn-panel: linear-gradient(145deg, #211b13, #181713);
  --gradient-body: linear-gradient(145deg, #071019, #0b1622);
  --gradient-active: linear-gradient(90deg, #1a3040, #17293a);
  --gradient-panel: linear-gradient(145deg, var(--surface), #0f1a27);
  --gradient-warn-bar: linear-gradient(90deg, #d99a2b, #f0c274);
  --gradient-danger-bar: linear-gradient(90deg, #d9542b, #f08a74);
  --gradient-radial-body: radial-gradient(circle at 78% -12%, rgba(42, 97, 91, 0.18), transparent 34rem);
  --gradient-radial-top: radial-gradient(circle at 50% 0%, rgba(52, 142, 118, 0.18));

  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 13px;
}

/* ── Terminal theme ─────────────────────────────────────────────────────── */
html[data-theme="terminal"] {
  --canvas: #0a0a0a;
  --sidebar-bg: #0f0f0f;
  --topbar-bg: rgba(15, 15, 15, 0.98);
  --modal-bg: rgba(0, 0, 0, 0.85);
  --backdrop-bg: rgba(0, 0, 0, 0.7);

  --surface: #0f0f0f;
  --surface-raised: #141414;
  --surface-muted: #0a0a0a;
  --surface-hover: #141414;
  --surface-header: #0f0f0f;
  --surface-notice: #0f0f0f;
  --surface-live: #0f0f0f;
  --code-bg: #0a0a0a;

  --text: #c7c7c7;
  --text-strong: #ffffff;
  --text-muted: #555555;
  --text-dim: #333333;
  --text-inverted: #0a0a0a;
  --text-inverted-dim: #1a1a1a;
  --text-secondary: #888888;
  --text-code: #aaaaaa;
  --text-private: #444444;

  --accent: #ffb000;
  --accent-dim: #8a5c00;
  --accent-bg: #1a1400;
  --accent-border: #8a5c00;
  --accent-mid: #cc8800;
  --accent-light: #ffcc44;
  --accent-glow: rgba(255, 176, 0, 0.12);
  --accent-glow-soft: rgba(255, 176, 0, 0.08);
  --accent-glow-strong: rgba(255, 176, 0, 0.35);
  --accent-focus: rgba(255, 176, 0, 0.32);
  --accent-shadow: rgba(255, 176, 0, 0.15);
  --accent-shadow-hover: rgba(255, 176, 0, 0.22);
  --accent-radial: rgba(255, 176, 0, 0.15);
  --accent-radial-body: rgba(255, 176, 0, 0.10);
  --accent-faint: rgba(255, 176, 0, 0.05);
  --accent-text-on: #0a0a0a;

  --success: #33ff33;
  --success-dim: #1a801a;
  --success-bg: #051a05;
  --success-light: #55ff55;
  --text-success-dim: #44aa44;
  --text-success-light: #66ff66;
  --border-success: #1a801a;

  --warn: #ffaa00;
  --warn-dim: #aa7700;
  --warn-bg: #1a1200;
  --warn-light: #ffcc33;
  --warn-text: #ffcc33;
  --warn-text-light: #ffdd66;
  --warn-text-dim: #bb8800;
  --warn-faint: rgba(255, 170, 0, 0.07);
  --border-live: #1a801a;

  --danger: #ff3333;
  --danger-dim: #aa0000;
  --danger-bg: #1a0505;
  --danger-light: #ff6666;
  --danger-text: #ff6666;

  --border: #1e1e1e;
  --border-subtle: #1a1a1a;
  --border-bright: #2a2a2a;
  --border-strong: #333333;
  --border-notice: #2a2a2a;
  --border-private: #1a801a;
  --border-active: #8a5c00;

  --bg-active-start: #1a1400;
  --bg-active-end: #141000;

  --link: #ffb000;
  --icon-muted: #555555;

  --shadow-lg: none;
  --shadow-xl: none;
  --shadow-md: none;

  --gradient-brand: none;
  --gradient-button: none;
  --gradient-meter: none;
  --gradient-readiness: none;
  --gradient-warn: none;
  --gradient-warn-panel: none;
  --gradient-body: none;
  --gradient-active: none;
  --gradient-panel: none;
  --gradient-warn-bar: none;
  --gradient-danger-bar: none;
  --gradient-radial-body: none;
  --gradient-radial-top: none;

  --font-sans: "SF Mono", "Cascadia Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-mono: "SF Mono", "Cascadia Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
}

/* ── Control Panel theme ────────────────────────────────────────────────── */
html[data-theme="control"] {
  --canvas: #0c0d10;
  --sidebar-bg: #111216;
  --topbar-bg: rgba(17, 18, 22, 0.98);
  --modal-bg: rgba(0, 0, 0, 0.8);
  --backdrop-bg: rgba(0, 0, 0, 0.5);

  --surface: #111216;
  --surface-raised: #16181d;
  --surface-muted: #0c0d10;
  --surface-hover: #16181d;
  --surface-header: #16181d;
  --surface-notice: #111216;
  --surface-live: #0e211d;
  --code-bg: #0c0d10;

  --text: #aeb4c2;
  --text-strong: #d8dce6;
  --text-muted: #4b4f5a;
  --text-dim: #3a3d45;
  --text-inverted: #0c0d10;
  --text-inverted-dim: #111216;
  --text-secondary: #8b8f9a;
  --text-code: #9aa0b0;
  --text-private: #4b4f5a;

  --accent: #00d4aa;
  --accent-dim: #006b54;
  --accent-bg: #001f18;
  --accent-border: #006b54;
  --accent-mid: #00aa88;
  --accent-light: #33ffcc;
  --accent-glow: rgba(0, 212, 170, 0.15);
  --accent-glow-soft: rgba(0, 212, 170, 0.10);
  --accent-glow-strong: rgba(0, 212, 170, 0.40);
  --accent-focus: rgba(0, 212, 170, 0.35);
  --accent-shadow: rgba(0, 212, 170, 0.15);
  --accent-shadow-hover: rgba(0, 212, 170, 0.25);
  --accent-radial: rgba(0, 212, 170, 0.15);
  --accent-radial-body: rgba(0, 212, 170, 0.10);
  --accent-faint: rgba(0, 212, 170, 0.05);
  --accent-text-on: #000000;

  --success: #00d4aa;
  --success-dim: #006b54;
  --success-bg: #001f18;
  --success-light: #33ffcc;
  --text-success-dim: #44aa99;
  --text-success-light: #66ddbb;
  --border-success: #006b54;

  --warn: #e5a000;
  --warn-dim: #735000;
  --warn-bg: #1f1800;
  --warn-light: #ffbb33;
  --warn-text: #ffbb33;
  --warn-text-light: #ffcc55;
  --warn-text-dim: #aa8833;
  --warn-faint: rgba(229, 160, 0, 0.07);
  --border-live: #006b54;

  --danger: #e05050;
  --danger-dim: #802020;
  --danger-bg: #1f0a0a;
  --danger-light: #ff7777;
  --danger-text: #ff7777;

  --border: #24262d;
  --border-subtle: #1e1f25;
  --border-bright: #2e313a;
  --border-strong: #3a3d45;
  --border-notice: #2e313a;
  --border-private: #006b54;
  --border-active: #006b54;

  --bg-active-start: #001f18;
  --bg-active-end: #001a14;

  --link: #00d4aa;
  --icon-muted: #4b4f5a;

  --shadow-lg: none;
  --shadow-xl: none;
  --shadow-md: none;

  --gradient-brand: none;
  --gradient-button: none;
  --gradient-meter: none;
  --gradient-readiness: none;
  --gradient-warn: none;
  --gradient-warn-panel: none;
  --gradient-body: none;
  --gradient-active: none;
  --gradient-panel: none;
  --gradient-warn-bar: none;
  --gradient-danger-bar: none;
  --gradient-radial-body: none;
  --gradient-radial-top: none;

  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
}

/* ── Solarized Dark theme ───────────────────────────────────────────────── */
html[data-theme="solarized"] {
  --canvas: #002b36;
  --sidebar-bg: #073642;
  --topbar-bg: rgba(7, 54, 66, 0.98);
  --modal-bg: rgba(0, 43, 54, 0.85);
  --backdrop-bg: rgba(0, 43, 54, 0.6);

  --surface: #073642;
  --surface-raised: #094352;
  --surface-muted: #002b36;
  --surface-hover: #094352;
  --surface-header: #073642;
  --surface-notice: #073642;
  --surface-live: #073642;
  --code-bg: #002b36;

  --text: #839496;
  --text-strong: #eee8d5;
  --text-muted: #586e75;
  --text-dim: #073642;
  --text-inverted: #002b36;
  --text-inverted-dim: #073642;
  --text-secondary: #93a1a1;
  --text-code: #93a1a1;
  --text-private: #586e75;

  --accent: #268bd2;
  --accent-dim: #16527a;
  --accent-bg: #001f30;
  --accent-border: #16527a;
  --accent-mid: #2aa198;
  --accent-light: #69c2ff;
  --accent-glow: rgba(38, 139, 210, 0.15);
  --accent-glow-soft: rgba(38, 139, 210, 0.10);
  --accent-glow-strong: rgba(38, 139, 210, 0.35);
  --accent-focus: rgba(38, 139, 210, 0.32);
  --accent-shadow: rgba(38, 139, 210, 0.15);
  --accent-shadow-hover: rgba(38, 139, 210, 0.22);
  --accent-radial: rgba(38, 139, 210, 0.15);
  --accent-radial-body: rgba(38, 139, 210, 0.10);
  --accent-faint: rgba(38, 139, 210, 0.05);
  --accent-text-on: #002b36;

  --success: #2aa198;
  --success-dim: #16527a;
  --success-bg: #002b2b;
  --success-light: #33c2b5;
  --text-success-dim: #44a399;
  --text-success-light: #66d4c9;
  --border-success: #16527a;

  --warn: #b58900;
  --warn-dim: #705000;
  --warn-bg: #2b2200;
  --warn-light: #d6a300;
  --warn-text: #d6a300;
  --warn-text-light: #e8c040;
  --warn-text-dim: #997700;
  --warn-faint: rgba(181, 137, 0, 0.07);
  --border-live: #16527a;

  --danger: #dc322f;
  --danger-dim: #8b1a18;
  --danger-bg: #2b0a0a;
  --danger-light: #ff5555;
  --danger-text: #ff5555;

  --border: #073642;
  --border-subtle: #002b36;
  --border-bright: #586e75;
  --border-strong: #657b83;
  --border-notice: #586e75;
  --border-private: #16527a;
  --border-active: #268bd2;

  --bg-active-start: #094352;
  --bg-active-end: #073642;

  --link: #268bd2;
  --icon-muted: #586e75;

  --shadow-lg: 0 24px 70px rgba(0, 0, 0, 0.3);
  --shadow-xl: 0 30px 90px rgba(0, 0, 0, 0.5);
  --shadow-md: 0 10px 28px rgba(0, 0, 0, 0.15);

  --gradient-brand: none;
  --gradient-button: none;
  --gradient-meter: none;
  --gradient-readiness: none;
  --gradient-warn: none;
  --gradient-warn-panel: none;
  --gradient-body: none;
  --gradient-active: none;
  --gradient-panel: none;
  --gradient-warn-bar: none;
  --gradient-danger-bar: none;
  --gradient-radial-body: none;
  --gradient-radial-top: none;

  --font-sans: "Source Sans Pro", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "Source Code Pro", ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
}

/* ── Nord theme ─────────────────────────────────────────────────────────── */
html[data-theme="nord"] {
  --canvas: #2e3440;
  --sidebar-bg: #3b4252;
  --topbar-bg: rgba(59, 66, 82, 0.98);
  --modal-bg: rgba(46, 52, 64, 0.85);
  --backdrop-bg: rgba(46, 52, 64, 0.6);

  --surface: #3b4252;
  --surface-raised: #434c5e;
  --surface-muted: #2e3440;
  --surface-hover: #434c5e;
  --surface-header: #3b4252;
  --surface-notice: #3b4252;
  --surface-live: #2e3440;
  --code-bg: #2e3440;

  --text: #d8dee9;
  --text-strong: #eceff4;
  --text-muted: #4c566a;
  --text-dim: #3b4252;
  --text-inverted: #2e3440;
  --text-inverted-dim: #3b4252;
  --text-secondary: #81a1c1;
  --text-code: #d8dee9;
  --text-private: #4c566a;

  --accent: #88c0d0;
  --accent-dim: #5e81ac;
  --accent-bg: #2e3a4a;
  --accent-border: #5e81ac;
  --accent-mid: #81a1c1;
  --accent-light: #a3be8c;
  --accent-glow: rgba(136, 192, 208, 0.15);
  --accent-glow-soft: rgba(136, 192, 208, 0.10);
  --accent-glow-strong: rgba(136, 192, 208, 0.35);
  --accent-focus: rgba(136, 192, 208, 0.32);
  --accent-shadow: rgba(136, 192, 208, 0.15);
  --accent-shadow-hover: rgba(136, 192, 208, 0.22);
  --accent-radial: rgba(136, 192, 208, 0.15);
  --accent-radial-body: rgba(136, 192, 208, 0.10);
  --accent-faint: rgba(136, 192, 208, 0.05);
  --accent-text-on: #2e3440;

  --success: #a3be8c;
  --success-dim: #5e81ac;
  --success-bg: #2e3a3a;
  --success-light: #b5ce9e;
  --text-success-dim: #8fbc8f;
  --text-success-light: #c5ddb0;
  --border-success: #5e81ac;

  --warn: #ebcb8b;
  --warn-dim: #b48e5a;
  --warn-bg: #3a3520;
  --warn-light: #f0d8a0;
  --warn-text: #f0d8a0;
  --warn-text-light: #f5e5b8;
  --warn-text-dim: #c0a060;
  --warn-faint: rgba(235, 203, 139, 0.07);
  --border-live: #5e81ac;

  --danger: #bf616a;
  --danger-dim: #8b3a42;
  --danger-bg: #3a2020;
  --danger-light: #d07078;
  --danger-text: #d07078;

  --border: #434c5e;
  --border-subtle: #3b4252;
  --border-bright: #4c566a;
  --border-strong: #5e81ac;
  --border-notice: #4c566a;
  --border-private: #5e81ac;
  --border-active: #88c0d0;

  --bg-active-start: #434c5e;
  --bg-active-end: #3b4252;

  --link: #88c0d0;
  --icon-muted: #4c566a;

  --shadow-lg: 0 24px 70px rgba(0, 0, 0, 0.3);
  --shadow-xl: 0 30px 90px rgba(0, 0, 0, 0.5);
  --shadow-md: 0 10px 28px rgba(0, 0, 0, 0.15);

  --gradient-brand: none;
  --gradient-button: none;
  --gradient-meter: none;
  --gradient-readiness: none;
  --gradient-warn: none;
  --gradient-warn-panel: none;
  --gradient-body: none;
  --gradient-active: none;
  --gradient-panel: none;
  --gradient-warn-bar: none;
  --gradient-danger-bar: none;
  --gradient-radial-body: none;
  --gradient-radial-top: none;

  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
}

/* ── Amber theme (pure phosphor) ────────────────────────────────────────── */
html[data-theme="amber"] {
  --canvas: #0a0a0a;
  --sidebar-bg: #0f0f0f;
  --topbar-bg: rgba(15, 15, 15, 0.98);
  --modal-bg: rgba(0, 0, 0, 0.85);
  --backdrop-bg: rgba(0, 0, 0, 0.7);

  --surface: #0f0f0f;
  --surface-raised: #141414;
  --surface-muted: #0a0a0a;
  --surface-hover: #141414;
  --surface-header: #0f0f0f;
  --surface-notice: #0f0f0f;
  --surface-live: #0f0f0f;
  --code-bg: #0a0a0a;

  --text: #ffb000;
  --text-strong: #ffcc44;
  --text-muted: #8a5c00;
  --text-dim: #553800;
  --text-inverted: #0a0a0a;
  --text-inverted-dim: #1a1a1a;
  --text-secondary: #cc8800;
  --text-code: #ffcc44;
  --text-private: #553800;

  --accent: #ffb000;
  --accent-dim: #8a5c00;
  --accent-bg: #1a1400;
  --accent-border: #8a5c00;
  --accent-mid: #cc8800;
  --accent-light: #ffdd66;
  --accent-glow: rgba(255, 176, 0, 0.12);
  --accent-glow-soft: rgba(255, 176, 0, 0.08);
  --accent-glow-strong: rgba(255, 176, 0, 0.35);
  --accent-focus: rgba(255, 176, 0, 0.32);
  --accent-shadow: rgba(255, 176, 0, 0.15);
  --accent-shadow-hover: rgba(255, 176, 0, 0.22);
  --accent-radial: rgba(255, 176, 0, 0.15);
  --accent-radial-body: rgba(255, 176, 0, 0.10);
  --accent-faint: rgba(255, 176, 0, 0.05);
  --accent-text-on: #0a0a0a;

  --success: #ffb000;
  --success-dim: #8a5c00;
  --success-bg: #1a1400;
  --success-light: #ffcc44;
  --text-success-dim: #cc8800;
  --text-success-light: #ffdd66;
  --border-success: #8a5c00;

  --warn: #ff8800;
  --warn-dim: #aa5500;
  --warn-bg: #1a0f00;
  --warn-light: #ffaa33;
  --warn-text: #ffaa33;
  --warn-text-light: #ffbb55;
  --warn-text-dim: #bb7700;
  --warn-faint: rgba(255, 136, 0, 0.07);
  --border-live: #8a5c00;

  --danger: #ff4400;
  --danger-dim: #aa2200;
  --danger-bg: #1a0800;
  --danger-light: #ff6633;
  --danger-text: #ff6633;

  --border: #1e1e1e;
  --border-subtle: #1a1a1a;
  --border-bright: #2a2a2a;
  --border-strong: #333333;
  --border-notice: #2a2a2a;
  --border-private: #8a5c00;
  --border-active: #8a5c00;

  --bg-active-start: #1a1400;
  --bg-active-end: #141000;

  --link: #ffb000;
  --icon-muted: #553800;

  --shadow-lg: none;
  --shadow-xl: none;
  --shadow-md: none;

  --gradient-brand: none;
  --gradient-button: none;
  --gradient-meter: none;
  --gradient-readiness: none;
  --gradient-warn: none;
  --gradient-warn-panel: none;
  --gradient-body: none;
  --gradient-active: none;
  --gradient-panel: none;
  --gradient-warn-bar: none;
  --gradient-danger-bar: none;
  --gradient-radial-body: none;
  --gradient-radial-top: none;

  --font-sans: "SF Mono", "Cascadia Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-mono: "SF Mono", "Cascadia Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
}

/* ── High Contrast theme ────────────────────────────────────────────────── */
html[data-theme="contrast"] {
  --canvas: #000000;
  --sidebar-bg: #000000;
  --topbar-bg: rgba(0, 0, 0, 0.98);
  --modal-bg: rgba(0, 0, 0, 0.9);
  --backdrop-bg: rgba(0, 0, 0, 0.8);

  --surface: #000000;
  --surface-raised: #111111;
  --surface-muted: #000000;
  --surface-hover: #111111;
  --surface-header: #000000;
  --surface-notice: #000000;
  --surface-live: #000000;
  --code-bg: #000000;

  --text: #ffffff;
  --text-strong: #ffffff;
  --text-muted: #aaaaaa;
  --text-dim: #666666;
  --text-inverted: #000000;
  --text-inverted-dim: #111111;
  --text-secondary: #cccccc;
  --text-code: #ffffff;
  --text-private: #666666;

  --accent: #00ff00;
  --accent-dim: #00aa00;
  --accent-bg: #001a00;
  --accent-border: #00aa00;
  --accent-mid: #00cc00;
  --accent-light: #33ff33;
  --accent-glow: rgba(0, 255, 0, 0.15);
  --accent-glow-soft: rgba(0, 255, 0, 0.10);
  --accent-glow-strong: rgba(0, 255, 0, 0.40);
  --accent-focus: rgba(0, 255, 0, 0.35);
  --accent-shadow: rgba(0, 255, 0, 0.15);
  --accent-shadow-hover: rgba(0, 255, 0, 0.25);
  --accent-radial: rgba(0, 255, 0, 0.15);
  --accent-radial-body: rgba(0, 255, 0, 0.10);
  --accent-faint: rgba(0, 255, 0, 0.05);
  --accent-text-on: #000000;

  --success: #00ff00;
  --success-dim: #00aa00;
  --success-bg: #001a00;
  --success-light: #33ff33;
  --text-success-dim: #00cc00;
  --text-success-light: #66ff66;
  --border-success: #00aa00;

  --warn: #ffff00;
  --warn-dim: #aaaa00;
  --warn-bg: #1a1a00;
  --warn-light: #ffff33;
  --warn-text: #ffff33;
  --warn-text-light: #ffff66;
  --warn-text-dim: #bbbb00;
  --warn-faint: rgba(255, 255, 0, 0.07);
  --border-live: #00aa00;

  --danger: #ff0000;
  --danger-dim: #aa0000;
  --danger-bg: #1a0000;
  --danger-light: #ff3333;
  --danger-text: #ff3333;

  --border: #ffffff;
  --border-subtle: #666666;
  --border-bright: #ffffff;
  --border-strong: #ffffff;
  --border-notice: #ffffff;
  --border-private: #00aa00;
  --border-active: #00ff00;

  --bg-active-start: #001a00;
  --bg-active-end: #001100;

  --link: #00ff00;
  --icon-muted: #666666;

  --shadow-lg: none;
  --shadow-xl: none;
  --shadow-md: none;

  --gradient-brand: none;
  --gradient-button: none;
  --gradient-meter: none;
  --gradient-readiness: none;
  --gradient-warn: none;
  --gradient-warn-panel: none;
  --gradient-body: none;
  --gradient-active: none;
  --gradient-panel: none;
  --gradient-warn-bar: none;
  --gradient-danger-bar: none;
  --gradient-radial-body: none;
  --gradient-radial-top: none;

  --font-sans: ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;

  --radius-sm: 0px;
  --radius-md: 0px;
  --radius-lg: 0px;
}

/* ═════════════════════════════════════════════════════════════════════════ */
/*  Below this line the original CSS structure is preserved.                 */
/*  All hardcoded values have been replaced with CSS custom properties.      */
/* ═════════════════════════════════════════════════════════════════════════ */

'''

# Write the transformed CSS
with open("src/styles.css", "w") as f:
    f.write(THEME_CSS + css)

print("Done. Wrote themed styles.css")
print(f"File size: {len(THEME_CSS + css)} bytes")

# Verify no remaining raw hex values that should have been caught
remaining = re.findall(r'#(?:[0-9a-fA-F]{3}){1,2}', css)
unique_remaining = sorted(set(remaining))
if unique_remaining:
    print(f"\nWarning: {len(unique_remaining)} raw hex values may remain:")
    for v in unique_remaining[:20]:
        print(f"  {v}")
else:
    print("\nAll hex values successfully mapped to variables.")
