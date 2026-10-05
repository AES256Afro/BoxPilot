import { describe, expect, it } from "vitest";
import appHelperSource from "../server/app-helper.mjs?raw";
import housekeepingSource from "../server/housekeeping.mjs?raw";
import snapshotSource from "../server/machine-snapshot-helper.mjs?raw";
import { adviseRetry, failureLine } from "./retryAdvice";

describe("whether running a failure again can work", () => {
  it("keeps Try again for what changes by itself or by a hand outside BoxPilot, and says what to do first", () => {
    expect(adviseRetry("Connection reset by peer")).toEqual({ retry: true });
    expect(adviseRetry(null)).toEqual({ retry: true });
    // Remount's own words for a drive that is unplugged: plug it in, then the same run works.
    expect(adviseRetry("The drive for /mnt/media (UUID=77aa-media) is not connected to this server right now, so nothing was stopped or unmounted. Check that it is plugged in and powered on, then try again."))
      .toEqual({ retry: true, instruction: "Check that it is plugged in and powered on, then try again." });
    expect(adviseRetry("/mnt/media is in use, so it was left alone: umount: /mnt/media: target is busy. Stop whatever is using it — an app with that folder mounted, or the file server — and try again.").instruction)
      .toBe("Stop whatever is using it — an app with that folder mounted, or the file server — and try again.");
    expect(adviseRetry("/mnt/x is still in use by smbd (412), so it was left mounted as it was: target is busy. A computer connected to the media share kept reconnecting faster than it could be unmounted; disconnect it (or close File Explorer there) and try again.").retry).toBe(true);
  });

  it("offers the place a failure names instead of a Try again that fails the same way", () => {
    // The unwell demo's Immich backup, and the owner's reason for this: the same refusal, three times.
    expect(adviseRetry("tar failed: No space left on device")).toEqual({ retry: false, next: { label: "Free up space", view: "system", tab: "housekeeping" } });
    expect(adviseRetry("Port 3001 is already in use by tailscaled. Move Uptime Kuma to a free port in its Settings.")).toMatchObject({ retry: false, next: { view: "repairs" } });
    expect(adviseRetry("Docker Engine is not available; install it from Repair Center first")).toMatchObject({ retry: false, next: { view: "repairs" } });
    expect(adviseRetry("fsck.exfat is not installed, so nothing was stopped or unmounted. Install the drive check tools from Repair first.")).toMatchObject({ retry: false, next: { view: "repairs" } });
    expect(adviseRetry("rclone is not installed; install it from the Backups page first")).toMatchObject({ retry: false, next: { view: "backups", tab: "offbox" } });
    expect(adviseRetry("There is nothing to mirror yet: take a backup or a machine snapshot first, then run this again.")).toMatchObject({ retry: false, next: { view: "backups" } });
    expect(adviseRetry("The NAS refused the credentials. Check the username and password; on a WD My Cloud Home you must first enable local network access.")).toMatchObject({ retry: false, next: { view: "storage", tab: "shares" } });
    expect(adviseRetry("Jellyfin is set to use the shared VPN profile, but none is saved. Save a VPN profile in the VPN section first, or turn off \"Use my VPN profile\" and give this app its own connection.")).toMatchObject({ retry: false, next: { view: "network", tab: "vpn" } });
    expect(adviseRetry("/mnt/media is not mounted, so there is nothing to check yet. Reconnect the drive first.")).toMatchObject({ retry: false, next: { view: "storage" } });
    expect(adviseRetry("Immich is already installed; use reconfigure or update")).toMatchObject({ retry: false, next: { view: "catalog" } });
  });

  it("offers nothing to run when nothing BoxPilot runs would change it", () => {
    expect(adviseRetry("Homepage has no data to back up")).toEqual({ retry: false });
  });

  // Refusals about what a file holds, or whether it is there: the same file refuses the same way every
  // time (sweep 5). Try again on a high-risk restore asked for the password, then refused again.
  // Each is the server's own sentence, and the server's source is checked to still say it.
  it.each([
    ["an app backup with a link where BoxPilot writes", appHelperSource, "where BoxPilot writes ${manifest.name}'s own files as root:",
      "Uptime Kuma was not restored; nothing was changed. In this backup data is a link, or not a plain file, where BoxPilot writes Uptime Kuma's own files as root: restored, the next change to Uptime Kuma would have written through it to somewhere else on this server. If data was a link in Uptime Kuma's folder when this backup was taken (to another disk, say), the backup holds only that link and none of what it pointed at; backups now refuse such a folder instead of taking it."],
    ["an app folder whose data folder has become a link", appHelperSource, "was not backed up; nothing was stopped. In its folder",
      "Immich was not backed up; nothing was stopped. In its folder library is a link to /mnt/disk2/library: a backup would hold only the link, none of what it points at, and a restore refuses a link where BoxPilot writes Immich's files as root. Move the data back into /var/lib/boxpilot-managed/catalog/immich/library, or mount the other disk there itself rather than linking to it, then back up again."],
    ["a machine snapshot with links or special files", snapshotSource, "which a snapshot BoxPilot made never does",
      "The snapshot holds srv/data/link, links or special files, which a snapshot BoxPilot made never does. Nothing was changed."],
    ["an unreadable snapshot that reads now", housekeepingSource, "can be read now, so it was not removed.",
      "boxpilot-machine-20260901-030000.tar.zst can be read now, so it was not removed."],
    ["an unreadable snapshot already gone", housekeepingSource, "is no longer there`",
      "boxpilot-machine-20260901-030000.tar.zst is no longer there"],
    ["an app backup that failed its checksum", appHelperSource, "failed its checksum; it may be damaged. Nothing was changed.",
      "Backup immich-20260901-030000.tar.gz failed its checksum; it may be damaged. Nothing was changed."],
    ["a machine snapshot that failed its checksum", snapshotSource, "The snapshot failed its checksum; it may be damaged. Nothing was changed.",
      "The snapshot failed its checksum; it may be damaged. Nothing was changed."],
  ])("offers no Try again on %s, which refuses the same way every time", (_what, source, wording, message) => {
    expect(source).toContain(wording);
    expect(adviseRetry(message)).toEqual({ retry: false });
  });
});

describe("a failure in a line or two", () => {
  it("keeps what the error says to do when the start has to be cut", () => {
    const unplugged = "The drive for /mnt/media (UUID=77aa-media-0000-0000-0000-000000000000) is not connected to this server right now, so nothing was stopped or unmounted. Check that it is plugged in and powered on, then try again.";
    const line = failureLine("Last try failed: ", unplugged);
    expect(line.endsWith("Check that it is plugged in and powered on, then try again.")).toBe(true);
    expect(line.startsWith("Last try failed: The drive for /mnt/media")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(152);
  });

  it("says a short error whole, and a long one without instructions cut at a word", () => {
    expect(failureLine("Last try failed: ", "target is busy")).toBe("Last try failed: target is busy");
    expect(failureLine("", null)).toBe("no error was recorded");
    const long = failureLine("", `${"word ".repeat(60)}end`);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(151);
  });
});
