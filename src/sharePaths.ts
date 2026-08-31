/**
 * How to reach a shared folder from each kind of machine.
 *
 * The address is the same everywhere and the syntax never is: Windows wants backslashes and no
 * scheme, macOS and Linux want an smb:// URL, and mounting it permanently on Linux is a different
 * command again. Anywhere BoxPilot names a share it should be able to say all three, including for
 * a folder inside the share, because "put your downloads here" is useless without the path to type.
 */

export interface ConnectPath { os: "Windows" | "macOS, Linux"; path: string; hint?: string }

/** Trim, drop leading and trailing slashes, and normalise separators to forward slashes. */
function cleanSegment(value: string | null | undefined): string {
  return String(value ?? "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

/**
 * The three forms of one share path. `subpath` is a folder inside the share, so a caller can point
 * at `torrents/media` rather than only the share root.
 */
export function connectPaths({ host, share, subpath = "" }: { host: string; share: string; subpath?: string }): ConnectPath[] {
  const cleanHost = String(host ?? "").trim() || "<this server>";
  const cleanShare = cleanSegment(share);
  const tail = cleanSegment(subpath);
  const unix = [cleanShare, tail].filter(Boolean).join("/");
  // macOS and Linux take the identical URL, so they share a row: printing the same string twice
  // under two labels reads as two different answers.
  return [
    { os: "Windows", path: `\\\\${cleanHost}\\${unix.replace(/\//g, "\\")}`, hint: "paste into File Explorer's address bar" },
    { os: "macOS, Linux", path: `smb://${cleanHost}/${unix}`, hint: "Finder: Go, Connect to Server. Files: Other Locations." },
  ];
}

/** The fstab-style command for mounting a share permanently on another Linux box. */
export function linuxMountCommand({ host, share, mountpoint = "/mnt/share", username = "your-user" }: { host: string; share: string; mountpoint?: string; username?: string }): string {
  return `sudo mount -t cifs //${String(host).trim()}/${cleanSegment(share)} ${mountpoint} -o username=${username},uid=$(id -u),gid=$(id -g)`;
}
