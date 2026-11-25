import { describe, expect, it } from "vitest";
import { ApiError, errorWords, readJson } from "./http";

const noAnswer = "BoxPilot did not answer. It may be restarting, or this device is off the network.";

describe("errorWords (M89)", () => {
  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "fetch failed"])("says a fetch with no reply (%s) in plain words", (message) => {
    expect(errorWords(new TypeError(message))).toBe(noAnswer);
  });

  it("keeps the server's own words when the admin service is down", async () => {
    const said = "BoxPilot's admin service is not answering, so this could not be read. Repair says how to start it again.";
    const error = await readJson(new Response(JSON.stringify({ error: said, code: "helper_unavailable" }), { status: 503 })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "helper_unavailable" });
    expect(errorWords(error)).toBe(said);
  });

  it("gives any other error's message, and the fallback when there is none", () => {
    expect(errorWords(new Error("That password is not right."))).toBe("That password is not right.");
    expect(errorWords(new TypeError("x is not a function"))).toBe("x is not a function");
    expect(errorWords(new Error(""), "Could not run it.")).toBe("Could not run it.");
    expect(errorWords(null)).toBe("Something went wrong.");
    expect(errorWords({ nothing: true }, "Fallback.")).toBe("Fallback.");
  });
});
