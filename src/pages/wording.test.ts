import { describe, expect, it } from "vitest";
import { backupGlance } from "../home/backupGlance";
import { certificateDay } from "./network/NetworkOverview";
import { dockerSizeWords } from "./system/systemTypes";
import { rootLoginWords } from "./users/UsersPage";

/*
 * Values the pages used to print as the tool wrote them (the quality-of-life walk of 2026-11-10):
 * sshd's "yes", openssl's date, Docker's "10m", and "0 of 0" for a server with no apps yet.
 */
describe("a tool's own value, in the page's words", () => {
  it("says what root's SSH sign-in takes, not sshd's keyword for it", () => {
    expect(rootLoginWords("yes")).toBe("Allowed, with a password");
    expect(rootLoginWords("prohibit-password")).toBe("With a key only");
    expect(rootLoginWords("without-password")).toBe("With a key only");
    expect(rootLoginWords("forced-commands-only")).toBe("With a key, for set commands only");
    expect(rootLoginWords("no")).toBe("Off");
    expect(rootLoginWords(null)).toBe("Not read");
    // A value this page does not know is shown as it came, never guessed at.
    expect(rootLoginWords("something-new")).toBe("something-new");
  });

  it("prints a certificate's last day as a date, and leaves what is not a date alone", () => {
    expect(certificateDay("Sep 29 12:00:00 2027 GMT")).toBe("29 Sep 2027");
    expect(certificateDay("2027-01-05T00:00:00Z")).toBe("5 Jan 2027");
    expect(certificateDay("not read")).toBe("not read");
  });

  it("writes Docker's log cap with its unit", () => {
    expect(dockerSizeWords("10m")).toBe("10 MB");
    expect(dockerSizeWords("500k")).toBe("500 kB");
    expect(dockerSizeWords("1.5g")).toBe("1.5 GB");
    expect(dockerSizeWords("ten")).toBe("ten");
  });

  it("says None yet for a server with no app that holds data, not 0 of 0", () => {
    const read = { protection: "ready", offBox: "ready", database: "ready" } as const;
    const glance = backupGlance({ protection: [], schedules: [] } as never, read as never, Date.UTC(2026, 10, 10));
    expect(glance.apps.value).toBe("None yet");
    expect(glance.apps.caption).toBe("No app holds data to back up");
  });
});
