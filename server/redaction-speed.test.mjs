import { describe, expect, it } from "vitest";
import { fill, slowness } from "../test/hostile-text.mjs";
import { finalRedaction } from "./assistant/prompt.mjs";
import { createRedactor, redactionInternals, redactSecretBlocks } from "./redaction.mjs";

/**
 * Redaction runs synchronously on the web process's event loop over text anyone can write: container
 * logs, the journal, an agent's tool output, a model's answer, a chat message, a support bundle. It
 * was quadratic and worse on some of it (sweep 5): `token_token_...` took half a second at 4 KB and
 * eight times longer each time it doubled, so one crafted log line could stall BoxPilot for minutes.
 * Every rule, and the whole of redact() and finalRedaction(), is timed here on text made to be slow.
 */
const hostile = {
  // Names run together, as a secret's name might start at any word of them.
  "token_ repeated": (n) => fill("token_", n),
  "TOKEN_ repeated": (n) => fill("TOKEN_", n),
  "password_ repeated": (n) => fill("password_", n),
  "passwordpassword...": (n) => fill("password", n),
  "token_a. repeated": (n) => fill("token_a.", n),
  "a_ repeated": (n) => fill("a_", n),
  "A_ repeated": (n) => fill("A_", n),
  "a. repeated": (n) => fill("a.", n),
  "a- repeated": (n) => fill("a-", n),
  "A_A. repeated": (n) => fill("A_A.", n),
  "KEY_ repeated": (n) => fill("KEY_", n),
  "PASS_ repeated": (n) => fill("PASS_", n),
  "ABPASS repeated": (n) => fill("ABPASS", n),
  "a long name ending __": (n) => `${fill("token_", n - 9)}__: value`,
  "a long name before :": (n) => `${fill("a_", n - 12)}password: x`,
  // Assignments and their separators.
  "a= repeated": (n) => fill("a=", n),
  "key: repeated": (n) => fill("key: ", n),
  "pass= repeated": (n) => fill("pass=", n),
  "one long word then =": (n) => `${"x".repeat(n - 2)}=1`,
  "a name, then spaces": (n) => `password${" ".repeat(n - 9)}x`,
  "a name and =, then spaces": (n) => `password=${" ".repeat(n - 10)},`,
  "a name and colons": (n) => `password${fill(" : ", n - 8)}`,
  // Quotes.
  "quotes": (n) => fill("\"'", n),
  "double quotes": (n) => fill('"', n),
  "nested quotes": (n) => fill('"password":"\\"', n),
  "quoted names": (n) => fill('"password:', n),
  "single-quoted names": (n) => fill("'token=", n),
  "open double-quoted values": (n) => fill('password="', n),
  "open single-quoted values": (n) => fill("password='", n),
  "doubled single quotes": (n) => `password='${fill("''", n - 10)}`,
  "backslashes in quotes": (n) => `"PASSWORD=${fill("\\\\", n - 10)}`,
  "backslashes after a quoted name": (n) => `'PASS=${"\\".repeat(n - 6)}`,
  // Whitespace.
  "spaces": (n) => " ".repeat(n),
  "new lines": (n) => "\n".repeat(n),
  "spaces and tabs": (n) => `${fill(" \t", n - 1)}x`,
  // Base64 and keys.
  "base64": (n) => fill("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkrLw", n),
  "base64 words": (n) => fill("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkrLwQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3 ", n),
  "key-width lines": (n) => fill("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ab\n", n),
  "key-width lines and spaces": (n) => fill("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ab     \n", n),
  "short words then a new line": (n) => `${fill("AAAA ", n - 1)}\n`,
  "MIIB...": (n) => `M${fill("IIB", n - 1)}`,
  "a wrapped PEM's start": (n) => fill("LS0tLS1CRUdJTi", n),
  "BEGIN markers": (n) => fill("-----BEGIN PRIVATE KEY----- ", n),
  "almost BEGIN markers": (n) => fill("----- BEGIN A A A A ", n),
  "ssh key starts": (n) => fill("ssh-a ", n),
  "PuTTY private lines": (n) => `Private-Lines: 1\n${fill("AAAA\n", n - 17)}`,
  "PuTTY blank lines": (n) => `Private-Lines: 1\n${fill(" \n", n - 17)}`,
  "PuTTY markers": (n) => fill("Private-Lines: 1\nAAAA ", n),
  "YAML block headers": (n) => fill("password: |\n", n),
  "a YAML block's lines": (n) => `password: |\n${fill("  a\n", n - 12)}`,
  "YAML blocks": (n) => fill("password: |\n  x\n", n),
  // Authorization headers.
  "Authorization: repeated": (n) => fill("Authorization: ", n),
  "Authorization: Token repeated": (n) => fill("Authorization: Token ", n),
  "Digest parameters": (n) => `Authorization: Digest ${fill("a=b, ", n - 22)}`,
  "Digest open quotes": (n) => `Authorization: Digest ${fill('a="', n - 22)}`,
  "Digest escaped quotes": (n) => `Authorization: Digest ${fill('a=\\"b\\", ', n - 22)}`,
  "Digest bare parameters": (n) => `Authorization: Digest ${fill("a=b ", n - 22)}`,
  "a long name ending authorization": (n) => `${fill("a_", n - 13)}authorization`,
  "a long dotted name ending authorization": (n) => `${fill("a.", n - 20)}authorization: Basic`,
  "Basic repeated": (n) => fill("Basic ", n),
  "Bearer repeated": (n) => fill("Bearer ", n),
  // URLs and query strings.
  "a long URL user": (n) => `https://${fill("ab:", n - 9)}@`,
  "a long URL user with no colon": (n) => `https://${"a".repeat(n - 9)}@`,
  "schemes and colons": (n) => fill("a://b:", n),
  "schemes, users and passwords": (n) => fill("a://b:c", n),
  "a long dashed scheme": (n) => `${fill("a-", n - 3)}://`,
  "http:// repeated": (n) => fill("http://", n),
  "http://a repeated, then ?": (n) => `${fill("http://a", n - 2)} ?`,
  "a query of empty keys": (n) => `?${fill("key=&", n - 1)}`,
  "a query of one long name": (n) => `?${fill("a_b_c_", n - 1)}`,
  "&token repeated": (n) => fill("&token", n),
  "?amp; repeated": (n) => fill("?amp;", n),
  "an encoded query": (n) => `%3F${fill("token%3D%26", n - 3)}`,
  "encoded ? repeated": (n) => fill("%3Fa_", n),
  "webhook paths": (n) => fill("discord.com/api/webhooks/1/", n),
  "Slack hook paths": (n) => fill("hooks.slack.com/services/", n),
  // Flags and tokens.
  "--pass repeated": (n) => fill("--pass", n),
  "dashes then pass": (n) => `${fill("--", n - 4)}pass`,
  "--a- repeated": (n) => fill("--a-", n),
  "-- then a dashed word": (n) => `--${fill("a-", n - 2)}`,
  "--a repeated": (n) => fill("--a ", n),
  "JWT starts": (n) => fill("eyJabcdefgh.", n),
  "tskey- repeated": (n) => fill("tskey-", n),
  "ghp_ repeated": (n) => fill("ghp_", n),
};

const policy = { additionalLiterals: [], additionalPathPrefixes: [] };
const { redact } = createRedactor();
const redactor = createRedactor();

/** Every shape `apply` was too slow on, and why. */
function slowShapes(apply, options) {
  const slow = [];
  for (const [name, make] of Object.entries(hostile)) {
    const problem = slowness(apply, make, options);
    if (problem) slow.push(`${name}: ${problem}`);
  }
  return slow;
}

describe("redaction on text made to be slow (sweep 5)", () => {
  it("covers every rule there is", () => {
    expect(redactionInternals.stringRules.length).toBeGreaterThan(15);
    expect(redactionInternals.blockRules.length).toBe(4);
  });

  for (const [name, rule] of [...(redactionInternals.blockRules ?? []), ...(redactionInternals.stringRules ?? [])]) {
    it(`reads in linear time: ${name}`, () => {
      expect(slowShapes(rule)).toEqual([]);
    }, 60_000);
  }

  // Whole pipelines: every rule together, under 200 ms at 64 KiB on CI (a few milliseconds here).
  it("reads in linear time: redact()", () => {
    expect(slowShapes((text) => redact(text), { budgetMs: 200, floorMs: 40 })).toEqual([]);
  }, 120_000);

  it("reads in linear time: the string rules without the 4 KiB cut", () => {
    expect(slowShapes((text) => redactionInternals.redactString(text, policy), { budgetMs: 200, floorMs: 40 })).toEqual([]);
  }, 120_000);

  it("reads in linear time: finalRedaction(), and the multi-line rules over the whole text", () => {
    expect(slowShapes((text) => finalRedaction(text, redactor), { budgetMs: 200, floorMs: 40 })).toEqual([]);
    expect(slowShapes((text) => redactSecretBlocks(text), { budgetMs: 200, floorMs: 40 })).toEqual([]);
  }, 120_000);

  it("reads a long log in time that grows with it", () => {
    // Text that looks like a real log, a few MB of it: finalRedaction and the multi-line rules read
    // all of it, redact() its first 64 KiB.
    const line = (index) => `2026-10-05T06:41:${String(index % 60).padStart(2, "0")}Z app[42]: GET /api/items?page=${index}&token=FAKE${index} 200 in ${index % 97} ms user=owner password=FAKEpw${index}`;
    const log = (lines) => Array.from({ length: lines }, (_, index) => line(index)).join("\n");
    expect(slowness((text) => finalRedaction(text, redactor), (size) => log(Math.ceil(size / 4)), { budgetMs: 1_500, floorMs: 100 })).toBeNull();
    expect(slowness((text) => redact(text), (size) => log(Math.ceil(size / 4)), { budgetMs: 200, floorMs: 40 })).toBeNull();
  }, 120_000);
});

describe("how much of one string redact() reads (sweep 5)", () => {
  const { scanLimit } = redactionInternals;

  it("reads the first 64 KiB, cut at a space or a line end, and nothing after it", () => {
    const filler = fill("GET /health 200\n", scanLimit + 1_000);
    expect(redact(`${filler}password=FAKEpastTheCut`)).toBe(filler.slice(0, 4096));
    // A cut at a space: no word is cut in two, so no piece of a token is left to pass for none. Here
    // a query string redacts away nearly all of the 64 KiB, and a JWT starts just before the cut: cut
    // where it fell, "eyJhbGciOiJIUzI1NiJ9.eyJzd" would be no JWT and come out as it is.
    const before = `https://example.test/feed?${"q".repeat(scanLimit - 202)} ${"word ".repeat(30)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignature";
    expect(before.length).toBeLessThan(scanLimit);
    expect(before.length + jwt.length).toBeGreaterThan(scanLimit);
    expect(redact(`${before}${jwt} after`)).toBe(`https://example.test/feed?[query-redacted] ${"word ".repeat(30).trim()}`);
  });

  it("still takes every key out of the whole text first, however long", () => {
    const key = (index) => `-----BEGIN PRIVATE KEY-----\n${fill(`FAKE${index}keybody`, 64 * 25)}\n-----END PRIVATE KEY-----`;
    const keys = Array.from({ length: 60 }, (_, index) => key(index)).join("\n");
    expect(keys.length).toBeGreaterThan(scanLimit);
    expect(redact(`${keys}\npassword=FAKEafterTheKeys`)).toBe(`${"[REDACTED_PRIVATE_KEY]\n".repeat(60)}password=[REDACTED]`);
  });

  it("reads text under the limit whole", () => {
    // 63 KiB that redacts to under 1 KiB, and the secret at its end still goes.
    const text = `${`${"https://example.test/feed?q=FAKE".padEnd(4_000, "q")} `.repeat(16)}token=FAKElast`;
    expect(text.length).toBeLessThan(scanLimit);
    expect(redact(text)).toBe(`${"https://example.test/feed?[query-redacted] ".repeat(16)}token=[REDACTED]`);
  });
});

/**
 * The rules rewritten for speed read text exactly as the regular expressions they replaced did: the
 * expressions are kept here, and both are run on many short random texts made of the pieces those
 * rules care about (on short text the expressions are quick enough).
 */
describe("the rewritten rules read text as the expressions they replaced (sweep 5)", () => {
  const secretWords = "token|password|passphrase|passwd|secret|(?:api|access|private|master|encryption|signing|account|app)[_-]?key|authorization|cookie";
  const anyCaseName = `(?:[A-Za-z0-9]+[_.-])*[A-Za-z0-9]*?(?:${secretWords})(?:[_.-][A-Za-z0-9]+)*|(?:[A-Za-z0-9]+[_.-])+(?:pass|claim|pwd|credentials?)`;
  const envName = "(?:[A-Z0-9]+_+)+KEY|PASS|(?:[A-Z0-9]+_+)*(?!(?:BY|COM|ENCOM|SUR|TRES|OVER|UNDER|HIGH|LOW|BAND|ALL|NOTCH|MULTI|ONE|TWO|SINGLE|DOUBLE|FIRST|SECOND|NO)PASS(?![A-Za-z0-9_]))[A-Z0-9]+PASS";
  const authorizationName = "(?:[A-Za-z0-9]+[_.-]){0,3}authorization";
  const authSchemes = "Basic|Bearer|Digest|Token|ApiKey|Api-Key|Key|Bot|SSWS|Negotiate|NTLM|OAuth|HOBA|Mutual|SCRAM-SHA-1|SCRAM-SHA-256|vapid|DPoP|GenieKey|Splunk|Hawk|AWS4-HMAC-SHA256|AWS";
  const authorizationDone = String.raw`(?!["']?${authorizationName}["']?\s*[:=]\s*["']?(?:${authSchemes})[ \t]+(?:\[REDACTED\]|[A-Za-z][\w-]*[ \t]*=[ \t]*(?:\\?"|[^\s,"'\\=])))`;
  const quotedValue = String.raw`"(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\r\n]|'')*'?`;
  const assignmentRule = (name, flags, notAfter, skip = "") => new RegExp(String.raw`(?<![${notAfter}])${skip}(?:(["'])(${name})\s*[:=]\s*(?:(?!\1)[^\\\r\n]|\\.)*|["']?(${name})["']?\s*[:=]\s*(?:${quotedValue}|[^\s,;"']+))`, flags);
  const redactAssignment = (_match, quote, quotedName, name) => (quote ? `${quote}${quotedName}=[REDACTED]` : `${name}=[REDACTED]`);
  const before = {
    assignment: (text) => text.replace(assignmentRule(anyCaseName, "gi", "A-Za-z0-9", authorizationDone), redactAssignment),
    "environment assignment": (text) => text.replace(assignmentRule(envName, "g", "A-Za-z0-9_"), redactAssignment),
    "flag value": (text) => text.replace(/(--[A-Za-z0-9-]*(?:pass|password|secret|token|key)[A-Za-z0-9-]*)(\s+|=)(?!-)[^\s]+/gi, "$1$2[REDACTED]"),
    "url query": (text) => text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[query-redacted]"),
  };
  const secretName = [new RegExp(`^(?:${anyCaseName})$`, "i"), new RegExp(`^(?:${envName})$`)];

  const pieces = [
    "token", "TOKEN", "Token", "password", "PASSWORD", "pass", "PASS", "passwd", "passphrase", "secret", "api", "key", "KEY", "api_key", "API_KEY", "app-key", "app.key",
    "access", "private", "master", "claim", "pwd", "PWD", "credential", "credentials", "authorization", "Authorization", "cookie", "BY", "COM", "ENCOM", "NO", "BYPASS", "x",
    "X", "a", "A", "1", "DB", "SERVER", "JWT", "_", "_", "_", ".", "-", "-", "__", "--", '"', '"', "'", "'", ":", ":", "=", "=", " ", "  ", "\t", "\n", "\r\n", ",", ";",
    "\\", '\\"', "''", "Basic", "Bearer", "Digest", "Token ", "[REDACTED]", "nonce=", "http://", "https://", "HTTP://", "?", "&", "@", "/", "://", "#",
  ];
  // A seeded generator, so a failure names a text that fails again.
  let seed = 20261005;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const texts = Array.from({ length: 20_000 }, () => Array.from({ length: 1 + Math.floor(random() * 20) }, () => pieces[Math.floor(random() * pieces.length)]).join(""));
  const rules = Object.fromEntries(redactionInternals.stringRules ?? []);

  for (const [name, expression] of Object.entries(before)) {
    it(`reads as it did: ${name}`, () => {
      const differ = texts.filter((text) => rules[name](text) !== expression(text));
      expect(differ.slice(0, 5)).toEqual([]);
      // And the case is not empty: the rule redacted something in many of the texts.
      expect(texts.filter((text) => expression(text) !== text).length).toBeGreaterThan(100);
    });
  }

  it("reads a YAML block's name as it did", () => {
    const names = texts.map((text) => text.replace(/[^A-Za-z0-9_.-]/g, "")).filter(Boolean);
    const differ = names.filter((name) => redactionInternals.isSecretName(name) !== secretName.some((pattern) => pattern.test(name)));
    expect(differ.slice(0, 5)).toEqual([]);
    expect(names.filter((name) => redactionInternals.isSecretName(name)).length).toBeGreaterThan(100);
  });
});
