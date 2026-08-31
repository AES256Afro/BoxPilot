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
    evidence: ["The recovery check did not return a complete answer."],
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
        evidence: [item.evidence, `Recovery evidence state: ${item.state}.`],
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
          title: "Storage evidence is unavailable",
          summary: "BoxPilot will not claim storage readiness without the fixed mount and device collectors.",
          evidence: ["The sanitized storage inventory did not return a complete result."],
          recommendation: { view: "overview", title: "Open Overview", steps: ["Refresh Overview and confirm real-mount inventory.", "Check the BoxPilot service if storage evidence remains unavailable.", "Do not begin a storage-sensitive operation until current evidence returns."] },
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
            summary: "Review the exact sanitized mount evidence before creating backups, applications, or virtual-machine disks.",
            evidence: [`${filesystemSummary.critical ?? 0} critical and ${filesystemSummary.warning ?? 0} warning filesystem capacity state(s) were reported.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Identify the reported mount and verify its capacity at the server console.", "Pause storage-producing jobs and preserve current backups.", "Use a separately reviewed cleanup or expansion procedure; Action Center performs no deletion."] },
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
            summary: critical ? "Preserve current data and inspect the exact filesystem from the server console before storage-producing work." : "BoxPilot cannot make a filesystem-error all-clear claim for every supported ext4 mount.",
            evidence: [`${filesystemErrors.critical ?? 0} ext4 critical and ${filesystemErrors.unavailable ?? 0} ext4 unavailable error-counter state(s) were reported.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Identify the exact sanitized mount and review its recorded counter state.", "Use local console access to inspect kernel and filesystem evidence without unmounting or repairing automatically.", "Prepare and verify a backup before any separately reviewed fsck, unmount, or repair procedure."] },
            boundary: boundary(),
          });
        } else if ((filesystemErrors?.unsupported ?? 0) > 0) {
          notices.push({
            id: "storage.filesystem-errors-unsupported",
            severity: "info",
            category: "Storage health",
            title: "Some filesystems lack error-counter coverage",
            summary: "BoxPilot reports unsupported filesystem types explicitly and does not convert missing counters into healthy evidence.",
            evidence: [`${filesystemErrors.unsupported} mounted filesystem(s) have no allowlisted error-counter collector.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Review which sanitized mounts are marked unsupported.", "Use the filesystem vendor's read-only inspection guidance at the server console if that mount matters to recovery.", "Do not run fsck or a repair from Action Center; preserve current data first."] },
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
            title: critical ? "SMART evidence reports a critical disk" : smart?.status === "stale" ? "SMART evidence is stale" : smart?.available ? "SMART evidence needs review" : "SMART evidence is unavailable",
            summary: critical ? "Protect data and inspect the affected physical disk before continuing storage work." : "BoxPilot has no current all-clear SMART evidence for every discovered physical disk.",
            evidence: [`SMART evidence state: ${smart?.status ?? "unavailable"}. Reason: ${smart?.reason ?? "storage-scan-unavailable"}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Review the fixed storage-evidence timestamp and per-disk state.", "Use the server console to verify the timer and separately reviewed smartmontools package.", "Do not replace a disk or delete data from Action Center; prepare a verified backup and hardware recovery plan first."] },
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
            title: "No local UPS evidence is configured",
            summary: "BoxPilot has no read-only NUT localhost evidence and will not claim power-loss protection.",
            evidence: [ups.installed ? "The NUT client is installed, but no single local UPS was enumerated." : "The NUT client is not installed on this server."],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Decide whether this server needs UPS protection before enabling critical workloads.", "Install and configure NUT separately at the server console if compatible hardware is present.", "Return to Overview and confirm one locally enumerated UPS reports current evidence."] },
            boundary: boundary(),
          });
        } else if (!ups.available || ["on-battery", "bypass", "offline"].includes(ups.state)) {
          notices.push({
            id: ups.state === "on-battery" ? "power.ups-on-battery" : "power.ups-unavailable",
            severity: "warning",
            category: "Power protection",
            title: ups.state === "on-battery" ? "The local UPS is on battery" : "Local UPS evidence needs review",
            summary: ups.state === "on-battery" ? "Preserve service and prepare for a bounded shutdown if utility power does not return." : "BoxPilot cannot make a current UPS protection claim for the configured local device.",
            evidence: [`Local UPS state: ${ups.state}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Review the bounded charge, runtime, load, and status evidence.", "Inspect the physical UPS and local NUT service from the server console.", "Preserve active work and follow a separately reviewed shutdown procedure if power protection is not stable."] },
            boundary: boundary(),
          });
        } else if (["low-battery", "forced-shutdown"].includes(ups.state)) {
          notices.push({
            id: "power.ups-critical",
            severity: "critical",
            category: "Power protection",
            title: ups.state === "low-battery" ? "The local UPS battery is low" : "The local UPS reports forced shutdown",
            summary: "Protect current data and use the server's separately configured shutdown policy or local console procedure now.",
            evidence: [`Local UPS state: ${ups.state}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Confirm utility power and the physical UPS state immediately.", "Stop storage-producing work and preserve current data.", "Use the separately configured NUT or console shutdown procedure; Action Center cannot issue a power command."] },
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
            title: "Package-manager state is interrupted",
            summary: "Do not start another package operation until dpkg state is inspected and recovered from the server console.",
            evidence: [`${maintenance.packageManager.pendingUpdateFragments ?? "Unknown"} bounded pending update fragment(s) were detected.`],
            recommendation: { view: "repairs", title: "Open Repair Center", steps: ["Pause BoxPilot package repairs and other package operations.", "Inspect dpkg and APT state from the local server console using Ubuntu recovery guidance.", "Return to Overview and confirm package-manager state is ready before retrying a separately reviewed operation."] },
            boundary: boundary(),
          });
        }
        if (maintenance.reboot?.required === true) {
          notices.push({
            id: "maintenance.reboot-required",
            severity: "warning",
            category: "Host maintenance",
            title: "Ubuntu reports that a reboot is required",
            summary: "Plan a maintenance window and preserve active workloads before rebooting from a separately controlled console.",
            evidence: ["The fixed reboot-required marker is present; its text and package names are excluded."],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Review active applications, jobs, backups, and virtual machines.", "Confirm local or Tailscale recovery access before the maintenance window.", "Reboot through a separately reviewed console procedure; Action Center cannot restart the host."] },
            boundary: boundary(),
          });
        }
        if (maintenance.system?.state === "degraded" || (maintenance.system?.failedServiceCount ?? 0) > 0) {
          notices.push({
            id: "maintenance.system-degraded",
            severity: "warning",
            category: "Host maintenance",
            title: "Systemd reports degraded service state",
            summary: "Inspect failed services at the server console before relying on the host for a high-impact operation.",
            evidence: [`${maintenance.system.failedServiceCount ?? "Unknown"} failed service(s) were counted; unit names are excluded.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Review the bounded system state and failed-service count.", "Identify and inspect failed units from the server console without restarting them automatically.", "Verify affected workloads and recovery access before applying a separately reviewed repair."] },
            boundary: boundary(),
          });
        }
        const coreUnavailable = !maintenance.system?.available || !maintenance.reboot?.available || !maintenance.packageManager?.available;
        if (coreUnavailable) {
          notices.push({
            id: "maintenance.evidence-unavailable",
            severity: "warning",
            category: "Host maintenance",
            title: "Host-maintenance evidence is incomplete",
            summary: "BoxPilot will not claim maintenance readiness without system, reboot, and package-manager evidence.",
            evidence: ["At least one fixed host-maintenance collector is unavailable."],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Refresh the Overview and confirm which bounded state is unavailable.", "Inspect BoxPilot service permissions and the corresponding Ubuntu state at the server console.", "Do not begin a package or reboot workflow until current evidence returns."] },
            boundary: boundary(),
          });
        }
        if (maintenance.aptMetadata?.state === "stale") {
          notices.push({
            id: "maintenance.apt-metadata-stale",
            severity: "info",
            category: "Host maintenance",
            title: "APT metadata evidence is stale",
            summary: "Package decisions should not rely on repository metadata older than seven days.",
            evidence: [`APT metadata age: ${maintenance.aptMetadata.ageHours ?? "unknown"} hours.`],
            recommendation: { view: "repairs", title: "Open Repair Center", steps: ["Confirm internet and repository availability from the server console.", "Refresh package metadata through a separately reviewed console procedure.", "Re-run BoxPilot inspection before planning an exact package repair."] },
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
            title: "Automatic security updates need operator review",
            summary: "The fixed unattended-upgrades unit is not both enabled and active.",
            evidence: [`Automatic security update state: ${maintenance.automaticSecurityUpdates.state}.`],
            recommendation: { view: "overview", title: "Open Overview", steps: ["Review the current fixed unattended-upgrades unit state.", "Confirm the intended Ubuntu update policy and maintenance window at the server console.", "Apply any policy change separately; BoxPilot does not enable or start the service."] },
            boundary: boundary(),
          });
        }
      }
    }

    if (notices.length === 0) notices.push({
      id: "action-center.no-current-actions",
      severity: "info",
      category: "Readiness",
      title: "No current action-required evidence",
      summary: "All mapped recovery checks are verified or not applicable in the latest read-only collection.",
      evidence: [`${kit.checks.length} recovery checks were evaluated.`],
      recommendation: {
        view: "repairs",
        title: "Review evidence",
        steps: ["Keep independent backups and recovery access current.", "Inspect again before a high-impact change.", "Use the recovery kit for the complete evidence boundary."],
      },
      boundary: boundary(),
    });

    if (hostEvidenceMissing) {
      notices.push({
        id: "host.evidence-unavailable",
        severity: "warning",
        category: "Readiness",
        title: "Nothing could be read from this host",
        summary: "Disk health, power protection and maintenance evidence were all unavailable, so none of them is being reported either way.",
        evidence: ["The host inventory collector returned nothing."],
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
