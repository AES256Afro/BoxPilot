// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPiholeReader, describePihole, parseRows, piholeQueries, summarize } from "./pihole.mjs";

const now = new Date("2026-09-29T12:00:00Z");
const outputs = {
  totals: "1200\t240",
  topBlocked: "ads.example.com\t80\ttracker.example.net\t40\nbad domain with spaces\t5",
  upstreams: "9.9.9.9#53\t600\t0.012\n149.112.112.112#53\t300\t\ncache\t10\t0",
  gravity: `updated\t${Math.floor(Date.parse("2026-09-25T12:00:00Z") / 1000)}\ngravity_count\t123456`,
};

describe("Pi-hole's numbers", () => {
  it("are network-wide counts: no query reads the client column", () => {
    for (const sql of Object.values(piholeQueries(1_000))) expect(sql.toLowerCase()).not.toMatch(/\bclient\b/);
    // Only a number of seconds is ever put into a query: text becomes 0, never SQL.
    expect(piholeQueries("1000; DROP TABLE queries").totals).toContain("timestamp >= 0;");
    expect(piholeQueries(1_000).totals).toContain("timestamp >= 1000;");
  });

  it("are summarised field by field, dropping what does not look like a domain or an upstream", () => {
    const summary = summarize({ ...outputs, topBlocked: "ads.example.com\t80\ntracker.example.net\t40\nbad domain with spaces\t5", blocking: "true", now });
    expect(summary).toMatchObject({ blocking: true, last24h: { queries: 1200, blocked: 240, blockedPercent: 20 }, gravity: { domains: 123456, ageDays: 4 } });
    expect(summary.topBlocked).toEqual([{ domain: "ads.example.com", count: 80 }, { domain: "tracker.example.net", count: 40 }]);
    expect(summary.upstreams.map((entry) => [entry.upstream, entry.share, entry.averageReplyMs])).toEqual([["9.9.9.9#53", 65.9, 12], ["149.112.112.112#53", 33, null], ["cache", 1.1, 0]]);
    expect(parseRows("a\tb\r\n\n c\td ")).toEqual([["a", "b"], [" c", "d "]]);
  });

  it("describe blocking turned off loudly, and never a client", () => {
    const text = describePihole({ placement: "host", available: true, ...summarize({ ...outputs, blocking: "false", now }) });
    expect(text).toContain("Blocking: OFF");
    expect(text).toContain("natively on the host");
  });
});

describe("where Pi-hole runs", () => {
  const reader = (answers, apps = null) => {
    const calls = [];
    const run = async (binary, args) => {
      calls.push([binary, ...args]);
      const key = args.join(" ");
      for (const [pattern, result] of answers) if (pattern.test(key)) return typeof result === "function" ? result(args) : result;
      return { ok: false, stdout: "", stderr: "" };
    };
    return { read: createPiholeReader({ run, apps, now: () => now }), calls };
  };
  const sqlite = (args) => {
    const text = args.at(-1);
    if (text.includes("FROM info")) return { ok: true, stdout: outputs.gravity };
    if (text.includes("GROUP BY domain")) return { ok: true, stdout: "ads.example.com\t80" };
    if (text.includes("GROUP BY forward")) return { ok: true, stdout: "9.9.9.9#53\t100\t0.01" };
    return { ok: true, stdout: outputs.totals };
  };

  it("is BoxPilot's app when the catalog installed it, and it is read inside that container", async () => {
    const apps = { inspect: async () => ({ applications: [{ id: "pi-hole", installed: true, container: { running: true } }] }) };
    const { read, calls } = reader([[/^exec bp-pi-hole pihole-FTL sqlite3/, sqlite], [/--config dns.blocking.active/, { ok: true, stdout: "true" }]], apps);
    const result = await read.inspect();
    expect(result).toMatchObject({ placement: "boxpilot-app", container: "bp-pi-hole", available: true, blocking: true });
    expect(calls.every(([, ...args]) => !args.join(" ").includes("client"))).toBe(true);
    expect(calls.some(([, ...args]) => args.includes("-readonly"))).toBe(true);
  });

  it("is another container when one runs the pihole/pihole image", async () => {
    const { read } = reader([[/^ps --all/, { ok: true, stdout: "pihole\tpihole/pihole:2025.1\trunning\nweb\tnginx\trunning" }], [/^exec pihole pihole-FTL sqlite3/, sqlite], [/dns.blocking.active/, { ok: true, stdout: "false" }]]);
    expect(await read.inspect()).toMatchObject({ placement: "container", container: "pihole", blocking: false });
  });

  it("is the host when pihole-FTL.service is loaded, and says so when it is not running", async () => {
    const { read } = reader([[/^ps --all/, { ok: true, stdout: "" }], [/^show pihole-FTL.service/, { ok: true, stdout: "LoadState=loaded\nActiveState=inactive" }]]);
    expect(await read.inspect()).toMatchObject({ placement: "host", available: false, reason: "pihole-FTL.service is not running." });
  });

  it("is nowhere when none of those is true", async () => {
    const { read } = reader([[/^ps --all/, { ok: true, stdout: "" }], [/^show/, { ok: true, stdout: "LoadState=not-found\nActiveState=inactive" }]]);
    const result = await read.inspect();
    expect(result).toMatchObject({ placement: "absent", available: false });
    expect(describePihole(result)).toMatch(/not installed/);
  });
});
