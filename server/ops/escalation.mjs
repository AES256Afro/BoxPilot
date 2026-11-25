/**
 * What makes a medium-risk operation high risk for what it acts on (ADR-001: firewall and SSH changes,
 * and anything that sends data off the box, are the owner's, with a password). An operator may stage
 * and approve a medium job alone; each hook below closes a path by which one could reach, through a
 * medium operation, what a high one guards. The jobs service, flows, the scheduler and the agents' plans
 * all take the tier from these (server/index.mjs registers them), and a hook can only raise a tier.
 */
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { backupMountName, isBackupDestinationPath } from "../backup-mount.mjs";
import { dataRoots } from "../catalog/schema.mjs";
import { loginHomesFrom, servesHome } from "../tasks/served-folder.mjs";
export { loginHomesFrom };
import { packageBase, protectedPackages } from "../tasks/apt.mjs";
import { groupsOf, readSudoers, rootEquivalentGroups, sudoRuleNames } from "../tasks/users.mjs";
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
 * The folders chosen for an app that are outside the data roots (schema.mjs, dataRoots). A
 * configurable volume is mounted read-write into a container that often runs as root inside:
 * pointed at /var/spool/cron or an admin's home it writes a crontab or ~/.ssh, which is root on
 * this server. Outside these, choosing the folder is the owner's, with a password; the deny list in
 * schema.mjs still refuses system locations for everyone.
 */
export function foldersOutsideDataRoots(values) {
  const chosen = Object.values(values?.volumes && typeof values.volumes === "object" ? values.volumes : {});
  return chosen.filter((folder) => typeof folder !== "string" || !dataRoots.some((root) => folder.replace(/\/+$/, "").startsWith(`${root}/`)));
}

/**
 * Does this folder hold, or sit inside, where the backups are kept? Every app's secrets and the
 * database are in there, and backup.remote.sync and backup.cloud.* keep sending them anywhere for
 * the owner: an app handed the folder (or /mnt above it) reads them, ships them or deletes them.
 * M72: backup-mount.mjs answers it, for these hooks, the Samba and NFS deny lists and private
 * manifests alike, so the old /mnt/boxpilot-backup cannot be left out of one of them again.
 */
export const reachesBackupDestination = isBackupDestinationPath;
const chosenFolders = (values) => Object.values(values?.volumes && typeof values.volumes === "object" ? values.volumes : {});

/** This server's own IPv4 addresses, the ones local names may point at. */
const ownAddresses = () => Object.values(os.networkInterfaces()).flat().filter((entry) => entry?.family === "IPv4").map((entry) => entry.address);

/** The least history space.cleanup may leave without the owner: a week, and a quarter GiB of journal. */
export const historyFloor = Object.freeze({ days: 7, journalBytes: 256 * 1024 ** 2 });
const below = (value, floor) => value !== undefined && value !== null && Number(value) < floor;

/**
 * Locking or unlocking an administrator changes who administers this server, which is what
 * users.sudo.set (high) guards: an operator could shut the owner's own account, or open one the
 * owner shut. An administrator is anyone root in all but name: a member of sudo, admin or wheel, or
 * of docker, lxd or libvirt (whose daemons run what a member asks as root), or anyone a sudoers rule
 * names. Anything that cannot be read or understood counts as an administrator: /etc/passwd,
 * /etc/group, or a sudoers file that is there but garbled or holds an include this does not follow.
 *
 * One exception (M90): this runs in the web service, which is not root, and /etc/sudoers is 0440
 * root on Ubuntu. Counting "permission denied" as "an administrator" raised every lock and unlock
 * to high on a real server. There the groups decide: they are how BoxPilot itself grants
 * administration (users.sudo.set). An account named only by a sudoers rule is the one this cannot
 * see, and the root task's own last-administrator guard (tasks/users.mjs) still reads sudoers in full.
 * @param {{ read?: (file: string) => Promise<string>, list?: (dir: string) => Promise<string[]> }} [sources]
 */
export function adminAccountRisk({ read = (file) => readFile(file, "utf8"), list = (dir) => readdir(dir) } = {}) {
  return async (parameters) => {
    const username = String(parameters?.username ?? "");
    const [passwd, group] = await Promise.all(["/etc/passwd", "/etc/group"].map((file) => Promise.resolve().then(() => read(file)).catch(() => null)));
    if (passwd === null || group === null) return "high";
    const groups = groupsOf(username, passwd, group);
    if (groups.some((name) => rootEquivalentGroups.includes(name))) return "high";
    const denied = await Promise.resolve().then(() => read("/etc/sudoers")).then(() => false, (error) => error?.code === "EACCES" || error?.code === "EPERM");
    if (denied) return null;
    const sudoers = await readSudoers({ read, list }).catch(() => null);
    if (!sudoers?.readable || !sudoers.complete) return "high";
    return high(sudoers.rules.some((rule) => sudoRuleNames(rule, { name: username, groups })));
  };
}

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
  "users.lock": adminAccountRisk(),
  "users.unlock": adminAccountRisk(),
  "apt.remove": (parameters) => high((parameters?.packages ?? []).some((name) => protectedPackages.includes(packageBase(name)))),
  "service.action": (parameters) => high(packetFilterUnit.test(String(parameters?.unit ?? ""))),
  // Whatever is mounted at the backup destination is where backup.sync copies every app's secrets
  // and the database: choosing it is choosing where data leaves the box.
  "share.mount": (parameters) => high(parameters?.name === backupMountName),
  "storage.mount": (parameters) => high(parameters?.name === backupMountName),
  // The tunnel runs on the host's network with whatever token it is given: a token for someone's
  // own Cloudflare account can route the internet to any port on 127.0.0.1, BoxPilot's included.
  // Installing it is high in its manifest; handing it a new token is the same. Switching an app
  // onto the host's network after install is what systemReach counts at install (M72 review).
  "app.reconfigure": (parameters) => high(parameters?.values?.networkMode === "host" || (parameters?.id === tunnelAppId && Object.hasOwn(parameters?.values?.env ?? {}, "TUNNEL_TOKEN")) || foldersOutsideDataRoots(parameters?.values).length > 0 || chosenFolders(parameters?.values).some(reachesBackupDestination)),
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
  // A folder that holds the backups is inside the data roots, and is the owner's all the same.
  "app.install": (parameters) => high(foldersOutsideDataRoots(parameters?.values).length > 0 || chosenFolders(parameters?.values).some(reachesBackupDestination)),
  // Each backup prunes all but the newest `keep`: a few runs with keep 1 delete what
  // app.backup.delete (owner only) guards. Keeping fewer than housekeeping always keeps is the owner's call.
  "app.backup": (parameters) => high(parameters?.keep !== undefined && parameters?.keep !== null && Number(parameters.keep) < defaultKeepBackupsPerApp),
  "app.backup.many": (parameters) => high(parameters?.keep !== undefined && parameters?.keep !== null && Number(parameters.keep) < defaultKeepBackupsPerApp),
});

/**
 * Homepage's BoxPilot group links every app at one host. Given another machine's name, every link
 * on the dashboard leads there, sign-in pages and all (what dns.names.apply is raised for). The
 * names this server answers to stay one click: its own addresses and name, and where BoxPilot is
 * served (`servedOrigins`, its tailnet name among them).
 */
export function homepageHostRisk(servedOrigins) {
  return async (parameters) => {
    const host = String(parameters?.host ?? "").toLowerCase().replace(/\.$/, "");
    if (!host) return null;
    const origins = await Promise.resolve(servedOrigins()).catch(() => []);
    const served = origins.flatMap((origin) => { try { return [new URL(origin).hostname.toLowerCase()]; } catch { return []; } });
    const name = os.hostname().toLowerCase();
    return high(![...ownAddresses(), "127.0.0.1", "localhost", name, name.split(".")[0], `${name.split(".")[0]}.local`, ...served].includes(host));
  };
}

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
