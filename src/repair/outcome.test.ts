import { describe, expect, it } from "vitest";
import { whatChanged } from "./outcome";

describe("what a fix changed (M35)", () => {
  it("names the apps started again and the file sharing disconnected after a reconnect", () => {
    const text = whatChanged({ type: "op:storage.remount", steps: [], result: { remounted: true, mountpoint: "/mnt/media", source: "/dev/sdb1", restarted: ["bp-jellyfin", "bp-qbittorrent"], sharingClosedFor: ["192.0.2.20"] } });
    expect(text).toBe("/mnt/media is mounted again from /dev/sdb1, reads, and is writable. jellyfin and qbittorrent were started again. File sharing from 192.0.2.20 was disconnected and reconnects by itself.");
  });

  it("tells the owner how to subscribe on the phone after connecting ntfy, with the tailnet address when it is known", () => {
    const known = whatChanged({ type: "op:notifications.ntfy.connect", steps: [], result: { connected: true, topic: "boxpilot-abc", subscribeUrl: "http://homebox:8093" } });
    expect(known).toContain("install the ntfy app");
    expect(known).toContain("enter http://homebox:8093, then subscribe to the topic boxpilot-abc");
    const unknown = whatChanged({ type: "op:notifications.ntfy.connect", steps: [], result: { connected: true, topic: "boxpilot-abc", subscribeUrl: null } });
    expect(unknown).toContain("enter the address you open ntfy's page at");
  });
});
