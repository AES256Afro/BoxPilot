/**
 * "Point name lookups back to systemd-resolved" (root side, boxpilot-run@ with network).
 *
 * The fix the owner made by hand on 2026-09-29, with the checks around it: /etc/resolv.conf was a
 * plain file Tailscale had left pointing at 100.100.100.100, which answered nothing, while
 * systemd-resolved ran fine beside it. Linking the file back to resolved's stub made every lookup
 * work at once. In order:
 *
 *   1. systemd-resolved is running, its stub file exists, and its stub answers a real query - or
 *      nothing is changed, because pointing lookups at it would not help;
 *   2. the current /etc/resolv.conf is kept as /etc/resolv.conf.boxpilot-<stamp> (a link is kept
 *      as the same link);
 *   3. /etc/resolv.conf becomes a link to ../run/systemd/resolve/stub-resolv.conf, swapped in with
 *      one rename so there is never a moment without one;
 *   4. getent looks the names up again, the way curl and Docker do;
 *   5. if they still fail, the old file is put back the same way, and the job says so.
 *
 * tailscaled is not restarted: lookups work at once without it, and at its next start it finds
 * resolved and uses it, which also clears its DNS warning.
 */
import { constants } from "node:fs";
import { copyFile, readFile, readlink, rename, stat, symlink, unlink } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { askServer, isStubTarget, lookupNames, nssLookup, parseResolvConf, resolvConfPath, stubAddress, stubFile, stubLinkTarget } from "../name-lookups.mjs";

const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const defaultFiles = {
  readlink: (file) => readlink(file),
  readFile: (file) => readFile(file, "utf8"),
  isFile: (file) => stat(file).then((info) => info.isFile(), () => false),
  // The copy keeps the file's mode; EXCL, so an earlier copy is never overwritten.
  copyFile: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  symlink: (target, file) => symlink(target, file),
  rename: (from, to) => rename(from, to),
  unlink: (file) => unlink(file),
};

/** 2026-09-29T22:18:04.512Z -> 20260929T221804Z: sortable, and safe in a file name. */
export const stampOf = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

async function currentConf(files) {
  const target = await files.readlink(resolvConfPath).catch((error) => {
    if (error?.code === "EINVAL") return undefined;   // a plain file
    if (error?.code === "ENOENT") return null;         // nothing at all
    throw error;
  });
  if (target === null) return { kind: "missing", target: null, content: null };
  const content = await files.readFile(resolvConfPath).catch(() => null);
  return target === undefined ? { kind: "file", target: null, content } : { kind: "link", target, content };
}

/** Every name through NSS, a few times, since a change can take a moment to be read. */
async function lookUp(run, { tries = 3, sleep = pause } = {}) {
  let names = [];
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    names = await Promise.all(lookupNames.map((name) => nssLookup(run, name, { timeoutMs: 10_000 })));
    if (names.some((entry) => entry.ok)) return { ok: true, names };
    if (attempt < tries) await sleep(1000);
  }
  return { ok: false, names };
}

const said = (names) => names.map((entry) => `${entry.name}: ${entry.ok ? entry.addresses.join(", ") : entry.error}`).join("; ");

/** Put `file` in place of /etc/resolv.conf in one rename: as a link to `target`, or a copy of `from`. */
async function swapIn(files, stamp, { target = null, from = null }) {
  const temporary = `/etc/.resolv.conf.boxpilot-${stamp}.new`;
  await files.unlink(temporary).catch(() => {});
  if (target !== null) await files.symlink(target, temporary);
  else await files.copyFile(from, temporary);
  try {
    await files.rename(temporary, resolvConfPath);
  } catch (error) {
    await files.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function restoreNameLookups(_parameters = {}, { run = fixedRun, files = defaultFiles, ask = askServer, now = () => new Date(), log = null, sleep = pause } = {}) {
  const say = (line) => log?.(line, "stdout");

  // 1. Something to point at, and proof it answers.
  const active = await run(systemctl, ["is-active", "systemd-resolved.service"], { timeout: 15_000 });
  if (String(active.stdout ?? "").trim() !== "active") throw new Error(`systemd-resolved is not running (${String(active.stdout ?? "").trim() || "no answer"}), so there is nothing to point name lookups at. Nothing was changed.`);
  if (!(await files.isFile(stubFile))) throw new Error(`${stubFile} does not exist, so systemd-resolved is not offering its local resolver. Nothing was changed.`);
  const current = await currentConf(files);
  const nameservers = parseResolvConf(current.content).nameservers;
  say(`/etc/resolv.conf is ${current.kind === "link" ? `a link to ${current.target}` : current.kind === "file" ? `a file${nameservers.length ? ` naming ${nameservers.join(", ")}` : ""}` : "missing"}`);
  if (current.kind === "link" && isStubTarget(current.target)) {
    const check = await lookUp(run, { tries: 1, sleep });
    if (check.ok) {
      say(`It already points at systemd-resolved, and names resolve: ${said(check.names)}`);
      return { changed: false, alreadyPointed: true, backup: null, previous: { kind: current.kind, target: current.target, nameservers }, names: check.names, checkedAt: now().toISOString() };
    }
    throw new Error(`/etc/resolv.conf already points at systemd-resolved, and names still do not resolve (${said(check.names)}). Nothing was changed.`);
  }
  const stub = await ask(stubAddress, lookupNames[0]);
  if (!stub.ok) throw new Error(`systemd-resolved's local resolver (${stubAddress}) did not answer for ${lookupNames[0]} either (${stub.error ?? "no address"}), so pointing /etc/resolv.conf at it would not help. Nothing was changed.`);
  say(`systemd-resolved answers: ${lookupNames[0]} is ${stub.addresses.join(", ")}`);

  // 2. Keep what is there now, never over an earlier copy: two runs in one second share a stamp.
  const stamp = stampOf(now());
  let backup = null;
  if (current.kind !== "missing") {
    for (let attempt = 1; !backup; attempt += 1) {
      const candidate = `${resolvConfPath}.boxpilot-${stamp}${attempt > 1 ? `-${attempt}` : ""}`;
      try {
        if (current.kind === "link") await files.symlink(current.target, candidate);
        else await files.copyFile(resolvConfPath, candidate);
        backup = candidate;
      } catch (error) {
        if (error?.code !== "EEXIST" || attempt >= 20) throw new Error(`A copy of /etc/resolv.conf could not be kept (${error?.code ?? error?.message}), so nothing was changed.`);
      }
    }
    say(`Kept the current /etc/resolv.conf as ${backup}`);
  }

  // 3. Point it at resolved.
  say(`$ ln -sfn ${stubLinkTarget} ${resolvConfPath}`);
  try {
    await swapIn(files, stamp, { target: stubLinkTarget });
  } catch (error) {
    throw new Error(`/etc/resolv.conf could not be replaced (${error.code ?? error.message}), so it is as it was${backup ? `; the copy at ${backup} is the same file` : ""}.`);
  }

  // 4. The way curl and Docker would look names up now.
  const check = await lookUp(run, { sleep });
  if (check.ok) {
    say(`Names resolve again: ${said(check.names)}`);
    say("Tailscale was not restarted. Its warning about DNS clears the next time it starts, when it finds systemd-resolved and uses it.");
    return { changed: true, alreadyPointed: false, backup, previous: { kind: current.kind, target: current.target, nameservers }, names: check.names, checkedAt: now().toISOString() };
  }

  // 5. It did not help: put the old one back.
  say(`Names still do not resolve (${said(check.names)}); putting the old /etc/resolv.conf back`);
  try {
    if (current.kind === "link") await swapIn(files, stamp, { target: current.target });
    else if (current.kind === "file") await swapIn(files, stamp, { from: backup });
    else await files.unlink(resolvConfPath);
  } catch (error) {
    throw new Error(`Names still did not resolve with /etc/resolv.conf pointing at systemd-resolved (${said(check.names)}), and the old file could not be put back (${error.code ?? error.message}): copy ${backup ?? "it"} back to /etc/resolv.conf by hand.`);
  }
  throw new Error(`Names still did not resolve with /etc/resolv.conf pointing at systemd-resolved (${said(check.names)}), so the old ${current.kind === "missing" ? "state (no file)" : "file"} was put back${backup ? ` (a copy stays at ${backup})` : ""}. The problem is not only this file: check that the router and the internet connection work.`);
}
