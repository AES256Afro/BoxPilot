/**
 * The service's environment file (/etc/boxpilot/boxpilot.env), read the way systemd reads an
 * EnvironmentFile=, so that whatever BoxPilot works out from it is what the service was started with.
 *
 * Each reader used to take the first `^KEY=` line literally. systemd does not: it drops carriage
 * returns, skips blank lines and comments, allows blanks before the key and around "=", and the last
 * line for a key wins. On a file with `BOXPILOT_PORT = 9000`, or 8787 with 9000 appended below it,
 * the System page's update health-checked 8787 and rolled back a version already running on the
 * database. Nor does it know inline comments: `BOXPILOT_PORT=9000   # moved off 8787` gives the
 * service that whole string, and `BOXPILOT_PORT="9000" # web` gives it `9000# web`. The service
 * takes the port with parseInt (9000 both times), so the readers do too (webPortOf).
 *
 * The shell scripts carry the same parser in awk (env_file_value in scripts/boxpilot-upgrade.sh and
 * scripts/boxpilot-install.sh, boxpilot_env_file_value in scripts/boxpilot-doctor.sh), and
 * tests/ubuntu/env-file-parity.sh checks all of them against systemd itself.
 */
import { defaultWebPort } from "./firewall-profiles.mjs";

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const newlines = "\n\r";
const blanks = " \t\n\r";
// What a backslash escapes inside double quotes; before anything else it is kept.
const doubleQuoteEscapes = "\"\\`$";

/**
 * Every key in the file and the value systemd gives it: parse_env_file_internal() in systemd's
 * src/basic/env-file.c (the same in 255, Ubuntu 24.04's, and 259, 26.04's), then what
 * load_env_file() and the unit's environment make of it: the last assignment to a key wins, and one
 * whose name is not a variable name (`export KEY=...`, a blank inside) is dropped.
 *
 * In short: CR and LF both end a line. A line whose first non-blank is # or ; is a comment; a #
 * anywhere else is part of the value. Blanks before the key, around "=" and after an unquoted value
 * are dropped. A value that starts with ' or " runs to the matching quote, over lines if need be,
 * and what follows the closing quote runs on into the value (blanks right after it dropped); a
 * quote anywhere else is an ordinary character. Outside quotes a backslash keeps the next character
 * and joins the next line on.
 */
export function parseEnvFile(text) {
  const values = new Map();
  let state = "preKey";
  let key = "";
  let value = "";
  // How much of the value stays when its line ends: the blanks after an unquoted value go.
  let kept = 0;
  const add = (characters) => { value += characters; kept = value.length; };
  const push = () => {
    const name = key.replace(/[ \t]+$/, "");
    if (keyPattern.test(name)) values.set(name, value.slice(0, kept));
    key = ""; value = ""; kept = 0;
  };
  for (const c of String(text ?? "")) {
    switch (state) {
      case "preKey":
        if (c === "#" || c === ";") state = "comment";
        else if (!blanks.includes(c)) { state = "key"; key = c; }
        break;
      case "key":
        if (newlines.includes(c)) state = "preKey";
        else if (c === "=") { state = "preValue"; value = ""; kept = 0; }
        else key += c;
        break;
      case "preValue":
        if (newlines.includes(c)) { push(); state = "preKey"; }
        else if (c === "'") state = "single";
        else if (c === '"') state = "double";
        else if (c === "\\") state = "escape";
        else if (!blanks.includes(c)) { state = "value"; add(c); }
        break;
      case "value":
        if (newlines.includes(c)) { push(); state = "preKey"; }
        else if (c === "\\") { state = "escape"; kept = value.length; }
        else if (blanks.includes(c)) value += c;
        else add(c);
        break;
      case "escape":
        state = "value";
        if (!newlines.includes(c)) add(c);
        break;
      case "single":
        if (c === "'") state = "preValue";
        else add(c);
        break;
      case "double":
        if (c === '"') state = "preValue";
        else if (c === "\\") state = "doubleEscape";
        else add(c);
        break;
      case "doubleEscape":
        state = "double";
        if (doubleQuoteEscapes.includes(c)) add(c);
        else if (c !== "\n") add(`\\${c}`);
        break;
      case "comment":
        if (c === "\\") state = "commentEscape";
        else if (newlines.includes(c)) state = "preKey";
        break;
      case "commentEscape":
        // Since systemd 254 a comment ending in a backslash no longer runs on into the next line.
        state = newlines.includes(c) ? "preKey" : "comment";
        break;
    }
  }
  if (!["preKey", "key", "comment", "commentEscape"].includes(state)) push();
  return values;
}

/** The value systemd gives `key`, or undefined when the file has no line for it. */
export function envFileValue(text, key) {
  return parseEnvFile(text).get(key);
}

/**
 * The port the web service listens on for a BOXPILOT_PORT value (server/index.mjs): parseInt's
 * reading of it, as the service has always taken it, so `9000   # moved off 8787` is 9000; 8787 when
 * there is none or it is no port. The agents runner, the upgrade, the installer and the doctor take
 * it the same way.
 */
export function webPortOf(value) {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultWebPort;
}

/**
 * The address it listens on for a BOXPILOT_HOST value: loopback when there is none, and when it is
 * empty. An empty one used to mean every address (listen(port, "")) while every reader of the env
 * file said loopback, so the firewall's advice never warned that the LAN could reach it. Loopback is
 * the safe one to agree on: nothing BoxPilot writes is empty (0.0.0.0 is how the LAN is chosen).
 */
export function webHostOf(value) {
  return value || "127.0.0.1";
}

/** BOXPILOT_PORT and BOXPILOT_HOST from the env file's text, as the web service takes them. */
export function webListenFromEnv(text) {
  const values = parseEnvFile(text);
  return { webPort: webPortOf(values.get("BOXPILOT_PORT")), webHost: webHostOf(values.get("BOXPILOT_HOST")) };
}

/**
 * Set `key` to `value` in the file's text: every line for the key, however it is written, becomes
 * KEY=value (rewriting only the first of two left the other in force), and it is appended when there
 * is none. Comments and a CRLF file's line endings are left as they were. Like the installer's set_env.
 */
export function setEnvValue(text, key, value) {
  if (!keyPattern.test(key)) throw new Error(`${key} is not a variable name`);
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "gm");
  if (pattern.test(text)) return text.replace(pattern, () => line);
  return `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}
