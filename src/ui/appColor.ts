/**
 * An app's colour on Home (M33.7): the square its glyph sits on, as in the study's Launcher. The
 * catalog's manifests carry an emoji and no colour, and giving 170 manifests a field for this is
 * not worth it, so the colour is chosen here: a curated palette of deep hues, each holding a white
 * glyph at 3:1 or better (scripts/check-contrast.mjs checks every one), never a muddy mix. A few
 * well-known apps get the hue people know them by; every other app gets one from its id, the same
 * one on every visit, on every server. The values are tokens in src/styles.css (--brand-<hue>-a
 * and -b); this only picks the name.
 */
export const APP_HUES = [
  "violet", "indigo", "blue", "sky", "cyan", "teal", "green", "olive",
  "amber", "orange", "red", "pink", "plum", "slate", "graphite",
] as const;

export type AppHue = (typeof APP_HUES)[number];

/** Apps whose own colour is well known, by catalog id. */
const known: Record<string, AppHue> = {
  "adguard-home": "green",
  audiobookshelf: "amber",
  bazarr: "slate",
  "calibre-web": "indigo",
  "code-server": "blue",
  emby: "green",
  forgejo: "orange",
  frigate: "indigo",
  grafana: "orange",
  "home-assistant": "sky",
  homepage: "slate",
  immich: "indigo",
  jellyfin: "violet",
  jellyseerr: "indigo",
  lidarr: "green",
  llmcoach: "teal",
  mealie: "orange",
  n8n: "pink",
  navidrome: "indigo",
  nextcloud: "sky",
  "node-red": "red",
  ntfy: "teal",
  ollama: "graphite",
  "open-webui": "graphite",
  "paperless-ngx": "green",
  photoprism: "violet",
  "pi-hole": "red",
  plex: "amber",
  portainer: "cyan",
  prometheus: "orange",
  prowlarr: "amber",
  qbittorrent: "cyan",
  radarr: "amber",
  scrutiny: "plum",
  sonarr: "sky",
  syncthing: "cyan",
  transmission: "red",
  "uptime-kuma": "green",
  vaultwarden: "blue",
  "wg-easy": "red",
  zigbee2mqtt: "amber",
};

/** FNV-1a over the id's UTF-16 code units: small, stable, and spreads similar ids apart. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** The hue for an app, by its catalog id: its known colour, or one picked from the id. */
export function appHue(id: string): AppHue {
  const key = id.trim().toLowerCase();
  return known[key] ?? APP_HUES[hash(key) % APP_HUES.length];
}

/** The hues with a known app, for the tests. */
export const knownAppHues: Readonly<Record<string, AppHue>> = known;
