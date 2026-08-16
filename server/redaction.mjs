import { lstat, readFile } from "node:fs/promises";

const defaultConfigPath = "/etc/boxpilot/redaction.json";
const sensitiveKey = /(?:authorization|cookie|credential|csrf|pass(?:word|phrase)?|private.?key|secret|session|token)/i;

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
    .replace(/\b(token|password|passphrase|secret|api[_-]?key|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
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
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    if (sensitiveKey.test(key)) return "[REDACTED_FIELD]";
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
