import { describe, expect, it } from "vitest";
import { batteryWords, durationWords, powerEventWords, powerNews, upsStateWords, type PowerEvent } from "./powerEvents";

// An outage as the log records it, newest first: out, back, out again, low, shut down, started.
const outage: PowerEvent[] = [
  { at: "2026-09-29T20:40:00Z", event: "started" },
  { at: "2026-09-29T19:05:33Z", event: "power-off" },
  { at: "2026-09-29T19:05:31Z", event: "apps-stopped", containers: 7, drives: 2, busy: 1 },
  { at: "2026-09-29T19:05:06Z", event: "shutdown", charge: 9, runtime: 110 },
  { at: "2026-09-29T19:05:00Z", event: "low-battery", charge: 9, runtime: 110 },
  { at: "2026-09-29T18:50:00Z", event: "on-battery", charge: 98, runtime: 1500 },
  { at: "2026-09-29T18:44:40Z", event: "on-mains", charge: 96, runtime: 1180 },
  { at: "2026-09-29T18:41:02Z", event: "on-battery", charge: 100, runtime: 1260 },
  { at: "2026-09-29T10:00:00Z", event: "watching", charge: 100, runtime: 1800 },
];
const now = Date.parse("2026-09-29T21:00:00Z");

describe("power events in words", () => {
  it("says durations and the battery the way people say them", () => {
    expect(durationWords(45_000)).toBe("45 s");
    expect(durationWords(218_000)).toBe("4 min");
    expect(durationWords(3_600_000)).toBe("1 h");
    expect(durationWords(5_520_000)).toBe("1 h 32 min");
    expect(batteryWords({ at: "", event: "on-battery", charge: 87, runtime: 1260 })).toBe("battery 87%, about 21 min left");
    expect(batteryWords({ at: "", event: "power-off" })).toBeNull();
  });

  it("tells how long the power was out and how long the server was off", () => {
    expect(powerEventWords(outage[6], outage, 6).title).toBe("The power came back after 4 min");
    expect(powerEventWords(outage[0], outage, 0)).toEqual({ title: "The server started again", detail: "off for 1 h 34 min", status: "good" });
    expect(powerEventWords(outage[2], outage, 2)).toEqual({ title: "Apps and drives were put away", detail: "7 apps stopped, 2 drives unmounted, 1 drive still in use, left to the shutdown", status: "warning" });
    expect(powerEventWords(outage[4], outage, 4)).toMatchObject({ title: "The UPS battery ran low", status: "danger" });
    expect(powerEventWords({ at: "2026-09-29T19:00:00Z", event: "on-mains" }).title).toBe("The power came back");
    expect(powerEventWords({ at: "2026-09-29T19:00:00Z", event: "something-new" }).status).toBe("unknown");
  });

  it("makes news of the outages and what the server did, newest first, and leaves out the routine", () => {
    const news = powerNews(outage, now);
    expect(news.map((item) => item.title)).toEqual(["The server started again", "The server switched itself off", "The server began shutting down, before the battery ran out"]);
    expect(powerNews(outage, now, { limit: 10 }).some((item) => item.event === "watching" || item.event === "apps-stopped")).toBe(false);
    // A week later it is not news any more.
    expect(powerNews(outage, now + 8 * 86_400_000)).toEqual([]);
  });

  it("names the UPS's state, and never calls one that is not answering fine", () => {
    expect(upsStateWords("online")).toEqual({ status: "good", label: "On mains" });
    expect(upsStateWords("on-battery").status).toBe("warning");
    expect(upsStateWords("low-battery").status).toBe("danger");
    expect(upsStateWords("unavailable").status).toBe("unknown");
    expect(upsStateWords(null).status).toBe("unknown");
  });
});
