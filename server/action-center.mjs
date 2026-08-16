const productVersion = "0.29.0";

const guidance = {
  "controller.database": {
    category: "Controller recovery",
    view: "repairs",
    steps: [
      "Use local console access and stop BoxPilot before copying its SQLite database.",
      "Run a SQLite integrity check, copy the database to independent storage, and record its SHA-256.",
      "Restart BoxPilot and verify authentication, inventory, and the recovery kit.",
    ],
  },
  "controller.source": {
    category: "Controller recovery",
    view: "github",
    steps: [
      "Keep the exact BoxPilot release archive and file manifest outside Bigbox.",
      "Keep the Ubuntu bootstrap notes, systemd units, and Tailscale Serve command with that archive.",
      "Compare the retained release identity with the fixed public GitHub provenance view.",
    ],
  },
  "applications.backup": {
    category: "Application protection",
    view: "backups",
    steps: [
      "Open Backups and identify each installed workload without current restore-drill evidence.",
      "Review the adapter-specific scope, downtime, destination, and rollback plan.",
      "Stage and approve each backup separately, then confirm the isolated restore result.",
    ],
  },
  "virtualization.backup": {
    category: "VM protection",
    view: "backups",
    steps: [
      "Open Backups and review every VM without protected backup evidence.",
      "Create a stopped export and an encrypted copy on the fixed independent restic destination.",
      "Run the exact-snapshot isolated no-network restore drill before treating the VM as protected.",
    ],
  },
  "router.checkpoint": {
    category: "Router recovery",
    view: "routers",
    steps: [
      "Export the active router configuration from the router's own administration interface.",
      "Keep the file on independent storage and hash it locally in the BoxPilot browser.",
      "Record only its SHA-256 identity and operator-retention assertion in Router Checkpoints.",
    ],
  },
  "migration.source": {
    category: "Migration safety",
    view: "migrations",
    steps: [
      "Stop destination activation and keep the source workload unchanged.",
      "Review content-verification and source-preservation evidence for the affected transfer.",
      "Repeat staging only after the source and rollback path are independently available.",
    ],
  },
  "dns.second-device": {
    category: "DNS acceptance",
    view: "network",
    steps: [
      "Keep router, DHCP, client, and Tailscale DNS settings unchanged.",
      "Complete the guarded direct Bigbox checks against the exact staged Pi-hole address.",
      "Use Fleet for one owner-approved signed second-device proof only after direct evidence passes.",
    ],
  },
  "host.prerequisites": {
    category: "Host readiness",
    view: "repairs",
    steps: [
      "Review the live prerequisite list and identify only the requirement for the intended operation.",
      "Do not treat an optional feature check as a global server failure.",
      "Apply changes outside the Action Center through a typed, reviewed workflow, then inspect again.",
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
    category: "Evidence collection",
    title: "Action evidence is unavailable",
    summary: "BoxPilot could not collect the recovery evidence used by this view, so it will not report an all-clear state.",
    evidence: ["The recovery-kit collector did not return a complete result."],
    recommendation: {
      view: "repairs",
      title: "Inspect Repair Center",
      steps: [
        "Refresh the live prerequisite inventory.",
        "Confirm the BoxPilot service and restricted helper are active.",
        "Regenerate the recovery kit before relying on readiness claims.",
      ],
    },
    boundary: boundary(),
  };
}

export function createActionCenterService({ recoveryKit, now = () => new Date(), version = productVersion } = {}) {
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
      category: "Evidence collection",
      title: "New recovery evidence requires review",
      summary: "BoxPilot found recovery checks that do not yet have fixed Action Center guidance.",
      evidence: [`${unmapped} unmapped recovery check(s) were withheld from detailed guidance.`],
      recommendation: {
        view: "repairs",
        title: "Open Repair Center",
        steps: ["Review the complete recovery kit.", "Do not assume the omitted checks passed.", "Update BoxPilot before using Action Center guidance for the new checks."],
      },
      boundary: boundary(),
    });

    const failedJobs = kit.evidence.jobs.filter((item) => item.state === "failed").length;
    if (failedJobs > 0) notices.push({
      id: "jobs.failed",
      severity: "warning",
      category: "Durable operations",
      title: "Failed jobs need operator review",
      summary: "Review recorded failure and recovery guidance before repeating an operation.",
      evidence: [`${failedJobs} recent durable job(s) are in the failed state.`],
      recommendation: {
        view: "repairs",
        title: "Open Repair Center",
        steps: ["Expand each failed durable job.", "Read its recorded error and manual recovery guidance.", "Re-run inspection before creating a replacement job."],
      },
      boundary: boundary(),
    });

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

    notices.sort((left, right) => priority[left.severity] - priority[right.severity] || left.id.localeCompare(right.id));
    return response(notices, now, version, "ready");
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
