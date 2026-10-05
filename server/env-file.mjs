/**
 * The service's environment file (/etc/boxpilot/boxpilot.env), read the way systemd reads an
 * EnvironmentFile=, so that whatever BoxPilot works out from it is what the service was started with.
 *
 * Each reader used to take the first `^KEY=` line literally. systemd does not: it drops carriage
 * returns, skips blank lines and comments, allows blanks before the key and around "=", and the last
 * line for a key wins. On a file with `BOXPILOT_PORT = 9000`, or 8787 with 9000 appended below it,
 * the System page's update health-checked 8787 and rolled back a version already running on the
 * database. The shell scripts read it the same way (env_value in scripts/boxpilot-upgrade.sh and
 * scripts/boxpilot-install.sh, boxpilot_env_value in scripts/boxpilot-doctor.sh).
 */
import { defaultWebPort } from "./firewall-profiles.mjs";

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const linePattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** One pair of matching quotes around the whole value comes off; anything else is the value. */
function unquote(value) {
  return value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0] ? value.slice(1, -1) : value;
}

/** Every key in the file and the value systemd gives it (its last line). Comments start with # or ;. */
export function parseEnvFile(text) {
  const values = new Map();
  for (const line of String(text ?? "").replaceAll("\r", "").split("\n")) {
    const match = linePattern.exec(line);
    if (match) values.set(match[1], unquote(match[2]));
  }
  return values;
}

/** The value systemd gives `key`, or undefined when the file has no line for it. */
export function envFileValue(text, key) {
  return parseEnvFile(text).get(key);
}

/**
 * BOXPILOT_PORT and BOXPILOT_HOST as the web service takes them (server/index.mjs parses the port
 * with parseInt), with its defaults when either is missing or unusable.
 */
export function webListenFromEnv(text) {
  const values = parseEnvFile(text);
  const port = Number.parseInt(values.get("BOXPILOT_PORT") ?? "", 10);
  return { webPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultWebPort, webHost: values.get("BOXPILOT_HOST") || "127.0.0.1" };
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
