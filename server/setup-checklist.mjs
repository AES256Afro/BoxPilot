/**
 * "Set up your server" checklist for the Overview: which of the essentials are in place,
 * derived from evidence BoxPilot already has. Pure function + a gatherer; the dashboard
 * renders it with a link per item. Every source is optional so a missing one never hides
 * the list.
 */

const dnsApps = ["pi-hole", "adguard-home", "technitium-dns"];

/** @param {object} evidence partial evidence; absent fields count as "not done" */
export function buildChecklist(evidence = {}) {
  const { firewall = null, firewallProfile = null, installedApps = [], notifications = null, unattended = null, backupDestination = null, cloudDestination = null, backupSync = null, samba = null, nfs = null, ups = null, tailscale = null } = evidence;
  const items = [
    {
      id: "tailscale", title: "Reach BoxPilot from anywhere", view: "network", optional: false,
      done: Boolean(tailscale?.connected),
      detail: tailscale?.connected ? `Connected to your tailnet${tailscale.dnsName ? ` as ${tailscale.dnsName}` : ""}.` : "Join a Tailscale network so this page, your apps, and shares work from your phone and laptop away from home, with nothing opened on your router.",
    },
    {
      id: "firewall", title: "Turn on the firewall with a profile", view: "firewall", optional: false,
      done: Boolean(firewall?.enabled && firewallProfile?.id),
      detail: firewall?.enabled && firewallProfile?.id ? `Profile ${firewallProfile.id} applied${firewallProfile.appliedAt ? ` on ${new Date(firewallProfile.appliedAt).toLocaleDateString()}` : ""}.` : firewall?.enabled ? "The firewall is on; apply a profile so the defaults and protected ports are handled for you." : "Block everything you did not ask for. SSH, Tailscale, and BoxPilot always stay reachable.",
    },
    {
      id: "updates", title: "Install security updates automatically", view: "updates", optional: false,
      done: Boolean(unattended?.enabled),
      detail: unattended?.enabled ? "Security upgrades install nightly." : "One switch on the Updates page keeps the operating system patched without you.",
    },
    {
      id: "notifications", title: "Get alerts on your phone", view: "settings", optional: false,
      done: Boolean(notifications?.configured),
      detail: notifications?.configured ? `Alerts go to ${notifications.kind}.` : "Install ntfy or Gotify from the catalog (or use any webhook) and BoxPilot tells you about failed jobs, full disks, SMART warnings, and power cuts.",
    },
    {
      id: "backups", title: "Keep a copy of your backups off this box", view: "backups", optional: false,
      done: Boolean(cloudDestination || backupDestination || backupSync?.mounted),
      detail: cloudDestination ? `Mirroring to ${cloudDestination.provider}.` : backupDestination ? `Mirroring over SSH to ${backupDestination.host}.` : backupSync?.mounted ? "Mirroring to the independent backup drive." : "A disk failure should not take the backups with it: add a cloud destination, an SSH destination, or a backup drive.",
    },
    {
      id: "dns", title: "Block ads and trackers network-wide", view: "catalog", optional: true,
      done: installedApps.some((id) => dnsApps.includes(id)),
      detail: installedApps.some((id) => dnsApps.includes(id)) ? "A DNS blocker is installed; point your router at this server." : "Install Pi-hole or AdGuard Home from the catalog and point your router's DNS at this server.",
    },
    {
      id: "shares", title: "Share folders with your devices", view: "storage", optional: true,
      done: Boolean(samba?.configured || nfs?.configured),
      detail: samba?.configured || nfs?.configured ? "Shares are configured." : "Serve folders over SMB (Windows, macOS, phones) or NFS (Linux, VMs), bound to your tailnet.",
    },
    {
      id: "ups", title: "Protect against power cuts", view: "system", optional: true,
      done: Boolean(ups?.configured),
      detail: ups?.configured ? "UPS monitoring is set up." : "Plug a UPS's USB cable into this server and set up monitoring for a clean shutdown when the battery runs low.",
    },
  ];
  const required = items.filter((item) => !item.optional);
  return { items, done: required.filter((item) => item.done).length, total: required.length, allEssentialDone: required.every((item) => item.done) };
}

/** Gather evidence from the services the web process already has; every call tolerates failure. */
export async function gatherChecklistEvidence({ state, helper, notifications, inventory, network } = {}) {
  const quiet = (promise) => promise.catch(() => null);
  const [firewall, apps, unattended, samba, nfs, snapshot, topology] = await Promise.all([
    quiet(helper.request("firewall.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("app.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("apt.unattended.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("samba.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("nfs.inspect", {}, { timeoutMs: 15_000 })),
    quiet(inventory ? inventory.inspect() : Promise.resolve(null)),
    quiet(network ? network.inspect() : Promise.resolve(null)),
  ]);
  return {
    firewall,
    firewallProfile: state?.getSetting?.("firewallProfile", null) ?? null,
    installedApps: (apps?.applications ?? []).filter((app) => app.installed).map((app) => app.id),
    notifications: notifications?.describe?.() ?? null,
    unattended,
    backupDestination: state?.getSetting?.("backupDestination", null) ?? null,
    cloudDestination: state?.getSetting?.("cloudDestination", null) ?? null,
    backupSync: null,
    samba,
    nfs,
    ups: snapshot?.power?.ups ?? null,
    tailscale: topology?.tailscale ?? snapshot?.network?.tailscale ?? null,
  };
}
