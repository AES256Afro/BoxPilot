#!/usr/bin/env node
/**
 * Every reader of the service's env file against systemd itself. Run as root by
 * tests/ubuntu/env-file-parity.sh; it only starts transient units and writes a scratch directory.
 *
 * For each file in the table, a transient unit (systemd-run --wait --pipe) is started with
 * EnvironmentFile= on it and says what systemd gave it for BOXPILOT_PORT and BOXPILOT_HOST. The web
 * service listens on parseInt of that port (8787 when it is no port) and on that address (loopback
 * when there is none, or it is empty). Every reader must say the same:
 *
 *   - the web service's own functions (server/index.mjs takes them from server/env-file.mjs), and the
 *     agents runner's address for BoxPilot, both worked out inside the unit, from what systemd gave;
 *   - server/env-file.mjs reading the file (the firewall's protected port, Settings' LAN switch, the
 *     controller doctor), which must also give the same raw values systemd gives;
 *   - the shell readers in scripts/boxpilot-upgrade.sh (the System page's update health check),
 *     scripts/boxpilot-install.sh and scripts/boxpilot-doctor.sh, under sh, with mawk (a server's
 *     awk) and with gawk (the runner's).
 *
 * Then seeded random files over a small alphabet of the characters that matter (=, #, ;, quotes,
 * backslash, blanks, CR, LF): systemd's values for two keys against server/env-file.mjs and the
 * shell scripts' parser, byte for byte.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), "../..");
const { parseEnvFile, webHostOf, webListenFromEnv, webPortOf } = await import(pathToFileURL(path.join(root, "server/env-file.mjs")).href);

// Inside the transient unit: what systemd gave it, and what the web service and the runner make of it.
if (process.argv[2] === "--inside") {
  const keys = process.argv.slice(3);
  const given = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
  if (!keys.includes("BOXPILOT_PORT")) { process.stdout.write(JSON.stringify({ given })); process.exit(0); }
  const { runnerApiBase } = await import(pathToFileURL(path.join(root, "server/agents/runner.mjs")).href);
  process.stdout.write(JSON.stringify({ given, service: { port: webPortOf(process.env.BOXPILOT_PORT), host: webHostOf(process.env.BOXPILOT_HOST) }, runner: runnerApiBase(process.env) }));
  process.exit(0);
}

const work = mkdtempSync(path.join(os.tmpdir(), "bp-env-parity-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
let written = 0;
const fileWith = (text) => { const file = path.join(work, `${(written += 1)}.env`); writeFileSync(file, text); return file; };

function fromSystemd(file, keys) {
  const result = spawnSync("systemd-run", ["--quiet", "--wait", "--pipe", "--collect", "-p", `EnvironmentFile=${file}`, process.execPath, self, "--inside", ...keys], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`systemd-run exited ${result.status}: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

// The shell readers, taken out of the scripts as they ship, each printing the port it works out, a
// newline, and the address it read (empty when none).
const scriptText = (file) => readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
const shellFunction = (text, name) => {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(text);
  if (!match) throw new Error(`no ${name}() in the script`);
  return match[0];
};
const upgrade = scriptText("scripts/boxpilot-upgrade.sh");
const install = scriptText("scripts/boxpilot-install.sh");
const doctor = scriptText("scripts/boxpilot-doctor.sh");
const shellReaders = {
  "boxpilot-upgrade.sh": [shellFunction(upgrade, "env_file_value"), shellFunction(upgrade, "env_value"), shellFunction(upgrade, "port_of"),
    'ENV_FILE="$1"', `printf '%s\\n%s' "$(port_of "$(env_value BOXPILOT_PORT)")" "$(env_value BOXPILOT_HOST)"`].join("\n"),
  "boxpilot-install.sh": [shellFunction(install, "env_file_value"), shellFunction(install, "env_value"), shellFunction(install, "port_of"),
    'ENV_FILE="$1"', `printf '%s\\n%s' "$(port_of "$(env_value BOXPILOT_PORT)")" "$(env_value BOXPILOT_HOST)"`].join("\n"),
  "boxpilot-doctor.sh": [shellFunction(doctor, "boxpilot_env_file_value"), shellFunction(doctor, "boxpilot_env_value"), shellFunction(doctor, "boxpilot_port_of"),
    'boxpilot_env_file="$1"', `printf '%s\\n%s' "$(boxpilot_port_of "$(boxpilot_env_value BOXPILOT_PORT)")" "$(boxpilot_env_value BOXPILOT_HOST)"`].join("\n"),
};
// Under every awk this machine has. A server's `awk` is Ubuntu's own, mawk (Priority: required);
// GitHub's runner images put gawk in front of it, so without this only gawk would ever be tried.
const awks = ["mawk", "gawk"].flatMap((name) => {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  if (!found) return [];
  const directory = path.join(work, `awk-${name}`);
  mkdirSync(directory);
  symlinkSync(found, path.join(directory, "awk"));
  return [{ name, PATH: `${directory}:${process.env.PATH}` }];
});
if (!awks.some(({ name }) => name === "mawk")) { console.log("mawk, the awk an Ubuntu server runs these scripts with, is not on this machine"); process.exit(1); }
console.log(`shell readers run under sh with ${awks.map(({ name }) => name).join(" and ")}`);
const programs = new Map();
function runShell(program, file, awk) {
  if (!programs.has(program)) programs.set(program, fileWith(`${program}\n`));
  const result = spawnSync("sh", [programs.get(program), file], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: awk.PATH } });
  if (result.status !== 0 || result.stderr) throw new Error(`sh with ${awk.name} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

// What the web service takes from what systemd gave: parseInt of the port, written out again here
// rather than taken from server/env-file.mjs, so that one is checked too.
function expected(given) {
  const port = Number.parseInt(given.BOXPILOT_PORT ?? "", 10);
  return { port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8787, host: given.BOXPILOT_HOST || "127.0.0.1" };
}

// printf %b: \r, \t, \n and \\ are written as such.
const unescape = (text) => text.replace(/\\([rtn\\])/g, (_, c) => ({ r: "\r", t: "\t", n: "\n", "\\": "\\" })[c]);
const table = [
  ["plain", "BOXPILOT_HOST=127.0.0.1\\nBOXPILOT_PORT=9000"],
  ["inline comment after the port", "BOXPILOT_HOST=0.0.0.0\\nBOXPILOT_PORT=9000   # moved off 8787"],
  ["inline comment after a quoted port", 'BOXPILOT_PORT="9001" # web'],
  ["single-quoted port, ; after it", "BOXPILOT_PORT='9002'   ; web"],
  ["inline comment after the address", "BOXPILOT_HOST=0.0.0.0 # the LAN\\nBOXPILOT_PORT=9003"],
  ["export lines", "BOXPILOT_PORT=9004\\nexport BOXPILOT_PORT=9100\\nexport BOXPILOT_HOST=0.0.0.0"],
  ["a blank inside the name", "BOXPILOT PORT=9100\\nBOXPILOT_PORT=9005"],
  ["CRLF, blanks around =", "BOXPILOT_HOST = 0.0.0.0 \\r\\nBOXPILOT_PORT= \"9006\"\\t\\r\\n"],
  ["a CR alone ends a line", "BOXPILOT_HOST=0.0.0.0\\rBOXPILOT_PORT=9007"],
  ["duplicates, the last with a comment", "BOXPILOT_PORT=8787\\nBOXPILOT_HOST=0.0.0.0\\nBOXPILOT_PORT = 9008 # moved\\nBOXPILOT_HOST=127.0.0.1"],
  ["a quote left open takes the rest of the file", "BOXPILOT_HOST=192.0.2.10\\nBOXPILOT_PORT=\"9009\\nBOXPILOT_HOST=0.0.0.0"],
  ["a quote over two lines", "BOXPILOT_PORT='90\\n10'\\nBOXPILOT_HOST=0.0.0.0"],
  ["a backslash joins lines", "BOXPILOT_PORT=90\\\\\\n11"],
  ["a comment ending in a backslash", "# old \\\\\\nBOXPILOT_PORT=9012"],
  ["quoted pieces run together", "BOXPILOT_HOST='0.0'\"\".0.0\\nBOXPILOT_PORT=\"90\"13"],
  ["a blank and a + inside quotes", "BOXPILOT_PORT=\" +9014\""],
  ["an empty address", "BOXPILOT_HOST=\\nBOXPILOT_PORT=9015"],
  ["an address of blanks", "BOXPILOT_HOST=   \\t\\nBOXPILOT_PORT=9016"],
  ["an empty port", "BOXPILOT_PORT=\\nBOXPILOT_HOST=0.0.0.0"],
  ["no port", "BOXPILOT_HOST=0.0.0.0"],
  ["a port that is no number", "BOXPILOT_PORT=web"],
  ["a port out of range", "BOXPILOT_PORT=70000"],
  ["port 0", "BOXPILOT_PORT=0"],
  ["leading zeros", "BOXPILOT_PORT=009017"],
];

let failures = 0;
const fail = (line) => { failures += 1; console.log(`  FAIL  ${line}`); };
console.log("Each file: what systemd gives, what the web service takes from it, and every reader's answer");
for (const [name, escaped] of table) {
  const text = unescape(escaped);
  const file = fileWith(text);
  const unit = fromSystemd(file, ["BOXPILOT_PORT", "BOXPILOT_HOST"]);
  const want = expected(unit.given);
  const listen = webListenFromEnv(text);
  const answers = {
    "server/index.mjs": unit.service,
    // The runner always asks loopback; only its port is the env file's.
    "agents runner": { port: Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(unit.runner)?.[1]), host: want.host },
    "server/env-file.mjs": { port: listen.webPort, host: listen.webHost },
  };
  for (const [reader, program] of Object.entries(shellReaders)) {
    for (const awk of awks) {
      const out = runShell(program, file, awk);
      const split = out.indexOf("\n");
      answers[`${reader} (${awk.name})`] = { port: Number(out.slice(0, split)), host: out.slice(split + 1) || "127.0.0.1" };
    }
  }
  const read = parseEnvFile(text);
  const raw = { BOXPILOT_PORT: read.get("BOXPILOT_PORT") ?? null, BOXPILOT_HOST: read.get("BOXPILOT_HOST") ?? null };
  console.log(`${name}: systemd gives ${JSON.stringify(unit.given)}; the service listens on ${want.host} port ${want.port}`);
  if (JSON.stringify(raw) !== JSON.stringify(unit.given)) fail(`${name}: server/env-file.mjs reads ${JSON.stringify(raw)}`);
  for (const [reader, answer] of Object.entries(answers)) {
    // A shell reader's value comes through $(...), which drops trailing newlines; none of the
    // addresses above ends in one.
    if (answer.port !== want.port || answer.host !== want.host) fail(`${name}: ${reader} says ${answer.host} port ${answer.port}`);
  }
}

// Random files: systemd's A and B against server/env-file.mjs and the scripts' awk parser.
const alphabet = ["A", "A", "B", "=", "=", " ", "\t", "\n", "\n", "\r", "#", ";", "'", '"', "\\", "x", "9", "$", "`", "export ", "A=", "B=", "\r\n"];
let seed = 20261005;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const parser = `${shellFunction(upgrade, "env_file_value")}\nenv_file_value "$1" A; printf '\\001'; env_file_value "$1" B\n`;
const rounds = 120;
let differences = 0;
for (let round = 0; round < rounds; round += 1) {
  let text = "";
  const length = 1 + Math.floor(random() * 30);
  for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(random() * alphabet.length)];
  // Ending in a newline, as an editor leaves a file: the awk parser always sees one there.
  text += "\n";
  const file = fileWith(text);
  const { given } = fromSystemd(file, ["A", "B"]);
  const read = parseEnvFile(text);
  const readers = { "server/env-file.mjs": { A: read.get("A") ?? null, B: read.get("B") ?? null } };
  for (const awk of awks) {
    const [awkA, awkB] = runShell(parser, file, awk).split("\u0001");
    // The shell parser cannot tell unset from empty: where systemd gives nothing it must print nothing.
    readers[`the scripts' parser (${awk.name})`] = { A: given.A === null && awkA === "" ? null : awkA, B: given.B === null && awkB === "" ? null : awkB };
  }
  for (const [reader, values] of Object.entries(readers)) {
    for (const key of ["A", "B"]) {
      if (values[key] !== given[key]) { differences += 1; fail(`random ${JSON.stringify(text)}: systemd gives ${key}=${JSON.stringify(given[key])}, ${reader} ${JSON.stringify(values[key])}`); }
    }
  }
}
console.log(`${rounds} random files: ${differences} values differ from systemd's`);

if (failures) { console.log(`${failures} disagreement(s) with systemd`); process.exit(1); }
console.log("every reader agrees with systemd");
