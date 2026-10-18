/**
 * A folder the file server (Samba) or the NFS server may serve, spelled one way only, or null.
 *
 * Both servers run as root and are set up by a medium-risk approval, so the locations BoxPilot
 * protects are refused however a path is written: "/./etc" and "//etc" are /etc to smbd and to the
 * kernel, and a prefix test alone let them through. A folder that holds a protected location is
 * refused too: serving /var serves /var/lib/boxpilot with it, and "/" serves everything.
 */
export function cleanServedPath(value, denyPrefixes, { forbidden = /[\0\r\n]/ } = {}) {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || forbidden.test(value)) return null;
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed) return null; // "/" itself
  if (trimmed.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const within = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
  if (denyPrefixes.some((prefix) => within(prefix, trimmed) || within(trimmed, prefix))) return null;
  return trimmed;
}

/** Where the server's login accounts live. */
export const homeRoot = "/home";

/**
 * The homes of accounts that can log in, from /etc/passwd: a share writes as the folder's owner, and
 * a service account with a shell (postgres, at /var/lib/postgresql) is a shell like any other.
 */
export function loginHomesFrom(passwd) {
  return String(passwd ?? "").split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 7)
    .filter(([, , , , , home, shell]) => home && home !== "/" && home !== "/nonexistent" && !/(?:nologin|false|sync|halt|shutdown)$/.test(shell.trim()))
    .map(([, , , , , home]) => home.replace(/\/+$/, ""));
}

/** Whether a folder is inside a home, or holds one: serving /mnt/data serves /mnt/data/alice with it. */
export function reachesHome(path, homes = []) {
  if (typeof path !== "string") return false;
  const folder = path.replace(/\/+$/, "") || "/";
  return [homeRoot, ...homes].some((home) => folder === home || folder.startsWith(`${home}/`) || home.startsWith(`${folder === "/" ? "" : folder}/`));
}
const insideHome = (path, homes = []) => reachesHome(path, homes);

/**
 * Whether a share or export reaches into a login account's home. Samba forces writes as the folder's
 * owner and NFS squashes every client to it, so serving /home/<admin> lets whoever can reach the share
 * write that account's ~/.ssh: the owner's call, with a password (ops/samba.mjs, ops/nfs.mjs).
 */
export function servesHome(paths, homes = []) {
  return (paths ?? []).some((path) => insideHome(String(path ?? "").replace(/\/+$/, "") || "/", homes));
}

/**
 * A folder that only reaches a home through a link is refused: the approval was given for the path as
 * written, and its tier for a path outside /home.
 */
export function homeThroughLink(path, real, homes = []) {
  return !insideHome(path, homes) && insideHome(real, homes) ? `${path} leads to ${real}, which reaches a login account's home; share that folder by its own path` : null;
}

/** The login homes as root reads them; none when /etc/passwd cannot be read. */
export async function readLoginHomes(readFile) {
  return typeof readFile === "function" ? loginHomesFrom(await Promise.resolve(readFile("/etc/passwd", "utf8")).catch(() => "")) : [];
}
