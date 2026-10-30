/**
 * What makes a medium-risk operation high risk for what it acts on (ADR-001: firewall and SSH changes,
 * and anything that sends data off the box, are the owner's, with a password). An operator may stage
 * and approve a medium job alone; each hook below closes a path by which one could reach, through a
 * medium operation, what a high one guards. The jobs service, flows, the scheduler and the agents' plans
 * all take the tier from these (server/index.mjs registers them), and a hook can only raise a tier.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import { backupMountName } from "../backup-mount.mjs";
import { loginHomesFrom, servesHome } from "../tasks/served-folder.mjs";
export { loginHomesFrom };
import { packageBase, protectedPackages } from "../tasks/apt.mjs";
export { protectedPackages };
import { tunnelAppId } from "../cloudflare-tunnel.mjs";
import { defaultKeepBackupsPerApp } from "../housekeeping.mjs";


/**
 * Units that load or flush the kernel's packet filter. nftables.service begins with `flush ruleset`
 * and flushes again when stopped, which takes ufw's and Docker's rules with it: turning the firewall
 * off without the Firewall page's password.
 */
export const packetFilterUnit = /^(nftables|netfilter-persistent|iptables|ip6tables|ebtables|arptables)(-[a-z0-9-]+)?\.service$/;

const high = (condition) => (condition ? "high" : null);

async function servesLoginHome(paths, readPasswd = () => readFile("/etc/passwd", "utf8")) {
  return servesHome(paths, loginHomesFrom(await readPasswd().catch(() => "")));
}

/**
 * Where an app's data folders are expected to live. A configurable volume is mounted read-write
 * into a container that often runs as root inside: pointed at /var/spool/cron or an admin's home
 * it writes a crontab or ~/.ssh, which is root on this server. Outside these, choosing the folder
 * is the owner's, with a password; the deny list in schema.mjs still refuses system locations
 * for everyone.
 */
export const dataRoots = Object.freeze(["/mnt", "/media", "/srv"]);
export function foldersOutsideDataRoots(values) {
  const chosen = Object.values(values?.volumes && typeof values.volumes === "object" ? values.volumes : {});
  return chosen.filter((folder) => typeof folder !== "string" || !dataRoots.some((root) => folder.replace(/\/+$/, "").startsWith(`${root}/`)));
}

/** This server's own IPv4 addresses, the ones local names may point at. */
const ownAddresses = () => Object.values(os.networkInterfaces()).flat().filter((entry) => entry?.family === "IPv4").map((entry) => entry.address);

/** The least history space.cleanup may leave without the owner: a week, and a quarter GiB of journal. */
export const historyFloor = Object.freeze({ days: 7, journalBytes: 256 * 1024 ** 2 });
const below = (value, floor) => value !== undefined && value !== null && Number(value) < floor;

/** The higher of several hooks' tiers, for an operation two concerns raise (a manifest's tier, a folder). */
export function higherOf(...hooks) {
  const order = ["low", "medium", "high"];
  return async (parameters) => {
    const tiers = await Promise.all(hooks.map((hook) => Promise.resolve(hook(parameters)).catch(() => null)));
    return tiers.reduce((best, tier) => (order.indexOf(tier) > order.indexOf(best) ? tier : best), null);
  };
}

export const escalationRiskHooks = Object.freeze({
  // A share or export of a login account's home writes as that account: its ~/.ssh is a shell.
  "samba.apply": async (parameters) => high(await servesLoginHome((parameters?.shares ?? []).map((share) => share?.path))),
  "nfs.apply": async (parameters) => high(await servesLoginHome((parameters?.exports ?? []).map((entry) => entry?.path))),
  // Importing keys is users.keys.import, which is high; creating the account with them is the same.
  "users.add": (parameters) => high(Boolean(parameters?.githubUser)),
  "apt.remove": (parameters) => high((parameters?.packages ?? []).some((name) => protectedPackages.includes(packageBase(name)))),
  "service.action": (parameters) => high(packetFilterUnit.test(String(parameters?.unit ?? ""))),
  // Whatever is mounted at the backup destination is where backup.sync copies every app's secrets
  // and the database: choosing it is choosing where data leaves the box.
  "share.mount": (parameters) => high(parameters?.name === backupMountName),
  "storage.mount": (parameters) => high(parameters?.name === backupMountName),
  // The tunnel runs on the host's network with whatever token it is given: a token for someone's
  // own Cloudflare account can route the internet to any port on 127.0.0.1, BoxPilot's included.
  // Installing it is high in its manifest; handing it a new token is the same.
  "app.reconfigure": (parameters) => high((parameters?.id === tunnelAppId && Object.hasOwn(parameters?.values?.env ?? {}, "TUNNEL_TOKEN")) || foldersOutsideDataRoots(parameters?.values).length > 0),
  // Every app's name pointed at another machine is every app's sign-in page served from there.
  "dns.names.apply": (parameters) => high(!ownAddresses().includes(String(parameters?.address ?? ""))),
  // Offering an exit node or routes opens the LAN (or Docker's and libvirt's networks) to the tailnet,
  // which is the firewall's kind of decision.
  // With no routes given, the task advertises the LAN's own subnets: subnetRouter alone offers them.
  "tailscale.set": (parameters) => high(parameters?.exitNode === true || parameters?.subnetRouter === true),
  // The journal holds sudo and SSH history: shrinking it to a day erases the trail of what was done.
  "space.cleanup": (parameters) => high(((parameters?.categories ?? []).includes("journal") && (below(parameters?.journalMaxAgeDays, historyFloor.days) || below(parameters?.journalMaxBytes, historyFloor.journalBytes)))
    || ((parameters?.categories ?? []).includes("job-logs") && below(parameters?.jobLogRetentionDays, historyFloor.days))),
  // A recycle bin is the share's undo: emptying what was recycled this week is deleting it for good.
  "samba.recycle.empty": (parameters) => high(!(Number(parameters?.olderThanDays ?? 0) >= historyFloor.days)),
  // index.mjs combines this with the manifest's own tier (installRiskLookup) through higherOf.
  "app.install": (parameters) => high(foldersOutsideDataRoots(parameters?.values).length > 0),
  // Each backup prunes all but the newest `keep`: a few runs with keep 1 delete what
  // app.backup.delete (owner only) guards. Keeping fewer than housekeeping always keeps is the owner's call.
  "app.backup": (parameters) => high(parameters?.keep !== undefined && parameters?.keep !== null && Number(parameters.keep) < defaultKeepBackupsPerApp),
  "app.backup.many": (parameters) => high(parameters?.keep !== undefined && parameters?.keep !== null && Number(parameters.keep) < defaultKeepBackupsPerApp),
});

/**
 * Withdrawing the tailnet address BoxPilot itself is served at cuts off every tailnet browser and
 * Tailscale sign-in. `servedOrigins` lists those addresses (identity.mjs); a port Serve answers on
 * there is the owner's to withdraw.
 */
export function serveWithdrawRisk(servedOrigins) {
  return async (parameters) => {
    const origins = await Promise.resolve(servedOrigins()).catch(() => []);
    return high(origins.some((origin) => {
      try { const url = new URL(origin); return (url.port === "" ? 443 : Number(url.port)) === parameters?.port; } catch { return false; }
    }));
  };
}
