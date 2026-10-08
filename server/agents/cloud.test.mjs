// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAgentsCloud } from "./cloud.mjs";

/*
 * Claude as the web service knows it (M45.3): what the owner chose, recorded when the operations
 * finish, and the month as the gateway counts it, never the key.
 */

function memoryState() {
  const settings = new Map();
  return { getSetting: (key, fallback = null) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value) };
}

describe("Claude for the agents", () => {
  it("is off until connected, then shows the cap and the gateway's month", async () => {
    const gateway = { status: async () => ({ connected: true, month: "2026-10", spentUsd: 1.25, calls: 7, capUsd: 20 }) };
    const cloud = createAgentsCloud({ state: memoryState(), gateway, now: () => Date.parse("2026-10-08T12:00:00Z") });
    expect(await cloud.state()).toMatchObject({ connected: false, gateway: "off", spentUsd: null });
    cloud.connected({ connected: true, capUsd: 20 }, { actorId: "owner" });
    expect(await cloud.state()).toMatchObject({ connected: true, capUsd: 20, gateway: "answering", month: "2026-10", spentUsd: 1.25, calls: 7, connectedAt: "2026-10-08T12:00:00.000Z", model: "claude-opus-5-5" });
    cloud.capSet({ capUsd: 50 }, { actorId: "owner" });
    expect((await cloud.state()).capUsd).toBe(50);
    cloud.disconnected({ actorId: "owner" });
    expect(await cloud.state()).toMatchObject({ connected: false, gateway: "off", capUsd: 50 });
  });

  it("says plainly when the gateway is not answering", async () => {
    const gateway = { status: async () => { throw Object.assign(new Error("nothing on the socket"), { code: "gateway-down" }); } };
    const cloud = createAgentsCloud({ state: memoryState(), gateway });
    cloud.connected({ capUsd: 20 });
    expect(await cloud.state()).toMatchObject({ connected: true, gateway: "not answering", problem: expect.stringMatching(/not answering; agents run on the local model/) });
  });
});
