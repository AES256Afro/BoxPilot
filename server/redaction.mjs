/**
 * BoxPilot's redaction policy: the owner's extra literals and path prefixes, from one root-owned
 * file. The rules themselves are the harness's (packages/harness/src/safety/redaction.mjs).
 */
import { lstat, readFile } from "node:fs/promises";
import { redactionRules } from "../packages/harness/src/index.mjs";

export { createRedactor, redactPrivateKeys, redactSecretBlocks } from "../packages/harness/src/index.mjs";

const defaultConfigPath = "/etc/boxpilot/redaction.json";

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

export const redactionInternals = { ...redactionRules, defaultConfigPath, validLiteral, validPrefix };
