import { lstat, readFile } from "node:fs/promises";

const defaultConfigPath = "/etc/boxpilot/redaction.json";
// Field names whose value is never worth printing. Written to catch the names this product
// actually uses — rclone's `key`, `secret_access_key` and `pass`, restic's password, ntfy and
// Gotify tokens — as well as the obvious ones.
const sensitiveKey = /(?:auth(?:orization)?|cookie|credential|csrf|pass(?:word|phrase|wd)?(?![a-z])|(?:private|api|access|recovery|secret)[_.-]?key|^key$|secret|session|token)/i;

function validLiteral(value) {
  return typeof value === "string" && value.length >= 4 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPrefix(value) {
  return typeof value === "string" && value.startsWith("/") && value.length >= 2 && value.length <= 256 && !/[\u0000-\u001f\u007f*?{}[\]]/.test(value);
}

export function parseRedactionConfig(contents) {
  let parsed;
  try { parsed = JSON.parse(contents); } catch { return { status: "invalid", additionalLiterals: [], additionalPathPrefixes: [] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => !["additionalLiterals", "additionalPathPrefixes"].includes(key))) {
    return { status: "invalid", additionalLiterals: [], additionalPathPrefixes: [] };
  }
  const literals = Array.isArray(parsed.additionalLiterals) ? parsed.additionalLiterals : [];
  const prefixes = Array.isArray(parsed.additionalPathPrefixes) ? parsed.additionalPathPrefixes : [];
  if (literals.length > 32 || prefixes.length > 32 || literals.some((item) => !validLiteral(item)) || prefixes.some((item) => !validPrefix(item))) {
    return { status: "invalid", additionalLiterals: [], additionalPathPrefixes: [] };
  }
  return { status: "loaded", additionalLiterals: [...new Set(literals)], additionalPathPrefixes: [...new Set(prefixes)] };
}

export async function loadRedactionPolicy({ configPath = process.env.BOXPILOT_REDACTION_CONFIG ?? defaultConfigPath, read = readFile, inspect = lstat } = {}) {
  if (configPath !== defaultConfigPath) return { status: "invalid-path", additionalLiterals: [], additionalPathPrefixes: [] };
  try {
    const metadata = await inspect(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 || (metadata.mode & 0o022) !== 0) return { status: "invalid-file", additionalLiterals: [], additionalPathPrefixes: [] };
    return parseRedactionConfig(await read(configPath, "utf8"));
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "default" : "unavailable", additionalLiterals: [], additionalPathPrefixes: [] };
  }
}

function redactString(input, policy) {
  let value = String(input)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    // A quoted JSON key, an env var with a prefix, and a value that runs to the end of the line
    // all had to be handled: {"password":"x"}, RESTIC_PASSWORD=x and `secret_access_key = x` were
    // each untouched, and those are three shapes this product's own logs and configs produce.
    .replace(/(?<![A-Za-z0-9])["']?((?:[A-Za-z0-9]+[_.-])*(?:token|password|passphrase|passwd|secret|api[_-]?key|access[_-]?key|authorization|cookie)(?:[_.-][A-Za-z0-9]+)*)["']?\s*[:=]\s*["']?([^\s,;"']+)/gi, "$1=[REDACTED]")
    // Credentials embedded in a URL (https://user:pass@host) are the value, not a field.
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    // A command-line flag takes its value as the next argument: rclone and restic are invoked in
    // exactly this shape, and the key/value rule above cannot see it.
    .replace(/(--[A-Za-z0-9-]*(?:pass|password|secret|token|key)[A-Za-z0-9-]*)(\s+|=)(?!-)[^\s]+/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[query-redacted]");
  for (const literal of policy.additionalLiterals) value = value.split(literal).join("[REDACTED_LITERAL]");
  for (const prefix of policy.additionalPathPrefixes) value = value.split(prefix).join("[REDACTED_PATH]");
  return value.slice(0, 4096);
}

export function createRedactor(policy = { status: "default", additionalLiterals: [], additionalPathPrefixes: [] }) {
  const normalized = {
    status: policy.status ?? "default",
    additionalLiterals: Array.isArray(policy.additionalLiterals) ? policy.additionalLiterals : [],
    additionalPathPrefixes: Array.isArray(policy.additionalPathPrefixes) ? policy.additionalPathPrefixes : [],
  };

  function redact(input, key = "", depth = 0, seen = new WeakSet()) {
    // A boolean cannot be a credential, and flags like `credentialsIncluded: false` are exactly
    // the kind of diagnostic a support bundle exists to carry. A number can be one — a PIN, a
    // numeric token — so numbers are judged by their field name like strings are.
    if (input === null || typeof input === "boolean") return input;
    if (sensitiveKey.test(key)) return "[REDACTED_FIELD]";
    if (typeof input === "number") return input;
    if (typeof input === "string") return redactString(input, normalized);
    if (depth >= 12) return "[REDACTED_DEPTH_LIMIT]";
    if (Array.isArray(input)) return input.slice(0, 500).map((item) => redact(item, "", depth + 1, seen));
    if (typeof input === "object") {
      if (seen.has(input)) return "[REDACTED_CYCLE]";
      seen.add(input);
      const result = {};
      for (const [childKey, value] of Object.entries(input).slice(0, 500)) result[childKey] = redact(value, childKey, depth + 1, seen);
      return result;
    }
    return "[REDACTED_UNSUPPORTED]";
  }

  function metadata() {
    return {
      status: normalized.status,
      builtInSecretFields: true,
      builtInAssignmentPatterns: true,
      urlQueryRedaction: true,
      privateKeyRedaction: true,
      additionalLiteralCount: normalized.additionalLiterals.length,
      additionalPathPrefixCount: normalized.additionalPathPrefixes.length,
      configuredValuesIncluded: false,
    };
  }

  return { redact, metadata };
}

export const redactionInternals = { defaultConfigPath, redactString, sensitiveKey, validLiteral, validPrefix };
