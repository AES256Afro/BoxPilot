/**
 * What makes a medium-risk operation high risk for what it acts on (ADR-001: firewall and SSH changes,
 * and anything that sends data off the box, are the owner's, with a password). An operator may stage
 * and approve a medium job alone; each hook below closes a path by which one could reach, through a
 * medium operation, what a high one guards. The jobs service, flows, the scheduler and the agents' plans
 * all take the tier from these (server/index.mjs registers them), and a hook can only raise a tier.
 */
import { backupMountName } from "../backup-mount.mjs";
import { servesHome } from "../tasks/served-folder.mjs";

/**
 * Packages whose removal cuts off SSH, Tailscale or the firewall, or takes sudo, systemd or Docker
 * with it. apt-get reads a trailing "-" on an install as a removal and a trailing "+" on a removal as
 * an install, so the name is compared without either.
 */
export const protectedPackages = Object.freeze(["openssh-server", "openssh-client", "openssh-sftp-server", "ssh", "ufw", "nftables", "iptables", "fail2ban", "tailscale", "sudo", "systemd", "systemd-sysv", "docker-ce", "docker.io", "containerd", "containerd.io", "netplan.io"]);
const packageBase = (name) => String(name ?? "").replace(/[-+]$/, "").replace(/:[a-z0-9-]+$/, "");

/**
 * Units that load or flush the kernel's packet filter. nftables.service begins with `flush ruleset`
 * and flushes again when stopped, which takes ufw's and Docker's rules with it: turning the firewall
 * off without the Firewall page's password.
 */
export const packetFilterUnit = /^(nftables|netfilter-persistent|iptables|ip6tables|ebtables|arptables)(-[a-z0-9-]+)?\.service$/;

const high = (condition) => (condition ? "high" : null);

export const escalationRiskHooks = Object.freeze({
  // A share or export of a login account's home writes as that account: its ~/.ssh is a shell.
  "samba.apply": (parameters) => high(servesHome((parameters?.shares ?? []).map((share) => share?.path))),
  "nfs.apply": (parameters) => high(servesHome((parameters?.exports ?? []).map((entry) => entry?.path))),
  // Importing keys is users.keys.import, which is high; creating the account with them is the same.
  "users.add": (parameters) => high(Boolean(parameters?.githubUser)),
  "apt.install": (parameters) => high((parameters?.packages ?? []).some((name) => protectedPackages.includes(packageBase(name)))),
  "apt.remove": (parameters) => high((parameters?.packages ?? []).some((name) => protectedPackages.includes(packageBase(name)))),
  "service.action": (parameters) => high(packetFilterUnit.test(String(parameters?.unit ?? ""))),
  // Whatever is mounted at the backup destination is where backup.sync copies every app's secrets
  // and the database: choosing it is choosing where data leaves the box.
  "share.mount": (parameters) => high(parameters?.name === backupMountName),
  "storage.mount": (parameters) => high(parameters?.name === backupMountName),
});
