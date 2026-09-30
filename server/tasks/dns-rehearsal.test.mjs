import { describe, expect, it } from "vitest";
import { dnsFallbackRehearse, freshName, rehearseFallback } from "./dns-rehearsal.mjs";

const router = "192.168.50.1";
const lanAddress = "192.168.50.20";

/** A little network: the app answers while it runs; the router answers while the app runs, or always when it has a fallback. */
function world({ fallback }) {
  const state = { appUp: true, events: [] };
  const ask = async (server, name) => {
    state.events.push(`ask ${server} ${name.startsWith("bp-rehearsal-") ? "fresh" : name}`);
    if (server === lanAddress) return state.appUp ? { answered: true, ms: 3 } : { answered: false, error: "ECONNREFUSED", ms: 2 };
    return state.appUp || fallback ? { answered: true, ms: state.appUp ? 4 : 1200 } : { answered: false, error: "ESERVFAIL", ms: 8000 };
  };
  return {
    state,
    hands: {
      ask,
      stop: async () => { state.appUp = false; state.events.push("stop"); },
      start: async () => { state.appUp = true; state.events.push("start"); },
      sleep: async () => {},
    },
  };
}

describe("rehearsing this server going down", () => {
  it("passes when the router keeps answering with the app stopped, and brings the app back", async () => {
    const { state, hands } = world({ fallback: true });
    const result = await rehearseFallback({ router, lanAddress }, hands);
    expect(result).toMatchObject({ router, passed: true, answered: 3, total: 3, silent: true, slowestMs: 1200 });
    expect(state.appUp).toBe(true);
    expect(state.events.filter((event) => event === "stop" || event === "start")).toEqual(["stop", "start"]);
  });

  it("fails when the router only asks the app here", async () => {
    const { state, hands } = world({ fallback: false });
    const result = await rehearseFallback({ router, lanAddress }, hands);
    expect(result).toMatchObject({ passed: false, answered: 0, total: 3, slowestMs: null });
    expect(state.appUp).toBe(true);
  });

  it("stops nothing when the router is not answering to begin with", async () => {
    const { state, hands } = world({ fallback: true });
    const quiet = { ...hands, ask: async () => ({ answered: false, error: "ETIMEOUT", ms: 8000 }) };
    await expect(rehearseFallback({ router, lanAddress }, quiet)).rejects.toThrow(/does not answer DNS right now.*Nothing was stopped/);
    expect(state.events).not.toContain("stop");
  });

  it("starts the app again even when asking fails half-way", async () => {
    const { state, hands } = world({ fallback: true });
    let calls = 0;
    const flaky = { ...hands, ask: async (server, name) => { calls += 1; if (calls === 3) throw new Error("resolver exploded"); return hands.ask(server, name); } };
    await expect(rehearseFallback({ router, lanAddress }, flaky)).rejects.toThrow("resolver exploded");
    expect(state.appUp).toBe(true);
    expect(state.events).toContain("start");
  });

  it("fails loudly when the app does not answer again", async () => {
    const { hands } = world({ fallback: true });
    let clock = 0;
    const neverBack = { ...hands, start: async () => {}, now: () => (clock += 5_000) };
    await expect(rehearseFallback({ router, lanAddress, label: "Pi-hole" }, neverBack)).rejects.toThrow(/Pi-hole was started again but did not answer on 192\.168\.50\.20/);
  });

  it("proves nothing when something else answers on this server's address", async () => {
    const { hands } = world({ fallback: true });
    const stillAnswering = { ...hands, ask: async (server, name) => (server === lanAddress ? { answered: true, ms: 1 } : hands.ask(server, name)) };
    expect((await rehearseFallback({ router, lanAddress }, stillAnswering)).passed).toBeNull();
  });

  it("asks names no cache can hold", () => {
    expect(freshName(Buffer.alloc(6, 1))).toBe("bp-rehearsal-010101010101.example.com");
    expect(freshName()).not.toBe(freshName());
  });
});

describe("the rehearsal task", () => {
  function runner({ running = "true", fail = {} } = {}) {
    const calls = [];
    const box = { up: true };
    const run = async (binary, args) => {
      calls.push([binary.split("/").pop(), ...args].join(" "));
      const verb = `${binary.split("/").pop()} ${args[0]}`;
      if (fail[verb]) return { ok: false, code: 1, stdout: "", stderr: fail[verb] };
      if (verb === "docker stop") box.up = false;
      if (verb === "docker start") box.up = true;
      return { ok: true, code: 0, stdout: verb === "docker inspect" ? running : "", stderr: "" };
    };
    // The router has a fallback; the app's own address answers only while it runs.
    const ask = async (server) => (server === lanAddress && !box.up ? { answered: false, error: "ECONNREFUSED", ms: 1 } : { answered: true, ms: 5 });
    return { calls, run, ask };
  }
  const answering = async () => ({ answered: true, ms: 5 });

  it("arms a safety timer before stopping the app, and disarms it after", async () => {
    const { calls, run, ask } = runner();
    const result = await dnsFallbackRehearse({ router, lanAddress, app: "pi-hole" }, { run, ask, sleep: async () => {} });
    expect(result).toMatchObject({ router, app: "pi-hole", appName: "Pi-hole", passed: true });
    const armed = calls.findIndex((call) => call.startsWith("systemd-run --on-active=180"));
    const stopped = calls.findIndex((call) => call === "docker stop --time 5 bp-pi-hole");
    expect(armed).toBeGreaterThan(-1);
    expect(armed).toBeLessThan(stopped);
    expect(calls[armed]).toMatch(/docker start bp-pi-hole$/);
    expect(calls).toContain("docker start bp-pi-hole");
    expect(calls.at(-1)).toMatch(/^systemctl stop boxpilot-dns-rehearsal-[0-9a-f]{8}\.timer$/);
  });

  it("refuses, having stopped nothing, when the app is not running or the timer cannot be set", async () => {
    const stopped = runner({ running: "false" });
    await expect(dnsFallbackRehearse({ router, lanAddress, app: "pi-hole" }, { run: stopped.run, ask: answering })).rejects.toThrow(/not running here.*Nothing was stopped/);
    expect(stopped.calls.some((call) => call.startsWith("docker stop"))).toBe(false);
    const noTimer = runner({ fail: { "systemd-run --on-active=180": "no" } });
    await expect(dnsFallbackRehearse({ router, lanAddress, app: "pi-hole" }, { run: noTimer.run, ask: answering })).rejects.toThrow(/safety timer/);
    expect(noTimer.calls.some((call) => call.startsWith("docker stop"))).toBe(false);
  });

  it("takes only addresses and the DNS apps it knows", async () => {
    const { run } = runner();
    await expect(dnsFallbackRehearse({ router: "router.lan", lanAddress, app: "pi-hole" }, { run })).rejects.toThrow("router's address");
    await expect(dnsFallbackRehearse({ router, lanAddress, app: "nextcloud" }, { run })).rejects.toThrow("app must be one of");
  });
});
