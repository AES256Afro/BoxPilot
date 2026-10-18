import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpaceOverTime, topGrowers } from "./SpaceOverTime";
import type { Usage } from "./types";

afterEach(cleanup);
const GiB = 1024 ** 3;
const series = (start: number, end: number, days = 29) => Array.from({ length: days + 1 }, (_value, index) => ({ at: new Date(Date.parse("2026-09-19T03:00:00Z") + index * 86_400_000).toISOString(), bytes: Math.round((start + ((end - start) * index) / days) * GiB) }));
const usage = (appId: string, path: string, start: number, end: number, extra: Partial<Usage> = {}): Usage => ({ appId, path, mount: "/", bytes: end * GiB, grewBytes: null, days: 7, series: series(start, end), ...extra });

describe("where the space went (M31.4)", () => {
  it("lists the folders that grew most over their recorded days, a shared folder once, shrinking ones left out", () => {
    const rows = topGrowers([
      usage("jellyfin", "/srv/media", 2170, 2180),
      usage("qbittorrent", "/srv/torrents", 300, 1340, { sharedWith: ["qbittorrent", "sonarr"] }),
      usage("sonarr", "/srv/torrents", 300, 1340, { sharedWith: ["qbittorrent", "sonarr"] }),
      usage("immich", "/srv/photos", 500, 480),
      usage("nextcloud", "/srv/docs", 48, 48),
      { appId: "mealie", path: "/srv/mealie", mount: "/", bytes: GiB, grewBytes: null, days: 0, series: series(1, 1, 0) },
    ]);
    expect(rows.map((row) => [row.usage.appId, Math.round(row.grewBytes / GiB), row.days])).toEqual([["qbittorrent", 1040, 29], ["jellyfin", 10, 29]]);
  });

  it("draws each as a line with what it grew, and draws nothing when nothing grew", () => {
    const names: Record<string, string> = { qbittorrent: "qBittorrent", sonarr: "Sonarr" };
    render(<SpaceOverTime usage={[usage("qbittorrent", "/srv/torrents", 300, 1340, { sharedWith: ["qbittorrent", "sonarr"] })]} appName={(id) => names[id ?? ""] ?? String(id)} />);
    const item = within(screen.getByRole("list")).getByRole("listitem");
    expect(item.textContent).toContain("qBittorrent, Sonarr");
    expect(item.textContent).toContain("grew 1.0 TiB in 29 days · holds 1.3 TiB");
    expect(item.querySelector("svg")).toBeTruthy();
    cleanup();
    const { container } = render(<SpaceOverTime usage={[usage("immich", "/srv/photos", 500, 480)]} appName={String} />);
    expect(container.textContent).toBe("");
  });
});
