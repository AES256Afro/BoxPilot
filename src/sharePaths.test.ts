import { describe, expect, it } from "vitest";
import { connectPaths, linuxMountCommand } from "./sharePaths";

const byOs = (host: string, share: string, subpath?: string) =>
  Object.fromEntries(connectPaths({ host, share, subpath }).map((entry) => [entry.os, entry.path]));

describe("how to reach a share from each machine", () => {
  it("gives the Windows and Unix forms of a share root", () => {
    const paths = byOs("192.168.8.10", "the-dump");
    expect(paths.Windows).toBe("\\\\192.168.8.10\\the-dump");
    expect(paths["macOS, Linux"]).toBe("smb://192.168.8.10/the-dump");
    // macOS and Linux share one row: the same URL under two labels reads as two different answers.
    expect(connectPaths({ host: "h", share: "s" })).toHaveLength(2);
  });

  it("points at a folder inside the share, which is the whole reason this exists", () => {
    // "Save your downloads here" is useless without the path to type on each machine.
    const paths = byOs("192.168.8.10", "torrents", "media");
    expect(paths.Windows).toBe("\\\\192.168.8.10\\torrents\\media");
    expect(paths["macOS, Linux"]).toBe("smb://192.168.8.10/torrents/media");
  });

  it("handles a nested subpath and normalises whatever separators it was given", () => {
    expect(byOs("bigbox", "the-dump", "torrents/media").Windows).toBe("\\\\bigbox\\the-dump\\torrents\\media");
    expect(byOs("bigbox", "the-dump", "\\torrents\\media\\").Windows).toBe("\\\\bigbox\\the-dump\\torrents\\media");
    expect(byOs("bigbox", "/the-dump/", "/torrents/")["macOS, Linux"]).toBe("smb://bigbox/the-dump/torrents");
  });

  it("works with a hostname or a tailnet name as readily as an address", () => {
    expect(byOs("homebox.tail0a1b.ts.net", "Documents").Windows).toBe("\\\\homebox.tail0a1b.ts.net\\Documents");
  });

  it("keeps spaces in a share name, which Samba allows", () => {
    expect(byOs("bigbox", "My Media").Windows).toBe("\\\\bigbox\\My Media");
    expect(byOs("bigbox", "My Media")["macOS, Linux"]).toBe("smb://bigbox/My Media");
  });

  it("says something usable when the address is not known yet", () => {
    expect(byOs("", "the-dump").Windows).toBe("\\\\<this server>\\the-dump");
  });

  it("every form carries a hint saying where to put it", () => {
    for (const entry of connectPaths({ host: "bigbox", share: "the-dump" })) expect(entry.hint).toBeTruthy();
  });

  it("builds the Linux mount command for a permanent mount", () => {
    expect(linuxMountCommand({ host: "192.168.8.10", share: "torrents", mountpoint: "/mnt/torrents", username: "chris" }))
      .toBe("sudo mount -t cifs //192.168.8.10/torrents /mnt/torrents -o username=chris,uid=$(id -u),gid=$(id -g)");
  });
});
