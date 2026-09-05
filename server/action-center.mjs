import { productVersion } from "./version.mjs";

const guidance = {
  "controller.database": {
    category: "If this server died",
    view: "backups",
    steps: [
      "On the Backups page, take a database backup. It is checked by restoring the copy, so you know it works.",
      "Add a second copy somewhere that is not this machine: a drive, another computer over SSH, or cloud storage.",
      "Keeping the only copy on the server it came from means losing both together.",
    ],
  },
  "controller.source": {
    category: "If this server died",
    view: "github",
    steps: [
      "Keep a copy of the BoxPilot version you are running somewhere other than this server.",
      "Keep the notes for setting Ubuntu up again beside it, so a rebuild does not start from memory.",
      "The GitHub page shows which release this is, so you can check the copy you kept matches.",
    ],
  },
  "applications.backup": {
    category: "Apps with no backup",
    view: "catalog",
    steps: [
      "Open the App catalog. Each card says whether that app has ever been backed up.",
      "Back it up from the card, then use Rehearse weekly so a broken backup does not stay unnoticed.",
      "Mirror the backups off this server from the Backups page.",
    ],
  },
  "virtualization.backup": {
    category: "VMs with no backup",
    view: "backups",
    steps: [
      "Open Backups and look at the machines listed without one.",
      "Export the machine while it is stopped, then keep an encrypted copy somewhere else.",
      "Run the restore drill before you rely on it: an export nobody has opened is not yet a backup.",
    ],
  },
  "host.prerequisites": {
    category: "Missing tools",
    view: "repairs",
    steps: [
      "Look at the Prerequisites list further down this page.",
      "Only the tool for the thing you actually want to do needs installing; the rest can wait.",
      "Each one has a button that shows the exact package before it installs anything.",
    ],
  },
};

const priority = { critical: 0, warning: 1, info: 2 };

function severityFor(state) {
  if (state === "unavailable") return "critical";
  if (state === "action-required") return "warning";
  return "info";
}

function boundary() {
  return {
    mutationPerformed: false,
    automaticFixAvailable: false,
    commandsIncluded: false,
    secretsIncluded: false,
    logsIncluded: false,
  };
}

function collectorNotice() {
  return {
    id: "action-center.collector-unavailable",
    severity: "critical",
    category: "Cannot tell",
    title: "This list could not be built",
    summary: "BoxPilot could not read what it needs to say whether this server is protected, so it is not claiming that it is.",
    evidence: ["The rebuild checklist could not be built."],
    recommendation: {
      view: "repairs",
      title: "Check again",
      steps: [
        "Press Check again at the top of this page.",
        "Make sure BoxPilot can still do root work, using the check further down.",
        "Until this list builds, treat nothing here as confirmed.",
      ],
    },
    boundary: boundary(),
  };
}

export function createActionCenterService({ recoveryKit, inventory = null, now = () => new Date(), version = productVersion } = {}) {
  async function inspect() {
    let kit;
    try {
      kit = await recoveryKit.inspect();
    } catch {
      const notices = [collectorNotice()];
      return response(notices, now, version, "unavailable");
    }

    if (!kit || !Array.isArray(kit.checks) || !kit.evidence || !Array.isArray(kit.evidence.jobs)) {
      return response([collectorNotice()], now, version, "unavailable");
    }

    const notices = [];
    let unmapped = 0;
    for (const item of kit.checks) {
      if (!["action-required", "operator-check", "unavailable"].includes(item.state)) continue;
      const fixed = guidance[item.id];
      if (!fixed) {
        unmapped += 1;
        continue;
      }
      notices.push({
        id: `recovery.${item.id}`,
        severity: severityFor(item.state),
        category: fixed.category,
        title: item.title,
        summary: item.action,
        evidence: [item.evidence, `Check state: ${item.state}.`],
        recommendation: {
          view: fixed.view,
          title: `Open ${fixed.view === "repairs" ? "Repair Center" : fixed.view[0].toUpperCase() + fixed.view.slice(1)}`,
          steps: fixed.steps,
        },
        boundary: boundary(),
      });
    }

    if (unmapped > 0) notices.push({
      id: "action-center.unmapped-evidence",
      severity: "warning",
      category: "Cannot tell",
      title: "Some checks have no advice written for them yet",
      summary: "BoxPilot found checks this version does not have guidance for, so they are listed without it rather than hidden.",
      evidence: [`${unmapped} check(s) have no guidance in this version.`],
      recommendation: {
        view: "repairs",
        title: "See the full list",
        steps: ["Read them in the rebuild checklist below.", "They have not passed; they are only unexplained.", "Updating BoxPilot usually brings the advice with it."],
      },
      boundary: boundary(),
    });

    const failedJobs = kit.evidence.jobs.filter((item) => item.state === "failed").length;
    if (failedJobs > 0) notices.push({
      id: "jobs.failed",
      severity: "warning",
      category: "Something failed",
      title: `${failedJobs} recent job${failedJobs === 1 ? "" : "s"} failed`,
      summary: "Read what went wrong before running the same thing again.",
      evidence: [`${failedJobs} recent job(s) ended in failure.`],
      recommendation: {
        view: "repairs",
        title: "See the jobs",
        steps: ["Open the failed job under Recent jobs below.", "It records the error and what to do about it.", "Fix the cause before starting the same job again."],
      },
      boundary: boundary(),
    });

    let hostEvidenceMissing = false;
    if (inventory) {
      let hostInventory = null;
      try { hostInventory = await inventory.inspect(); } catch { hostInventory = null; }
      // Every host-side family below reads from this one collection. When it fails, they all go
      // quiet — including the notices whose whole job is to refuse an all-clear — so the page said
      // "recovery evidence available" for a box it had learned nothing about.
      hostEvidenceMissing = hostInventory === null;
      if (!hostInventory?.storage?.filesystems?.available) {
        notices.push({
          id: "storage.inventory-unavailable",
          severity: "warning",
          category: "Storage health",
          title: "Could not read the drives",
          summary: "BoxPilot could not read this server's mounts just now, so it cannot say whether the drives are healthy.",
          evidence: ["The mount list could not be read."],
          recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Overview and press Refresh.", "If it still fails, check the BoxPilot service on the Services page."] },
          boundary: boundary(),
        });
      } else {
        const filesystemSummary = hostInventory.storage.filesystems?.summary;
        if ((filesystemSummary?.critical ?? 0) > 0 || (filesystemSummary?.warning ?? 0) > 0) {
          const critical = (filesystemSummary?.critical ?? 0) > 0;
          notices.push({
            id: "storage.filesystem-capacity",
            severity: critical ? "critical" : "warning",
            category: "Storage health",
            title: critical ? "A filesystem is critically full" : "A filesystem is approaching capacity",
            summary: "Look at which drive it is on the Storage page before adding backups, apps, or VM disks to it.",
            evidence: [`${filesystemSummary.critical ?? 0} critical and ${filesystemSummary.warning ?? 0} warning filesystem capacity state(s) were reported.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Storage page: the drive is marked with how full it is and what is filling it.", "Free space on it, or point new data somewhere else, before creating anything large."] },
            boundary: boundary(),
          });
        }
        const filesystemErrors = hostInventory.storage.filesystems?.errors;
        if ((filesystemErrors?.critical ?? 0) > 0 || (filesystemErrors?.unavailable ?? 0) > 0) {
          const critical = (filesystemErrors?.critical ?? 0) > 0;
          notices.push({
            id: "storage.filesystem-errors",
            severity: critical ? "critical" : "warning",
            category: "Storage health",
            title: critical ? "An ext4 filesystem has recorded kernel errors" : "An ext4 error counter is unavailable",
            summary: critical ? "The kernel has logged errors on this filesystem. Keep a copy of what matters on it before doing anything that writes to it." : "BoxPilot could not read this filesystem's error counter, so it cannot say whether it is healthy.",
            evidence: [`${filesystemErrors.critical ?? 0} ext4 critical and ${filesystemErrors.unavailable ?? 0} ext4 unavailable error-counter state(s) were reported.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Storage page to see which drive it is.", "Check the drive from the server console before writing to it again; if it keeps logging errors, replace it."] },
            boundary: boundary(),
          });
        } else if ((filesystemErrors?.unsupported ?? 0) > 0) {
          notices.push({
            id: "storage.filesystem-errors-unsupported",
            severity: "info",
            category: "Storage health",
            title: "Some drives cannot report errors to BoxPilot",
            summary: "Their filesystem type does not keep an error counter BoxPilot can read, so they are listed as unchecked rather than assumed healthy.",
            evidence: [`${filesystemErrors.unsupported} mounted drive(s) have no error counter BoxPilot can read.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Storage page to see which drives these are.", "Rely on the drive's own SMART health for these, which BoxPilot checks separately."] },
            boundary: boundary(),
          });
        }
      }
      if (hostInventory?.storage) {
        const smart = hostInventory.storage.smart;
        if (!smart?.available || smart.status === "stale" || ["critical", "warning"].includes(smart.status)) {
          const critical = smart?.status === "critical";
          notices.push({
            id: "storage.smart-evidence",
            severity: critical ? "critical" : "warning",
            category: "Storage health",
            title: critical ? "A drive is reporting problems" : smart?.status === "stale" ? "The drive health reading is out of date" : smart?.available ? "A drive health reading needs a look" : "Drive health has not been checked",
            summary: critical ? "A drive is reporting problems in its own health data. Keep a copy of what matters on it now." : "BoxPilot has no current drive health reading, so it cannot say the drives are fine.",
            evidence: [`Drive health check: ${smart?.status ?? "unavailable"}. Reason: ${smart?.reason ?? "storage-scan-unavailable"}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Overview: the drive and its health numbers are on the Disks panel.", "If a drive is failing, copy its data off before anything else, then replace it."] },
            boundary: boundary(),
          });
        }
      }
      const ups = hostInventory?.power?.ups;
      if (ups) {
        if (!ups.configured) {
          notices.push({
            id: "power.ups-not-configured",
            severity: "info",
            category: "Power protection",
            title: "No battery backup is set up",
            summary: "BoxPilot is not reading a UPS, so a power cut will stop this server without warning.",
            evidence: [ups.installed ? "The UPS software is installed, but no UPS is connected to it." : "The NUT client is not installed on this server."],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Decide whether this server needs one; a UPS lets it shut down cleanly when the power goes.", "Set it up on the System page once it is plugged in."] },
            boundary: boundary(),
          });
        } else if (!ups.available || ["on-battery", "bypass", "offline"].includes(ups.state)) {
          notices.push({
            id: ups.state === "on-battery" ? "power.ups-on-battery" : "power.ups-unavailable",
            severity: "warning",
            category: "Power protection",
            title: ups.state === "on-battery" ? "The power is out; the server is on battery" : "Could not read the UPS clearly",
            summary: ups.state === "on-battery" ? "The power is out and the server is running on its battery." : "BoxPilot cannot read the UPS clearly right now.",
            evidence: [`Local UPS state: ${ups.state}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Check the mains power and the UPS itself.", "If the power does not come back, stop anything that is writing and let the server shut down cleanly."] },
            boundary: boundary(),
          });
        } else if (["low-battery", "forced-shutdown"].includes(ups.state)) {
          notices.push({
            id: "power.ups-critical",
            severity: "critical",
            category: "Power protection",
            title: ups.state === "low-battery" ? "The local UPS battery is low" : "The local UPS reports forced shutdown",
            summary: "The battery is nearly gone. Anything still writing is about to lose power.",
            evidence: [`Local UPS state: ${ups.state}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Stop what you can now.", "The server will shut itself down; let it."] },
            boundary: boundary(),
          });
        }
      }
      const maintenance = hostInventory?.maintenance;
      if (maintenance) {
        if (maintenance.packageManager?.state === "interrupted") {
          notices.push({
            id: "maintenance.package-manager-interrupted",
            severity: "critical",
            category: "Host maintenance",
            title: "A package install was interrupted",
            summary: "Ubuntu's package system was left mid-operation. Nothing else can install until it is put right.",
            evidence: [`${maintenance.packageManager.pendingUpdateFragments ?? "Unknown"} pending update(s) were detected.`],
            recommendation: { view: "repairs", title: "Open Repair Center", steps: ["Do not start another install or update until this is fixed.", "Open Repair: BoxPilot offers to finish the interrupted operation."] },
            boundary: boundary(),
          });
        }
        if (maintenance.reboot?.required === true) {
          notices.push({
            id: "maintenance.reboot-required",
            severity: "warning",
            category: "Host maintenance",
            title: "Ubuntu reports that a reboot is required",
            summary: "An update installed something that only takes effect after a restart.",
            evidence: ["Ubuntu has flagged that a reboot is needed."],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Pick a quiet moment; running apps and VMs will be stopped while it restarts.", "Restart from the System page."] },
            boundary: boundary(),
          });
        }
        if (maintenance.system?.state === "degraded" || (maintenance.system?.failedServiceCount ?? 0) > 0) {
          notices.push({
            id: "maintenance.system-degraded",
            severity: "warning",
            category: "Host maintenance",
            title: "Some system services have failed",
            summary: "At least one service on this server is not running as it should.",
            evidence: [`${maintenance.system.failedServiceCount ?? "Unknown"} failed service(s) were counted.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Services page to see which ones and why.", "Fix or restart them before relying on this server for anything important."] },
            boundary: boundary(),
          });
        }
        const coreUnavailable = !maintenance.system?.available || !maintenance.reboot?.available || !maintenance.packageManager?.available;
        if (coreUnavailable) {
          notices.push({
            id: "maintenance.evidence-unavailable",
            severity: "warning",
            category: "Host maintenance",
            title: "Could not read the server's update state",
            summary: "BoxPilot could not read whether updates, a reboot, or failed services are pending.",
            evidence: ["One of the update checks could not be read."],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Open the Overview and press Refresh.", "If it still cannot read them, check the BoxPilot service on the Services page."] },
            boundary: boundary(),
          });
        }
        if (maintenance.aptMetadata?.state === "stale") {
          notices.push({
            id: "maintenance.apt-metadata-stale",
            severity: "info",
            category: "Host maintenance",
            title: "The package lists are out of date",
            summary: "Ubuntu's list of available updates is more than a week old, so what it shows may be stale.",
            evidence: [`APT metadata age: ${maintenance.aptMetadata.ageHours ?? "unknown"} hours.`],
            recommendation: { view: "repairs", title: "Open Repair Center", steps: ["Check the server is online.", "Refresh the package lists from the Updates page."] },
            boundary: boundary(),
          });
        }
        // Including "not installed": `available` is false when the unit was never installed, so
        // the notice used to fire for the mild case and stay quiet when there is no protection at all.
        if (maintenance.automaticSecurityUpdates && maintenance.automaticSecurityUpdates.state !== "enabled-active") {
          notices.push({
            id: "maintenance.security-updates",
            severity: "info",
            category: "Host maintenance",
            title: "Security updates are not installing on their own",
            summary: "Unattended upgrades are not both enabled and running, so security fixes wait for someone to install them.",
            evidence: [`Automatic security update state: ${maintenance.automaticSecurityUpdates.state}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Turn them on from the Updates page.", "If you prefer to install updates yourself, do it weekly."] },
            boundary: boundary(),
          });
        }
      }
    }

    if (notices.length === 0) notices.push({
      id: "action-center.no-current-actions",
      severity: "info",
      category: "Readiness",
      title: "Nothing needs your attention right now",
      summary: "All mapped recovery checks are verified or not applicable in the latest read-only collection.",
      evidence: [`${kit.checks.length} recovery checks were evaluated.`],
      recommendation: {
        view: "repairs",
        title: "Look anyway",
        steps: ["Keep a second copy of your backups current.", "Check again before a big change.", "Use the recovery kit for the complete evidence boundary."],
      },
      boundary: boundary(),
    });

    if (hostEvidenceMissing) {
      notices.push({
        id: "host.evidence-unavailable",
        severity: "warning",
        category: "Readiness",
        title: "Nothing could be read from this host",
        summary: "Disk health, power protection and update state could not be read, so none of them is being reported either way.",
        evidence: ["The server inventory could not be read."],
        recommendation: { view: "overview", title: "Open Overview", steps: ["Refresh the Overview page.", "Check that the BoxPilot helper service is running.", "Read this page again once evidence returns."] },
        boundary: boundary(),
      });
    }
    notices.sort((left, right) => priority[left.severity] - priority[right.severity] || left.id.localeCompare(right.id));
    return response(notices, now, version, hostEvidenceMissing ? "unavailable" : "ready");
  }

  return { inspect };
}

function response(notices, now, version, sourceStatus) {
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    product: { name: "BoxPilot", version },
    mode: "read-only-local-action-guidance",
    sourceStatus,
    summary: {
      critical: notices.filter((item) => item.severity === "critical").length,
      warning: notices.filter((item) => item.severity === "warning").length,
      info: notices.filter((item) => item.severity === "info").length,
      total: notices.length,
    },
    notices,
    boundary: {
      mutationPerformed: false,
      automaticRepair: false,
      persistence: false,
      browserNotifications: false,
      externalDelivery: false,
      credentialsIncluded: false,
      arbitraryLogsIncluded: false,
    },
  };
}

export const actionCenterInternals = { boundary, collectorNotice, guidance, productVersion, severityFor };
