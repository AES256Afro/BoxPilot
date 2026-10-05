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

// Every armoured private key: PKCS#8 and its ENCRYPTED form, RSA, EC, DSA, OpenSSH, and a PGP
// secret key block. Certificates and public keys say neither, and are left alone.
const keyMarker = (edge) => new RegExp(`-{4,5} ?${edge} (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)? ?-{4,5}`, "gi");
const redactedKey = "[REDACTED_PRIVATE_KEY]";

/**
 * Every private key in the text taken out whole (sweep 3). It runs on the whole text before anything
 * cuts it into pieces: a key whose BEGIN and END fell in different pieces used to go through
 * untouched. A key the text was clipped inside goes too - from its BEGIN to the end of the text when
 * the END was cut off, from the start of the text to its END when the BEGIN was. One pass, each
 * marker looked for once, so text full of markers cannot make it slow.
 */
export function redactPrivateKeys(input) {
  const text = String(input ?? "");
  if (!/PRIVATE KEY/i.test(text)) return text;
  const begin = keyMarker("BEGIN");
  const end = keyMarker("END");
  const next = (pattern, from) => { pattern.lastIndex = from; return pattern.exec(text); };
  let opening = next(begin, 0);
  let closing = next(end, 0);
  let out = "";
  let at = 0;
  for (;;) {
    if (opening && opening.index < at) opening = next(begin, at);
    if (closing && closing.index < at) closing = next(end, at);
    if (closing && (!opening || closing.index < opening.index)) {
      // An END with no BEGIN before it: the text starts inside a key.
      if (!out.endsWith(redactedKey)) out += redactedKey;
      at = closing.index + closing[0].length;
      continue;
    }
    if (!opening) return out + text.slice(at);
    out += text.slice(at, opening.index) + redactedKey;
    // A BEGIN with no END after it: the text was cut inside the key.
    if (!closing) return out;
    at = closing.index + closing[0].length;
  }
}

/**
 * A PuTTY key's private half: the base64 lines after `Private-Lines: N` (sweep 4). The public lines
 * and the MAC stay; neither is the key.
 */
const puttyPrivateLines = /(Private-Lines:[ \t]*\d+[ \t]*)(\r?\n)[ \t]*[A-Za-z0-9+/]+={0,2}[ \t]*(?:\r?\n[ \t]*[A-Za-z0-9+/]+={0,2}[ \t]*)*(?=\r?\n|$)/g;

function redactPuttyKeys(text) {
  return text.includes("Private-Lines:") ? text.replace(puttyPrivateLines, `$1$2${redactedKey}`) : text;
}

/**
 * The names a secret goes by in an assignment (NAME=value, name: value, "name":"value"). Any case: a
 * secret word anywhere in the name, as a word of its own or run on (RESTIC_PASSWORD, SERVERPASSWORD,
 * VIKUNJA_SERVICE_JWTSECRET), or a name ending in a word of its own that is only a secret at the end
 * (DB_PASS, PLEX_CLAIM). Upper case only, as environment variables are written: a name ending in _KEY
 * (APP_KEY, MEILI_MASTER_KEY) and PASS alone - in lower case `sort_key` and `pass` are ordinary words.
 * Every secret setting in the catalog is one of these; a test holds that to every manifest.
 */
const secretWords = "token|password|passphrase|passwd|secret|(?:api|access|private|master|encryption|signing|account|app)[_-]?key|authorization|cookie";
const anyCaseSecretName = `(?:[A-Za-z0-9]+[_.-])*[A-Za-z0-9]*?(?:${secretWords})(?:[_.-][A-Za-z0-9]+)*|(?:[A-Za-z0-9]+[_.-])+(?:pass|claim)`;
const envSecretName = "(?:[A-Z0-9]+_+)+KEY|PASS";
const assignment = new RegExp(`(?<![A-Za-z0-9])["']?(${anyCaseSecretName})["']?\\s*[:=]\\s*["']?([^\\s,;"']+)`, "gi");
const envAssignment = new RegExp(`(?<![A-Za-z0-9_])["']?(${envSecretName})["']?\\s*[:=]\\s*["']?([^\\s,;"']+)`, "g");
const secretNamePatterns = [new RegExp(`^(?:${anyCaseSecretName})$`, "i"), new RegExp(`^(?:${envSecretName})$`)];
const isSecretName = (name) => secretNamePatterns.some((pattern) => pattern.test(name));

/**
 * A YAML block scalar under a secret's name (`password: |` and the lines indented under it): the
 * assignment rule sees only the `|` (sweep 4).
 */
const yamlBlockHeader = /^([ \t]*)(?:-[ \t]+)?(["']?)([A-Za-z0-9_.-]+)\2[ \t]*:[ \t]*[|>][0-9+-]*[ \t]*(?:#[^\r\n]*)?\r?$/;

function redactYamlSecretBlocks(text) {
  if (!/:[ \t]*[|>]/.test(text)) return text;
  const lines = text.split("\n");
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index]);
    const header = yamlBlockHeader.exec(lines[index]);
    if (!header || !isSecretName(header[3])) continue;
    let last = index;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].trim()) continue;
      if (/^[ \t]*/.exec(lines[next])[0].length <= header[1].length) break;
      last = next;
    }
    if (last === index) continue;
    const first = lines.slice(index + 1).find((line) => line.trim());
    out.push(`${/^[ \t]*/.exec(first)[0]}[REDACTED]${lines[last].endsWith("\r") ? "\r" : ""}`);
    index = last;
  }
  return out.join("\n");
}

/**
 * A key's body with its BEGIN and END lines gone (sweep 4): a filter that picked only the body lines,
 * or text clipped on both sides. Three or more lines in a row whose last word is base64 as wide as a
 * key's lines (PEM 64, OpenSSH 70) - bare, or behind a journal or docker timestamp - and the shorter
 * line a key ends with (two full lines and that one is an EC key). A line counts towards the three
 * only when it reads like random bytes - capitals, small letters and digits - and a run mostly of
 * slash-ridden words is a path listing, so hex hashes and container ids, backup path listings,
 * certificates and public keys between their own BEGIN and END, and authorized_keys lines are left
 * alone. A run whose next marker is a certificate's or public key's END is that block's,
 * its BEGIN cut off in an earlier piece of the text. Each body line keeps its prefix; repeats of the
 * same redacted line are one.
 */
const redactedBody = "[REDACTED_KEY_BODY]";
const bodyWord = /(?:^|\s)([A-Za-z0-9+/]{60,76}={0,2})\s*$/;
const lastWord = /(?:^|\s)([A-Za-z0-9+/]{4,76}={0,2})\s*$/;
const publicArmourBegin = /-----BEGIN (?![A-Z0-9 ]*PRIVATE)[A-Z0-9 ]+-----/;
const sshPublicKeyLine = /(?:^|\s)(?:ssh|sk-ssh|ecdsa-sha2|sk-ecdsa-sha2)-[A-Za-z0-9@.-]+[ \t]+AAAA[A-Za-z0-9+/]*={0,2}\s*$/;
const looksRandom = (word) => /[A-Z]/.test(word) && /[a-z]/.test(word) && /[0-9]/.test(word);
// Four slashes in a key-width line of random base64 happen about once in fifty lines; in a path, always.
const looksLikePath = (word) => word.split("/").length > 4;
const looksLikeLastLine = (word) => word.endsWith("=") || (word.length >= 16 && /[A-Z]/.test(word) && /[a-z]/.test(word));

function wordAt(pattern, line) {
  const match = pattern.exec(line);
  if (!match) return null;
  return { word: match[1], at: match.index + (match[0].startsWith(match[1]) ? 0 : 1) };
}

function redactKeyBodies(input) {
  const text = String(input ?? "");
  if (!text.includes("\n") || !/[A-Za-z0-9+/]{60}/.test(text)) return text;
  const lines = text.split("\n");
  const body = [];
  const tail = [];
  let insidePublic = false;
  for (const line of lines) {
    let full = null;
    let short = null;
    if (/-----END /.test(line)) insidePublic = false;
    else if (/-----BEGIN /.test(line)) insidePublic = publicArmourBegin.test(line);
    else if (!insidePublic && !sshPublicKeyLine.test(line)) {
      full = wordAt(bodyWord, line);
      if (!full) short = wordAt(lastWord, line);
    }
    body.push(full);
    tail.push(short);
  }
  const insidePublicEnd = new Array(lines.length + 1).fill(false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/-----END /.test(lines[index])) insidePublicEnd[index] = !/PRIVATE/.test(lines[index]);
    else insidePublicEnd[index] = !/-----BEGIN /.test(lines[index]) && insidePublicEnd[index + 1];
  }
  const redacted = new Set();
  const replace = (index, { word, at }) => { lines[index] = `${lines[index].slice(0, at)}${redactedBody}${lines[index].slice(at + word.length)}`; redacted.add(index); };
  for (let start = 0; start < lines.length;) {
    if (!body[start]) { start += 1; continue; }
    let end = start;
    let random = 0;
    let paths = 0;
    for (; end < lines.length && body[end]; end += 1) {
      if (!looksRandom(body[end].word)) continue;
      random += 1;
      if (looksLikePath(body[end].word)) paths += 1;
    }
    const last = end < lines.length && tail[end] && looksLikeLastLine(tail[end].word) ? tail[end] : null;
    if (!insidePublicEnd[start] && paths * 2 <= random && (random >= 3 || (random >= 2 && last))) {
      for (let index = start; index < end; index += 1) replace(index, body[index]);
      if (last) replace(end, last);
    }
    start = end + 1;
  }
  if (!redacted.size) return text;
  return lines.filter((line, index) => !(redacted.has(index) && redacted.has(index - 1) && lines[index - 1] === line)).join("\n");
}

/**
 * Every secret in the text that spans lines, taken out of the whole text before anything cuts it into
 * pieces: armoured private keys (sweep 3), a PuTTY key's private lines, a YAML block scalar under a
 * secret's name, and a run of lines that can only be a key's body (sweep 4).
 */
export function redactSecretBlocks(input) {
  return redactKeyBodies(redactYamlSecretBlocks(redactPuttyKeys(redactPrivateKeys(input))));
}

/** A PEM block base64-encoded again (kubeconfig's client-key-data, a Kubernetes tls.key): kept only when it says it is public. */
function wrappedPem(value) {
  const head = Buffer.from(value.slice(0, 64), "base64").toString("latin1");
  return !/PRIVATE/i.test(head) && /^-----BEGIN (?:CERTIFICATE|TRUSTED CERTIFICATE|X509 CRL|PUBLIC KEY|RSA PUBLIC KEY|CERTIFICATE REQUEST|NEW CERTIFICATE REQUEST)-----/.test(head) ? value : redactedKey;
}

function redactString(input, policy) {
  let value = redactSecretBlocks(String(input).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " "))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    // HTTP Basic is base64 of user:password - the Zulip bot's key travels this way. Not a word in a
    // sentence ("Basic authentication"): a capital and lower-case letters alone are left as they are.
    .replace(/\b(?:[Bb]asic|BASIC)\s+(?![A-Z]?[a-z]+\b)[A-Za-z0-9+/]{8,}={0,2}/g, "Basic [REDACTED]")
    // Whatever the scheme, the credential after it in an Authorization header, however short.
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+(?!\[REDACTED\])[^\s,;"']+/gi, "$1$2 [REDACTED]")
    // Credentials that say what they are whatever surrounds them (sweep 4): a JWT, the token formats
    // of GitHub, Slack and Tailscale, an AWS access key id, a PEM block base64-wrapped again, and an
    // Ed25519 private key as one line of DER.
    .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]")
    .replace(/(?<![A-Za-z0-9_])(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1[REDACTED]")
    .replace(/(?<![A-Za-z0-9_])(github_pat_)[A-Za-z0-9_]{20,}/g, "$1[REDACTED]")
    .replace(/(?<![A-Za-z0-9_-])(xox[abeoprs]-|xapp-|tskey-)[A-Za-z0-9-]{8,}/g, "$1[REDACTED]")
    .replace(/(?<![A-Za-z0-9])(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, "$1[REDACTED]")
    .replace(/(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/]*={0,2}/g, wrappedPem)
    .replace(/(?<![A-Za-z0-9+/])MC4CAQAwBQYDK2V[uw]BCIEI[A-Za-z0-9+/]{20,}={0,2}/g, redactedKey)
    // A quoted JSON key, an env var with a prefix, and a value that runs to the end of the line
    // all had to be handled: {"password":"x"}, RESTIC_PASSWORD=x and `secret_access_key = x` were
    // each untouched, and those are three shapes this product's own logs and configs produce.
    .replace(assignment, "$1=[REDACTED]")
    .replace(envAssignment, "$1=[REDACTED]")
    // Credentials embedded in a URL are the value, not a field, whatever the scheme: postgres://,
    // mongodb+srv://, redis:// and amqp:// carry them as often as https:// does. The user stays.
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/)([^\s:/?#@"'<>]*):([^\s/?#"'<>]*)@/g, "$1$2:[REDACTED]@")
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
