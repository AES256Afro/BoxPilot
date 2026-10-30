import { describe, expect, it } from "vitest";
import { httpRequest } from "./http-request.mjs";

const pendingTimeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

describe("the request's abort timer", () => {
  it("is cleared when the connection fails before any body is read", async () => {
    // The clear lived in the body-read finally, which a refused connection never reaches; the armed
    // timer then kept the task process - and the oneshot unit and flow step waiting on it - alive
    // for the full timeout after the task had already failed.
    const before = pendingTimeouts();
    const fetcher = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } }); };
    await expect(httpRequest({ url: "http://127.0.0.1:9/never" }, { fetcher, timeoutMs: 60_000 })).rejects.toThrow(/ECONNREFUSED/);
    expect(pendingTimeouts()).toBe(before);
  });

  it("is cleared after a successful read too", async () => {
    const before = pendingTimeouts();
    const fetcher = async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    await httpRequest({ url: "http://127.0.0.1:9/fine" }, { fetcher, timeoutMs: 60_000 });
    expect(pendingTimeouts()).toBe(before);
  });
});

describe("the credentials BoxPilot keeps for itself", () => {
  it("are refused inside the task, before the store is read or anything is sent", async () => {
    // The parameter check refuses them first; this is the root task holding the same line on its own.
    const read = [];
    const sent = [];
    const credentials = { read: async (name) => { read.push(name); return "secret-value"; } };
    const fetcher = async (url, options) => { sent.push({ url, options }); return new Response("ok"); };
    for (const name of ["cloudflare-api-token", "cloudflare-tunnel-token", "heartbeat-url", "zulip-agents-bot"]) {
      await expect(httpRequest({ url: "https://collector.example/x", credentialName: name, credentialHeader: "X-Token" }, { credentials, fetcher }), name).rejects.toThrow(/BoxPilot keeps .* for itself/);
    }
    expect(read).toEqual([]);
    expect(sent).toEqual([]);
    // A credential the owner saved for requests still rides along.
    await httpRequest({ url: "https://ntfy.example/topic", credentialName: "ntfy-token" }, { credentials, fetcher });
    expect(sent[0].options.headers.Authorization).toBe("Bearer secret-value");
  });
});
