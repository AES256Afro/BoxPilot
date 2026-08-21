/**
 * Off-box backup destination over SSH (M6.2): a host, port, user, and absolute path that
 * rsync pushes the local backup roots to, authenticated with a key BoxPilot generates.
 * Shared by the web service (settings) and the root tasks (they re-validate).
 */
export const destinationPatterns = Object.freeze({
  host: /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/,
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  path: /^\/[A-Za-z0-9._/-]{1,200}$/,
});

export function validateDestination(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["A destination object is required"];
  if (typeof value.host !== "string" || !destinationPatterns.host.test(value.host)) errors.push("host must be a host name or IP address");
  const port = value.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("port must be between 1 and 65535");
  if (typeof value.user !== "string" || !destinationPatterns.user.test(value.user)) errors.push("user must be a Unix user name");
  if (typeof value.path !== "string" || !destinationPatterns.path.test(value.path) || value.path.includes("..")) errors.push("path must be absolute, without spaces or '..'");
  return errors;
}

export function normalizeDestination(value) {
  const errors = validateDestination(value);
  if (errors.length) throw new Error(errors.join("; "));
  return { host: value.host, port: value.port ?? 22, user: value.user, path: value.path.replace(/\/+$/, "") || "/" };
}
