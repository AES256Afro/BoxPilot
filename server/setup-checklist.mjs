/**
 * "Set up your server" checklist for the Overview: which of the essentials are in place,
 * derived from evidence BoxPilot already has. Pure function + a gatherer; the dashboard
 * renders it with a link per item.
 *
 * Each item is done, not done, or unknown. Unknown matters: every source here can fail — the
 * helper restarts, a probe times out — and a failed read used to render as "not set up", telling
 * an owner whose firewall is on and configured to go and turn on their firewall. Unknown items
 * are left out of the "N of M essentials" count rather than counted against the owner.
 */

const dnsApps = ["pi-hole", "adguard-home", "technitium-dns"];

/** @param {object} evidence partial evidence; a source that is `null` makes its item unknown */
export function buildChecklist(evidence = {}) {
  const { firewall = null, firewallProfile = null, installedApps = [], notifications = null, unattended = null, backupDestination = null, cloudDestination = null, backupSync = null, samba = null, nfs = null, ups = null, tailscale = null } = evidence;
  const items = [
    {
      id: "tailscale", title: "Reach BoxPilot from anywhere", view: "network", optional: false,
      known: tailscale !== null, done: Boolean(tailscale?.connected),
      detail: tailscale?.connected ? `Connected to your tailnet${tailscale.dnsName ? ` as ${tailscale.dnsName}` : ""}.` : "Join a Tailscale network so this page, your apps, and shares work from your phone and laptop away from home, with nothing opened on your router.",
    },
    {
      id: "firewall", title: "Turn on the firewall with a profile", view: "firewall", optional: false,
      known: firewall !== null, done: Boolean(firewall?.enabled && firewallProfile?.id),
      detail: firewall?.enabled && firewallProfile?.id
        ? `Profile ${firewallProfile.id} applied${firewallProfile.appliedAt ? ` on ${new Date(firewallProfile.appliedAt).toLocaleDateString()}` : ""}${firewallProfile.editedAt ? ", with rules edited since" : ""}.`
        : firewall?.enabled ? "The firewall is on; apply a profile so the defaults and protected ports are handled for you." : "Block everything you did not ask for. SSH, Tailscale, and BoxPilot always stay reachable.",
    },
    {
      id: "updates", title: "Install security updates automatically", view: "updates", optional: false,
      known: unattended !== null, done: Boolean(unattended?.enabled),
      detail: unattended?.enabled ? "Security upgrades install nightly." : "One switch on the Updates page keeps the operating system patched without you.",
    },
    {
      id: "notifications", title: "Get alerts on your phone", view: "settings", optional: false,
      known: notifications !== null, done: Boolean(notifications?.configured),
      // "Install ntfy" is the wrong instruction for an owner who already has: the missing half is
      // connecting BoxPilot to it, and the old copy sent them back to the catalog to reinstall.
      detail: notifications?.configured ? `Alerts go to ${notifications.kind}.`
        : installedApps.includes("ntfy") ? "ntfy is already running on this server; connect BoxPilot to it under Settings, Notifications, and alerts about failed jobs, full disks, SMART warnings, and power cuts start flowing."
        : installedApps.includes("gotify") ? "Gotify is already running on this server; connect BoxPilot to it under Settings, Notifications, and alerts about failed jobs, full disks, SMART warnings, and power cuts start flowing."
        : "Install ntfy or Gotify from the catalog (or use any webhook) and BoxPilot tells you about failed jobs, full disks, SMART warnings, and power cuts.",
    },
    {
      id: "backups", title: "Keep a copy of your backups off this box", view: "backups", optional: false,
      // A destination that has never mirrored is not a copy: this item is only done once something
      // has actually been written somewhere else. The dashboard said "never mirrored off-box" in
      // its own warnings while this line showed a green tick for the same server.
      known: true,
      done: Boolean(cloudDestination?.lastSync || backupDestination?.lastSync || backupSync?.lastSync),
      detail: cloudDestination?.lastSync ? `Last mirrored to ${cloudDestination.provider} on ${new Date(cloudDestination.lastSync).toLocaleDateString()}.`
        : backupDestination?.lastSync ? `Last mirrored over SSH to ${backupDestination.host} on ${new Date(backupDestination.lastSync).toLocaleDateString()}.`
        : backupSync?.lastSync ? `Last mirrored to the backup drive on ${new Date(backupSync.lastSync).toLocaleDateString()}.`
        : cloudDestination || backupDestination || backupSync?.mounted ? "A destination is set up but nothing has been mirrored to it yet: run a sync from the Backups page."
        : "A disk failure should not take the backups with it: add a cloud destination, an SSH destination, or a backup drive.",
    },
    {
      id: "dns", title: "Block ads and trackers network-wide", view: "catalog", optional: true,
      known: Array.isArray(installedApps), done: installedApps.some((id) => dnsApps.includes(id)),
      detail: installedApps.some((id) => dnsApps.includes(id)) ? "A DNS blocker is installed; point your router at this server." : "Install Pi-hole or AdGuard Home from the catalog and point your router's DNS at this server.",
    },
    {
      id: "shares", title: "Share folders with your devices", view: "storage", optional: true,
      known: samba !== null || nfs !== null,
      done: Boolean((samba?.configured && samba.running !== false) || (nfs?.configured && nfs.running !== false)),
      detail: (samba?.configured && samba.running !== false) || (nfs?.configured && nfs.running !== false) ? "Shares are configured and being served."
        : samba?.configured || nfs?.configured ? "Shares are configured but the service that serves them is not running."
        : "Serve folders over SMB (Windows, macOS, phones) or NFS (Linux, VMs), bound to your tailnet.",
    },
    {
      id: "ups", title: "Protect against power cuts", view: "system", optional: true,
      known: ups !== null, done: Boolean(ups?.configured),
      detail: ups?.configured ? "UPS monitoring is set up." : "Plug a UPS's USB cable into this server and set up monitoring for a clean shutdown when the battery runs low.",
    },
  ];
  const required = items.filter((item) => !item.optional);
  const answered = required.filter((item) => item.known !== false);
  return {
    items,
    done: answered.filter((item) => item.done).length,
    total: answered.length,
    unknown: required.length - answered.length,
    allEssentialDone: answered.length === required.length && answered.every((item) => item.done),
  };
}

const withLastSync = (destination, record) => (destination ? { ...destination, lastSync: record?.completedAt ?? null } : null);

/** Gather evidence from the services the web process already has; every call tolerates failure. */
export async function gatherChecklistEvidence({ state, helper, notifications, inventory, network } = {}) {
  const quiet = (promise) => promise.catch(() => null);
  const [firewall, apps, unattended, samba, nfs, machine, snapshot, topology] = await Promise.all([
    quiet(helper.request("firewall.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("app.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("apt.unattended.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("samba.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("nfs.inspect", {}, { timeoutMs: 15_000 })),
    quiet(helper.request("host.snapshot.inspect", {}, { timeoutMs: 15_000 })),
    quiet(inventory ? inventory.inspect() : Promise.resolve(null)),
    quiet(network ? network.inspect() : Promise.resolve(null)),
  ]);
  return {
    firewall,
    firewallProfile: state?.getSetting?.("firewallProfile", null) ?? null,
    installedApps: (apps?.applications ?? []).filter((app) => app.installed).map((app) => app.id),
    notifications: notifications?.describe?.() ?? null,
    unattended,
    // Each destination carries the time it last actually mirrored, which is what makes the item
    // done — being configured only means somebody filled in a form.
    backupDestination: withLastSync(state?.getSetting?.("backupDestination", null), state?.getSetting?.("backupDestinationLastSync", null)),
    cloudDestination: withLastSync(state?.getSetting?.("cloudDestination", null), state?.getSetting?.("cloudDestinationLastSync", null)),
    backupSync: machine?.sync ? { ...machine.sync.mount, lastSync: machine.sync.lastSync?.completedAt ?? machine.sync.lastSync ?? null } : null,
    samba,
    nfs,
    ups: snapshot?.power?.ups ?? null,
    tailscale: topology?.tailscale ?? snapshot?.network?.tailscale ?? null,
  };
}
