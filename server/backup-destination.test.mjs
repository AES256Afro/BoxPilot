import { describe, expect, it } from "vitest";
import { normalizeDestination, validateDestination } from "./backup-destination.mjs";

describe("off-box backup destination", () => {
  it("accepts a host, user, and absolute path and normalizes the port and trailing slash", () => {
    expect(normalizeDestination({ host: "nas.local", user: "backup", path: "/srv/boxpilot/" })).toEqual({ host: "nas.local", port: 22, user: "backup", path: "/srv/boxpilot" });
    expect(normalizeDestination({ host: "192.168.1.20", port: 2222, user: "bp_mirror", path: "/mnt/pool/homebox" })).toMatchObject({ port: 2222 });
  });

  it("rejects shell-unsafe and malformed values before anything reaches ssh or rsync", () => {
    expect(validateDestination({ host: "nas.local; rm -rf /", user: "backup", path: "/srv" })).toContain("host must be a host name or IP address");
    expect(validateDestination({ host: "nas", user: "Backup User", path: "/srv" })).toContain("user must be a Unix user name");
    expect(validateDestination({ host: "nas", user: "backup", path: "relative/path" })).toContain("path must be absolute, without spaces or '..'");
    expect(validateDestination({ host: "nas", user: "backup", path: "/srv/../etc" })).toContain("path must be absolute, without spaces or '..'");
    expect(validateDestination({ host: "nas", user: "backup", path: "/srv", port: 70000 })).toContain("port must be between 1 and 65535");
    expect(validateDestination(null)).toEqual(["A destination object is required"]);
  });
});
