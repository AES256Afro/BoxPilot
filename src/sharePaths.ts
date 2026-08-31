/**
 * How to reach a shared folder from each kind of machine.
 *
 * The address is the same everywhere and the syntax never is: Windows wants backslashes and no
 * scheme, macOS and Linux want an smb:// URL, and mounting it permanently on Linux is a different
 * command again. Anywhere BoxPilot names a share it should be able to say all three, including for
 * a folder inside the share, because "put your downloads here" is useless without the path to type.
 */

export interface ConnectPath { os: "Windows" | "macOS, Linux" | "Linux"; path: string; hint?: string }

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

/**
 * The NFS equivalents. Nothing is shared with the SMB forms: NFS has no smb:// URL, Linux mounts it
 * with a command rather than by browsing, and the fstab line is the thing anyone actually wants when
 * a VM should mount it at boot.
 */
export function nfsPaths({ host, exportPath }: { host: string; exportPath: string }): ConnectPath[] {
  const cleanHost = String(host ?? "").trim() || "<this server>";
  const target = `/${String(exportPath ?? "").split("/").filter(Boolean).join("/")}`;
  const leaf = target.split("/").filter(Boolean).at(-1) ?? "share";
  return [
    { os: "Linux", path: `sudo mount -t nfs4 ${cleanHost}:${target} /mnt/${leaf}`, hint: "run once; add the fstab line below to keep it" },
    { os: "macOS, Linux", path: `nfs://${cleanHost}${target}`, hint: "Finder: Go, Connect to Server" },
    { os: "Windows", path: `${cleanHost}:${target}`, hint: "needs the Services for NFS feature; SMB is the easier route on Windows" },
  ];
}

/** The fstab line that mounts an NFS export at boot, which is what a VM actually needs. */
export function nfsFstabLine({ host, exportPath, mountpoint = "/mnt/share" }: { host: string; exportPath: string; mountpoint?: string }): string {
  const target = `/${String(exportPath ?? "").split("/").filter(Boolean).join("/")}`;
  return `${String(host).trim()}:${target}  ${mountpoint}  nfs4  defaults,nofail,_netdev  0 0`;
}
