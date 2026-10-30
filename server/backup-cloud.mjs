/**
 * Cloud backup destination (rclone). Shared validator for the web service and the root
 * tasks. Secrets (keys, tokens, passwords) are written only into the root-only rclone
 * configuration by the setup task; the settings store keeps the non-secret description.
 */
export const cloudProviders = Object.freeze({
  b2: { label: "Backblaze B2", fields: ["account", "bucket", "path"], secrets: ["key", "passphrase"], help: "Create an application key in Backblaze (Account → App Keys). Account = the key ID, key = the application key." },
  s3: { label: "S3-compatible (AWS, Wasabi, MinIO, Cloudflare R2)", fields: ["endpoint", "region", "bucket", "path", "accessKeyId"], secrets: ["secretAccessKey", "passphrase"], help: "For AWS leave the endpoint empty and set the region. For Wasabi, R2, MinIO, or another S3 service, set their endpoint URL." },
  webdav: { label: "WebDAV (Nextcloud, Hetzner Storage Box, ...)", fields: ["url", "user", "path"], secrets: ["password", "passphrase"], help: "The WebDAV URL of your account, for example https://cloud.example.com/remote.php/dav/files/USERNAME/." },
  drive: { label: "Google Drive", fields: ["path"], secrets: ["token", "passphrase"], help: "On any computer with rclone, run: rclone authorize \"drive\". Sign in, then paste the token it prints (starts with {\"access_token\")." },
  onedrive: { label: "Microsoft OneDrive", fields: ["path"], secrets: ["token", "passphrase"], help: "On any computer with rclone, run: rclone authorize \"onedrive\". Sign in, then paste the token it prints." },
  dropbox: { label: "Dropbox", fields: ["path"], secrets: ["token", "passphrase"], help: "On any computer with rclone, run: rclone authorize \"dropbox\". Sign in, then paste the token it prints." },
});
export const cloudProviderIds = Object.freeze(Object.keys(cloudProviders));

/**
 * The mirror is encrypted before it leaves the server. Application backups carry each app's .env (its generated
 * passwords, session secrets and data keys) next to the data those keys seal, and machine snapshots carry every
 * app's settings, so a plain copy in a bucket was the whole server for whoever reads the bucket. rclone's crypt
 * remote wraps the provider's: contents encrypted (XSalsa20-Poly1305) under the owner's passphrase, names left
 * readable so the bucket still shows which backup is which. The passphrase is kept obscured in the root-only
 * rclone.conf for the nightly copy; the owner keeps it off this server too, or the copies cannot be read after
 * a loss of this server.
 */
export const sealedRemote = "boxpilot-sealed";
export const minimumPassphraseLength = 12;
/** Where the sealed copies go, beside (never over) anything an older plain mirror left in the folder. */
export const sealedFolder = "sealed";
export function sealedTarget() { return `${sealedRemote}:`; }
/** Whether a saved rclone.conf has the encrypted remote the mirror writes through. */
export function isSealedConfig(text) {
  return new RegExp(`^\\[${sealedRemote}\\]\\ntype = crypt$`, "m").test(String(text ?? ""));
}

const patterns = {
  account: /^[A-Za-z0-9_-]{1,64}$/,
  bucket: /^[a-z0-9][a-z0-9.-]{1,62}$/,
  path: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/,
  endpoint: /^https?:\/\/[^\s]{1,200}$/,
  region: /^[a-z0-9-]{1,32}$/,
  accessKeyId: /^[A-Za-z0-9_-]{1,128}$/,
  url: /^https:\/\/[^\s]{1,300}$/,
  user: /^[^\s:]{1,128}$/,
};

/** Validate the non-secret part of a destination. Returns an error list. */
export function validateCloudDestination(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["A destination object is required"];
  const provider = cloudProviders[value.provider];
  if (!provider) return [`provider must be one of ${cloudProviderIds.join(", ")}`];
  for (const field of provider.fields) {
    const raw = value[field];
    const optional = field === "endpoint" || field === "region" || field === "path";
    if ((raw === undefined || raw === null || raw === "") && optional) continue;
    if (typeof raw !== "string" || !patterns[field].test(raw) || (field === "path" && raw.includes(".."))) errors.push(`${field} is invalid`);
  }
  if (value.provider === "s3" && !value.endpoint && !value.region) errors.push("set a region (AWS) or an endpoint (other S3 services)");
  return errors;
}

export function normalizeCloudDestination(value) {
  const errors = validateCloudDestination(value);
  if (errors.length) throw new Error(errors.join("; "));
  const provider = cloudProviders[value.provider];
  const out = { provider: value.provider };
  for (const field of provider.fields) out[field] = typeof value[field] === "string" && value[field] !== "" ? value[field].replace(/\/+$/, "") || value[field] : null;
  if (out.path === null) out.path = "boxpilot";
  return out;
}

/** The rclone remote section for a destination plus its secrets. Pure. */
export function renderRcloneConfig(destination, secrets = {}) {
  // The owner makes the bucket; BoxPilot only copies into it. Without this rclone checks the bucket
  // exists before writing and creates it when it thinks it does not, and both are bucket-level calls
  // that a key scoped to one bucket may not make -- which is the scoping the help text here asks
  // for. A Cloudflare R2 token with Object Read & Write failed `rclone mkdir` with 403 AccessDenied
  // while `lsf` of the same bucket with the same keys listed it, and the same mkdir passed with the
  // check off. Nothing here wants a bucket created for it.
  const lines = ["# Managed by BoxPilot", "[boxpilot]"];
  switch (destination.provider) {
    case "b2":
      lines.push("type = b2", `account = ${destination.account}`, `key = ${secrets.key ?? ""}`, "no_check_bucket = true");
      break;
    case "s3":
      lines.push("type = s3", `provider = ${destination.endpoint ? "Other" : "AWS"}`, `access_key_id = ${destination.accessKeyId}`, `secret_access_key = ${secrets.secretAccessKey ?? ""}`, ...(destination.endpoint ? [`endpoint = ${destination.endpoint}`] : []), ...(destination.region ? [`region = ${destination.region}`] : []), "acl = private", "no_check_bucket = true");
      break;
    case "webdav":
      lines.push("type = webdav", `url = ${destination.url}`, "vendor = other", `user = ${destination.user}`, `pass = ${secrets.passwordObscured ?? ""}`);
      break;
    default:
      lines.push(`type = ${destination.provider}`, `token = ${secrets.token ?? ""}`);
  }
  if (secrets.passphraseObscured) {
    lines.push("", `[${sealedRemote}]`, "type = crypt", `remote = ${cloudTarget(destination)}/${sealedFolder}`, "filename_encryption = off", "directory_name_encryption = false", `password = ${secrets.passphraseObscured}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The rclone target (remote:bucket/path) for a destination. */
export function cloudTarget(destination) {
  const base = destination.provider === "b2" || destination.provider === "s3" ? `${destination.bucket}/` : "";
  return `boxpilot:${base}${destination.path ?? "boxpilot"}`;
}

/** Parse the `Transferred:` lines rclone prints at the end of a transfer. */
export function parseRcloneStats(output) {
  const text = String(output ?? "");
  const files = text.match(/Transferred:\s+(\d+) \/ (\d+)/);
  const bytes = text.match(/Transferred:\s+([\d.]+\s*[KMGT]?i?B)/);
  const errors = text.match(/Errors:\s+(\d+)/);
  return { filesTransferred: files ? Number(files[1]) : 0, filesTotal: files ? Number(files[2]) : 0, bytesTransferred: bytes ? bytes[1].replace(/\s+/g, " ") : null, errors: errors ? Number(errors[1]) : 0 };
}
