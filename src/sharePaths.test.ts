import { describe, expect, it } from "vitest";
import { connectPaths, linuxMountCommand, nfsFstabLine, nfsPaths } from "./sharePaths";

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

describe("NFS, which shares none of the SMB syntax", () => {
  it("gives the mount command, the URL, and the fstab line for an export", () => {
    const forms = Object.fromEntries(nfsPaths({ host: "192.168.8.10", exportPath: "/srv/media" }).map((entry) => [entry.os, entry.path]));
    expect(forms.Linux).toBe("sudo mount -t nfs4 192.168.8.10:/srv/media /mnt/media");
    expect(forms["macOS, Linux"]).toBe("nfs://192.168.8.10/srv/media");
    expect(nfsFstabLine({ host: "192.168.8.10", exportPath: "/srv/media" }))
      .toBe("192.168.8.10:/srv/media  /mnt/share  nfs4  defaults,nofail,_netdev  0 0");
  });

  it("names the mount point after the export's own last folder, not a fixed one", () => {
    // Two exports mounted with the same command would land on top of each other.
    const first = nfsPaths({ host: "h", exportPath: "/srv/media" }).find((entry) => entry.os === "Linux")!.path;
    const second = nfsPaths({ host: "h", exportPath: "/mnt/the-dump/torrents" }).find((entry) => entry.os === "Linux")!.path;
    expect(first).toContain("/mnt/media");
    expect(second).toContain("/mnt/torrents");
    expect(first).not.toBe(second);
  });

  it("normalises the export path however it was given", () => {
    expect(nfsPaths({ host: "h", exportPath: "srv/media/" }).find((entry) => entry.os === "Linux")!.path).toContain("h:/srv/media ");
    expect(nfsFstabLine({ host: "h", exportPath: "//srv//media//" }).startsWith("h:/srv/media")).toBe(true);
  });

  it("says plainly that Windows is the awkward one here", () => {
    expect(nfsPaths({ host: "h", exportPath: "/srv/m" }).find((entry) => entry.os === "Windows")!.hint).toContain("SMB is the easier route");
  });
});
