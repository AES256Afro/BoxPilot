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
