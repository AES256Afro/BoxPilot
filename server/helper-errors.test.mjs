import { describe, expect, it } from "vitest";
import { helperError, helperErrorCode, helperFailure } from "./helper-errors.mjs";

describe("what the owner is told when the admin service does not answer (M89)", () => {
  it("has one plain sentence per way it fails, and keeps the transport's words as detail only", () => {
    const error = helperError("helper_unavailable", "Helper unavailable: connect ENOENT /run/boxpilot/helper.sock");
    expect(error).toMatchObject({ code: "helper_unavailable", message: "BoxPilot's admin service is not answering.", detail: "Helper unavailable: connect ENOENT /run/boxpilot/helper.sock" });
    expect(helperFailure(error)).toEqual({ code: "helper_unavailable", error: "BoxPilot's admin service is not answering, so this could not be read. Repair says how to start it again." });
    expect(helperFailure(error, { doing: "run" })?.error).toBe("BoxPilot's admin service is not answering, so this did not start and nothing was changed. Repair says how to start it again.");
    expect(helperFailure(helperError("helper_timeout", "x"), { doing: "run" })?.error).toBe("BoxPilot's admin service did not answer in time, so whether this finished is not known. Check what it changed before running it again.");
    expect(helperFailure(helperError("helper_closed", "x"))?.error).toBe("BoxPilot's admin service stopped answering partway, so this could not be read. Try again in a moment; if it keeps happening, Repair says how to restart it.");
  });

  it("leaves every other error alone", () => {
    for (const error of [new Error("apt-get failed"), Object.assign(new Error("ran out"), { code: "timeout" }), Object.assign(new Error("restarting"), { code: "helper_restarting" }), null, "text"]) {
      expect(helperErrorCode(error)).toBeNull();
      expect(helperFailure(error)).toBeNull();
    }
  });
});
