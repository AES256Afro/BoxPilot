#!/usr/bin/env node
import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../server/state.mjs";
import { resetPasswordFromConsole } from "../server/security.mjs";

const usage = [
  "Usage: sudo -u boxpilot env BOXPILOT_STATE_DIRECTORY=/var/lib/boxpilot /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs create-bootstrap-token",
  "       sudo /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs reset-password <user name> [--password-stdin]",
].join("\n");

/** The service's database, where server/state.mjs looks for it. */
function databasePath() {
  const directory = process.env.BOXPILOT_STATE_DIRECTORY ?? (process.platform === "linux" ? "/var/lib/boxpilot" : path.join(os.tmpdir(), "boxpilot"));
  return path.join(path.resolve(directory), "boxpilot.sqlite3");
}

/**
 * Become the database's own user before opening it, the way the upgrade copies it: root opening it
 * could leave its -wal and -shm files owned by root, and the service could then not open its own
 * database. Refused when there is no database (opening would make an empty one) or it is a link.
 */
function becomeDatabaseOwner(file) {
  let found;
  try { found = lstatSync(file); } catch { throw new Error(`There is no BoxPilot database at ${file}. Nothing was changed.`); }
  if (!found.isFile()) throw new Error(`${file} is not a regular file. Nothing was changed.`);
  if (found.uid === 0) return;
  process.setgroups([found.gid]);
  process.setgid(found.gid);
  process.setuid(found.uid);
}

/** One line typed at the terminal, not shown. Ctrl-C or Ctrl-D gives up. */
function askHidden(prompt) {
  const { stdin } = process;
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    let typed = "";
    const finish = (settle, value) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      settle(value);
    };
    function onData(chunk) {
      // An arrow or function key arrives as an escape sequence: not part of a password.
      if (chunk.startsWith("\u001b")) return;
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(resolve, typed);
        if (character === "\u0003" || character === "\u0004") return finish(reject, new Error("Cancelled. Nothing was changed."));
        if (character === "\u007f" || character === "\b") typed = Array.from(typed).slice(0, -1).join("");
        else if (character >= " ") typed += character;
      }
      return undefined;
    }
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** The whole of standard input, less the one line ending a shell adds. Stops reading past any password's length. */
async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 4096) break;
  }
  return text.replace(/\r?\n$/, "");
}

async function newPassword(fromStdin) {
  if (fromStdin) return readStdin();
  if (!process.stdin.isTTY) throw new Error("Run this at a terminal to type the new password, or pass --password-stdin and send it on standard input. Nothing was changed.");
  const first = await askHidden("New password (12 characters or more): ");
  const second = await askHidden("The same again: ");
  if (first !== second) throw new Error("The two did not match. Nothing was changed.");
  return first;
}

async function resetPassword(argv) {
  const fromStdin = argv.includes("--password-stdin");
  const names = argv.filter((value) => value !== "--password-stdin");
  if (names.length !== 1 || names[0].startsWith("-")) { console.error(usage); return 2; }
  if (process.getuid?.() !== 0) { console.error("Run this as root on the server itself: sudo /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs reset-password <user name>"); return 1; }
  becomeDatabaseOwner(databasePath());
  const store = createStateStore();
  try {
    // Before asking for anything: a name that is not an account is said at once, and only that.
    if (!store.findOwnerByUsername(names[0])) { console.error("No such account. Nothing was changed."); return 1; }
    const result = await resetPasswordFromConsole({ store, username: names[0], password: await newPassword(fromStdin) });
    if (!result.ok) { console.error(`${result.error} Nothing was changed.`); return 1; }
    const ended = result.sessionsEnded === 1 ? "1 session was ended" : `${result.sessionsEnded} sessions were ended`;
    console.log(`Set a new password for ${result.username} (${result.role}). ${ended}; sign in with the new password.${result.role === "disabled" ? " The account is still disabled." : ""}`);
    return 0;
  } finally {
    store.close();
  }
}

const command = process.argv[2];
if (command === "reset-password") {
  try {
    process.exitCode = await resetPassword(process.argv.slice(3));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (command !== "create-bootstrap-token") {
  console.error(usage);
  process.exitCode = 2;
} else {
  const store = createStateStore();
  try {
    const result = store.createBootstrapToken();
    console.log("BoxPilot one-time setup code (valid for 15 minutes):");
    console.log(result.token);
    console.log(`Expires: ${result.expiresAt}`);
    console.log("Open BoxPilot and finish owner setup. Do not paste this setup code into chat or logs.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
