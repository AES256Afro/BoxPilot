/**
 * Which folders the file servers will serve, as the browser sees it.
 *
 * This has to agree with `cleanServedPath` and the deny lists in server/tasks/samba.mjs and
 * server/tasks/nfs.mjs. The Storage page suggested /mnt, which holds /mnt/boxpilot (the backup
 * destination), and offered Share on a drive mounted under it: both servers refuse those, so the
 * owner was handed a folder only to be told no. `servedFolder.test.ts` holds the lists and the
 * answers to the server's.
 */

/** What Samba refuses to share (server/tasks/samba.mjs). */
export const sharePathDenyPrefixes: readonly string[] = Object.freeze(["/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/run", "/var/run", "/opt", "/snap", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/libvirt", "/var/lib/docker", "/var/lib/boxpilot", "/var/lib/boxpilot-managed", "/var/lib/samba", "/mnt/boxpilot"]);
/** What the NFS server refuses to export (server/tasks/nfs.mjs). */
export const exportPathDenyPrefixes: readonly string[] = Object.freeze(["/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/run", "/var/run", "/opt", "/snap", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/libvirt", "/var/lib/docker", "/var/lib/boxpilot", "/var/lib/boxpilot-managed", "/var/lib/nfs", "/mnt/boxpilot"]);

/** The server's rule: one spelling only, nothing inside a protected folder, and nothing that holds one. */
function served(path: string, denyPrefixes: readonly string[], forbidden: RegExp): boolean {
  if (path.length > 512 || !path.startsWith("/") || forbidden.test(path)) return false;
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return false;
  if (trimmed.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const within = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);
  return !denyPrefixes.some((prefix) => within(prefix, trimmed) || within(trimmed, prefix));
}

/** Whether both Samba and the NFS server would take this folder, so it is worth offering for either. */
export function mayServe(path: string): boolean {
  return served(path, sharePathDenyPrefixes, /[\0\r\n]/) && served(path, exportPathDenyPrefixes, /[\0\r\n\s"]/);
}
