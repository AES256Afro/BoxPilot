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
