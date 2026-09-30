import { describe, expect, it } from "vitest";
import { nextStep, whatChanged } from "./outcome";

// The Dockge port trap (2026-09-29): Dockge's port was held by Tailscale Serve; each fix says which address it kept.
describe("what a port-conflict fix changed", () => {
  it("says which address the app keeps and which one ended", () => {
    expect(whatChanged({ type: "op:app.exposure.set", steps: [], result: { id: "dockge", mode: "tailnet", url: "https://homebox.tailXXXX.ts.net:5001" } }))
      .toBe("dockge answers only through Tailscale now, at https://homebox.tailXXXX.ts.net:5001, and no longer on your home network.");
    expect(whatChanged({ type: "op:app.serve.set", steps: [], result: { id: "dockge", enabled: false, port: 5001, withdrawn: "https://homebox.tailXXXX.ts.net:5001", started: true, status: "running", recreated: true } }))
      .toBe("Tailscale Serve no longer publishes https://homebox.tailXXXX.ts.net:5001, so port 5001 is dockge's alone. It is running now, its container built again.");
    expect(whatChanged({ type: "op:app.reconfigure", steps: [], result: { reconfigured: true, id: "uptime-kuma", hostPorts: [{ host: 3004, protocol: "tcp" }] } }))
      .toBe("uptime-kuma was recreated with its new settings and publishes port 3004.");
  });

  it("points at freeing the port, not at the log, when the job stopped on a port conflict", () => {
    const error = "Dockge was not started. Port 5001 is taken on the tailnet address (100.64.0.10) by Tailscale Serve, which publishes Dockge itself at https://homebox.tailXXXX.ts.net:5001.";
    expect(nextStep({ manual: null, fixes: [], fix: null }, true, error)).toContain("Free the port first: the sentence above names what holds it.");
    expect(nextStep({ manual: null, fixes: [], fix: null }, true, "docker compose up failed")).toBe("Read the job's log below: it says where it stopped. Fix what it names, then try again.");
    // A finding's own words still come first.
    expect(nextStep({ manual: "Use the choices on the port finding.", fixes: [], fix: null }, true, error)).toBe("Use the choices on the port finding.");
  });
});

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

  // The power cut's two fixes (2026-09-29).
  it("says names resolve again and where the old file is, and that the boot partition's mark is gone", () => {
    expect(whatChanged({ type: "op:dns.lookups.restore", steps: [], result: { changed: true, backup: "/etc/resolv.conf.boxpilot-20260929T221804Z", names: [{ name: "github.com", ok: true }] } }))
      .toBe("Names resolve again (github.com): /etc/resolv.conf points at systemd-resolved. The file it replaced is kept as /etc/resolv.conf.boxpilot-20260929T221804Z. Tailscale's DNS warning clears the next time it starts.");
    expect(whatChanged({ type: "op:dns.lookups.restore", steps: [], result: { changed: false, alreadyPointed: true, names: [{ name: "github.com", ok: true }] } }))
      .toBe("/etc/resolv.conf already pointed at systemd-resolved, and names resolve (github.com).");
    expect(whatChanged({ type: "op:storage.boot-mark.clear", steps: [], result: { target: "/boot/efi", cleared: true } }))
      .toBe("/boot/efi's \"not properly unmounted\" mark is cleared, the check found nothing else, and it is mounted again.");
    expect(whatChanged({ type: "op:storage.boot-mark.clear", steps: [], result: { target: "/boot/efi", cleared: false, alreadyClean: true } }))
      .toBe("/boot/efi was not marked, so nothing needed clearing; it is mounted again.");
  });
});
