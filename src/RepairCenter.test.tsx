import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RepairCenter from "./RepairCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Repair Center", () => {
  it("keeps the page usable when collectors return incomplete JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("Checks incomplete")).toBeTruthy();
    expect(screen.getByText("Prerequisites unavailable")).toBeTruthy();
    expect(screen.getByText("Protection checks incomplete")).toBeTruthy();
    expect(screen.getByText("Could not build the rebuild checklist")).toBeTruthy();
    expect(screen.getByText(/Activity is unavailable\./)).toBeTruthy();
    expect(screen.queryByText("0 of 0 ready")).toBeNull();
  });

  it("does not reuse old readiness counts after a failed prerequisite refresh", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return fail ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ checks: [{ id: "helper.boundary", group: "BoxPilot", name: "Helper", status: "ready", summary: "Ready", repair: null }] }));
      if (url.includes("/jobs")) return new Response(JSON.stringify({ jobs: [] }));
      return new Response("{}", { status: 503 });
    }));
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("1 of 1 ready")).toBeTruthy();
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Prerequisites unavailable")).toBeTruthy();
    expect(screen.queryByText("1 of 1 ready")).toBeNull();
  });

  it.each(["failed", "partial"])("does not report a healthy server when the problem scan is %s", async (mode) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/remediations")) return mode === "failed"
        ? new Response(JSON.stringify({ error: "helper unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ findings: [], counts: { critical: 0, warning: 0, info: 0 }, sourceStatus: "partial", unavailableChecks: ["Drives and mounts"] }));
      if (url.includes("prerequisites")) return new Response(JSON.stringify({ checks: [] }));
      if (url.includes("/jobs")) return new Response(JSON.stringify({ jobs: [] }));
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    }));
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("Checks incomplete")).toBeTruthy();
    expect(screen.getByText("Problem scan incomplete")).toBeTruthy();
    expect(screen.queryByText("Nothing needs fixing")).toBeNull();
    expect(screen.queryByText("Problem scan complete")).toBeNull();
    if (mode === "partial") expect(screen.getByText(/Could not check: Drives and mounts/)).toBeTruthy();
  });

  it("renders live checks and verifies the helper directly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) {
        return new Response(JSON.stringify({ checks: [
          { id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Typed protocol responded", repair: null },
          { id: "containers.docker", group: "Applications", name: "Docker Engine", status: "missing", summary: "Docker is unavailable", repair: { kind: "planned", description: "Install after approval" } },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/operations/canary.verify/inspect")) {
        return new Response(JSON.stringify({ operation: "canary.verify", result: { verified: true, helperVersion: "0.61.0", mutationPerformed: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) {
        return new Response(JSON.stringify({
          generatedAt: "2026-08-16T05:00:00.000Z",
          sourceStatus: "ready",
          summary: { critical: 0, warning: 1, info: 0, total: 1 },
          notices: [{
            id: "recovery.router.checkpoint", severity: "warning", category: "Router recovery", title: "Router configuration checkpoint", summary: "Export and hash the active router configuration.",
            evidence: ["No router backup identity is recorded.", "Recovery evidence state: action-required."],
            recommendation: { view: "routers", title: "Open Routers", steps: ["Export the active configuration.", "Keep the file independently.", "Record its SHA-256."] },
            boundary: { mutationPerformed: false, automaticFixAvailable: false, commandsIncluded: false, secretsIncluded: false, logsIncluded: false },
          }],
          boundary: { mutationPerformed: false, automaticRepair: false, persistence: false, browserNotifications: false, externalDelivery: false, credentialsIncluded: false, arbitraryLogsIncluded: false },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("recovery-kit")) {
        return new Response(JSON.stringify({
          schemaVersion: 1, generatedAt: "2026-08-16T04:05:00.000Z", product: { name: "BoxPilot", version: "0.26.0" },
          summary: { status: "action-required", verified: 1, actionRequired: 1, operatorChecks: 2, notApplicable: 4, total: 8 },
          checks: [
            { id: "controller.database", state: "operator-check", title: "Independent BoxPilot database copy", evidence: "The controller cannot prove an off-host copy.", action: "Create and verify an independent copy." },
            { id: "router.checkpoint", state: "action-required", title: "Router configuration checkpoint", evidence: "No checkpoint exists.", action: "Export and hash the active router configuration." },
          ],
          evidence: { jobs: [], controllerBackups: [], controllerProtections: [], controllerRetentionRuns: [], applications: [], virtualMachines: [], vmBackups: [], prerequisites: [] },
          boundary: { mutationsPerformed: false, databaseCopied: false, backupDataIncluded: false, configurationFilesIncluded: false, credentialsIncluded: false, excluded: ["credentials"] },
          runbookMarkdown: "# BoxPilot recovery kit\n",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Restricted helper")).toBeTruthy();
    expect(screen.getByText("Docker Engine")).toBeTruthy();
    expect(screen.getByText("Rebuild checklist")).toBeTruthy();
    expect(screen.getByText("Protection gaps")).toBeTruthy();
    expect(screen.getByText("Independent BoxPilot database copy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download rebuild steps (.md)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download recovery data (.json)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check helper" }));
    expect(await screen.findByText(/version 0.61.0/)).toBeTruthy();
  });

  it("puts problems first, with the fix each one needs, and stages it on click", async () => {
    // The failure this page was rebuilt around: a drive that came back under a new kernel name,
    // leaving the mount pointing at nothing while every other check on the box looked fine.
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let staged: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      if (url.includes("/remediations")) return json({
        counts: { critical: 1, warning: 0, info: 1 },
        findings: [
          { id: "stale-mount:the-dump", severity: "critical", title: "/mnt/the-dump is mounted from a drive that is gone", detail: "The mount still points at /dev/sda2, which no longer exists.", evidence: ["mounted from /dev/sda2"], fix: { operationId: "storage.remount", parameters: { name: "the-dump" }, label: "Reconnect the drive", preview: "Mounts it again from fstab." }, manual: null },
          { id: "share-unwritable:media", severity: "info", title: "Nobody can write to the media share", detail: "Owned by root.", evidence: [], fix: null, manual: "Hand the folder to a user on the Storage page." },
        ],
      });
      if (url.includes("/operations/storage.remount/jobs")) { staged = JSON.parse(String(init?.body)); return json({ job: { id: "j1", title: "Reconnect the drive", state: "awaiting_approval", risk: "medium", steps: [], error: null } }); }
      return json({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText(/^2 things to fix, 1 of them critical/)).toBeTruthy();
    expect(screen.getByText("/mnt/the-dump is mounted from a drive that is gone")).toBeTruthy();
    // Worst first: the critical group comes before the suggestions.
    const groups = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")).filter((label) => /^(Critical|To fix|Suggestions)/.test(label ?? ""));
    expect(groups).toEqual(["Critical, 1", "Suggestions, 1"]);
    // A finding with no automatic fix shows what to do by hand instead of an unusable button.
    expect(screen.getByText(/Hand the folder to a user on the Storage page\./)).toBeTruthy();
    // The fix carries its tier on the button, before the click.
    const reconnect = screen.getByRole("button", { name: /^Reconnect the drive: / });
    expect(reconnect.getAttribute("data-risk")).toBe("medium");

    fireEvent.click(reconnect);
    await waitFor(() => expect(staged).toMatchObject({ parameters: { name: "the-dump" } }));
    unmount();
  });

  it("approves a low-risk job with one click and asks for the password only when the policy requires it", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const job = { id: "job-low", title: "Restart Uptime Kuma", type: "application.uptime-kuma.action", state: "awaiting_approval", risk: "low", error: null, steps: [], recovery: { reason: "Reversible" } };
    let approved: RequestInit | undefined;
    let policy = { jobId: "job-low", tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "low risk" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      if (url.endsWith("/approval")) return json(policy);
      if (url.endsWith("/approve")) { approved = init; return json({ job: { ...job, state: "completed" } }); }
      return json({ jobs: [job] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Low risk · one click")).toBeTruthy();
    expect(screen.queryByLabelText("Approval password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await vi.waitFor(() => expect(approved).toBeTruthy());
    expect(approved?.body).toBe("{}");
    unmount();

    policy = { jobId: "job-low", tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" };
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("High risk · password required")).toBeTruthy();
    const input = screen.getByLabelText("Approval password");
    const button = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "correct horse battery" } });
    expect(button.disabled).toBe(false);
  });

  it("shows what a waiting job will run, and lets it be withdrawn instead", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const job = { id: "job-fmt", title: "Erase and format a disk", type: "op:storage.format", state: "awaiting_approval", risk: "high", error: null, steps: [], parameters: { device: "/dev/sdb", filesystem: "ext4" } };
    let withdrawn = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      if (url.endsWith("/approval")) return json({ jobId: "job-fmt", tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk", confirmText: "/dev/sdb" });
      if (url.endsWith("/jobs/job-fmt") && init?.method === "DELETE") { withdrawn = true; return json({ job: { ...job, state: "cancelled" } }); }
      return json({ jobs: [withdrawn ? { ...job, state: "cancelled" } : job] });
    }));
    render(<RepairCenter csrfToken="csrf-token" />);
    const details = await screen.findByLabelText("What this job will run");
    expect(details.textContent).toContain("storage.format");
    expect(details.textContent).toContain("/dev/sdb");
    expect(details.textContent).toContain("ext4");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await vi.waitFor(() => expect(withdrawn).toBe(true));
    await vi.waitFor(() => expect(screen.queryByLabelText("What this job will run")).toBeNull());
  });

  it("renders a job that arrived without a recovery block", async () => {
    // The type said recovery was always there; a job without it threw inside a map and took the
    // whole page down — a blank screen at the moment somebody is trying to repair something.
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const job = { id: "job-bare", title: "Mount a network share", type: "op:share.mount", state: "failed", risk: "medium", error: "The share does not exist on that host.", steps: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      return json({ jobs: [job] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("Mount a network share")).toBeTruthy();
    expect(screen.getByText(/The share does not exist on that host/)).toBeTruthy();
  });

  it("keeps prerequisites and jobs available when recovery-kit collection fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return new Response(JSON.stringify({ checks: [{ id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Ready", repair: null }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "Action collector unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "Collector unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Restricted helper")).toBeTruthy();
    expect(screen.getByText("Could not build the rebuild checklist")).toBeTruthy();
    expect(screen.getByText(/The rest of this page still works/)).toBeTruthy();
  });

  it("reviews a pinned repair through the registry inspect and stages it in the shared dialog", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return json({ checks: [{ id: "storage.drive-tools", group: "Storage", name: "Drive check tools", status: "repairable", summary: "exfatprogs is not installed; Ubuntu's package lists offer exfatprogs 1.2.2-1", repair: { kind: "approved", description: "Review the exact versions" } }] });
      if (url.endsWith("/operations/prerequisite.drive-tools.inspect/inspect")) return json({ operation: "prerequisite.drive-tools.inspect", result: { installed: false, missing: ["exfatprogs"], candidatePackages: { exfatprogs: "1.2.2-1" }, repairAvailable: true } });
      if (url.endsWith("/operations/prerequisite.drive-tools.install/jobs")) { staged = init?.body as string; return json({ job: { id: "job-s", type: "op:prerequisite.drive-tools.install", title: "Install the drive check tools", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      return json({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review exact repair" }));
    expect(await screen.findByText("Install the drive check tools")).toBeTruthy();
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.getByText("exfatprogs 1.2.2-1")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { expectedPackages: { exfatprogs: "1.2.2-1" } } }));
  });

  it("pins the exact five-package set when staging the virtualization install", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const candidatePackages = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return json({ checks: [{ id: "virtualization.libvirt", group: "Virtualization", name: "KVM, QEMU, and libvirt", status: "repairable", summary: "Every fixed candidate is available", repair: { kind: "approved", description: "Review the exact five-package plan" } }] });
      if (url.endsWith("/operations/prerequisite.virtualization.inspect/inspect")) return json({ operation: "prerequisite.virtualization.inspect", result: { installed: false, candidatePackages } });
      if (url.endsWith("/operations/prerequisite.virtualization.install/jobs")) { staged = init?.body as string; return json({ job: { id: "job-v", type: "op:prerequisite.virtualization.install", title: "Install KVM/QEMU/libvirt", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      return json({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review exact repair" }));
    expect(await screen.findByText(/qemu-system-x86 1:10.2.1/)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { expectedPackages: candidatePackages } }));
  });

  it("offers to reconnect a dropped drive automatically next time, and says when it is waiting for a person", async () => {
    // M26.5: armed from the notice that says the drive dropped, with every guardrail in one sentence.
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const limits = { cooldownMinutes: 30, maxAttempts: 3, windowHours: 24 };
    let status: { limits: typeof limits; drives: Record<string, unknown> } = { limits, drives: {} };
    let armed: { method?: string; csrf: string | null } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      if (url.includes("/remediations")) return json({
        counts: { critical: 1, warning: 0, info: 0 },
        findings: [{ id: "read-only-remount:the-dump", severity: "critical", title: "/mnt/the-dump has gone read-only", detail: "The filesystem hit errors.", evidence: [], fix: { operationId: "storage.remount", parameters: { name: "the-dump" }, label: "Reconnect the drive", preview: "Mounts it again from fstab." }, manual: null }],
      });
      if (url === "/api/v1/drives/auto-reconnect") return json(status);
      if (url === "/api/v1/drives/the-dump/auto-reconnect") {
        armed = { method: init?.method, csrf: new Headers(init?.headers).get("X-BoxPilot-CSRF") };
        status = { limits, drives: { "the-dump": { flowId: "flow-1", flowName: "Reconnect /mnt/the-dump when it drops", enabled: true, held: true, heldSince: "2026-09-28T03:00:00Z", heldBecause: "the last automatic reconnect did not work", attempts: 1, lastAttemptAt: "2026-09-28T03:00:00Z", lastOutcome: "failed", lastCheckFoundErrors: false } } };
        return json({ flow: { id: "flow-1" } }, 201);
      }
      return json({ jobs: [] });
    }));
    render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText(/at most 3 times a day and 30 minutes apart, never while the drive is being checked or after a check found errors, and not again after a failed try until you reconnect it yourself/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect it automatically next time: /mnt/the-dump" }));
    // The Reconnect button beside it is the "by hand" that lifts the hold.
    expect(await screen.findByText("Waiting for you: the last automatic reconnect did not work. Reconnecting it here by hand starts it again.")).toBeTruthy();
    expect(armed).toEqual({ method: "POST", csrf: "csrf-token" });
    expect(screen.getByRole("button", { name: "Stop reconnecting automatically: /mnt/the-dump" })).toBeTruthy();
    // The one-off fix is still there beside it.
    expect(screen.getByRole("button", { name: /^Reconnect the drive: / })).toBeTruthy();
  });
});

describe("Repair that fixes (M35)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const writable = { operationId: "storage.writable", parameters: { name: "the-dump" }, label: "Let apps write to the drive", preview: "Adds uid=1000,gid=1000 to /mnt/the-dump's fstab entry, then reconnects it.", risk: "medium" };
  const exfat = { id: "permissionless-mount:the-dump", severity: "warning", title: "Only root can write to /mnt/the-dump", detail: "exfat does not store owners.", evidence: ["exfat mounted without uid="], fix: writable, fixes: [writable], manual: null, fingerprint: "0123456789abcdef", lastAttempt: null };
  const scan = (findings: unknown[], extra: Record<string, unknown> = {}) => ({ findings, dismissed: [], counts: { critical: 0, warning: findings.length, info: 0 }, jobs: { attached: [], resolved: [], dismissed: [] }, sourceStatus: "ready", unavailableChecks: [], ...extra });
  const staged = (id: string, operation: string, tier = "medium", passwordRequired = false) => json({ job: { id, type: `op:${operation}`, title: operation, state: "awaiting_approval", risk: tier, error: null, result: null, steps: [], approvals: [] }, approval: { tier, passwordRequired, elevated: false, mode: "tiered", reason: `${tier} risk` } }, 201);

  /** The server around one fix: scans answered in turn, staging, approval, and the job's ending. */
  function server({ scans, finished }: { scans: unknown[]; finished: (id: string) => Record<string, unknown> }) {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let scanned = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      if (url === "/api/v1/remediations") { const answer = scans[Math.min(scanned, scans.length - 1)]; scanned += 1; return json(answer); }
      if (url === "/api/v1/remediations/attempts") return json({ recorded: true }, 201);
      if (url === "/api/v1/remediations/dismissals") return json({ dismissed: true }, 201);
      const stage = url.match(/^\/api\/v1\/operations\/([^/]+)\/jobs$/);
      if (stage) return staged(`job-${requests.filter((entry) => /\/jobs$/.test(entry.url) && entry.method === "POST").length}`, stage[1], stage[1] === "app.action" ? "low" : "medium");
      if (/\/approve$/.test(url)) return json({ job: { id: url.split("/")[4], state: "applying" }, elevatedUntil: null }, 202);
      const job = url.match(/^\/api\/v1\/jobs\/([^/?]+)$/);
      if (job && method === "GET") return json({ job: { id: job[1], type: "op:storage.writable", title: "Let apps write to a drive", risk: "medium", steps: [], approvals: [], ...finished(job[1]) } });
      if (job && method === "DELETE") return json({ job: { id: job[1], state: "cancelled" } });
      if (/\/output$/.test(url)) return json({ output: "$ docker stop bp-plex\n$ umount /mnt/the-dump\n$ mount /mnt/the-dump\n" });
      return json({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { requests };
  }

  it("runs a fix through the approval dialog, streams its log in the card, and says Fixed with what changed", async () => {
    const { requests } = server({ scans: [scan([exfat]), scan([])], finished: () => ({ state: "completed", error: null, result: { writable: true, mountpoint: "/mnt/the-dump", owner: "1000:1000", restarted: ["bp-plex"], sharingClosedFor: [] } }) });
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Let apps write to the drive: / }));
    // The ordinary approval dialog, at the fix's own tier.
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText(/\/mnt\/the-dump now belongs to 1000:1000, so apps and file shares can write there\. plex was started again\./)).toBeTruthy();
    expect(screen.getByText("Fixed")).toBeTruthy();
    // The job was recorded against the finding it fixes, approved without a password, and the scan read again.
    expect(requests.find((entry) => entry.url === "/api/v1/remediations/attempts")?.body).toEqual({ findingId: "permissionless-mount:the-dump", jobId: "job-1" });
    expect(requests.find((entry) => entry.url.endsWith("/approve"))?.body).toEqual({});
    expect(requests.filter((entry) => entry.url === "/api/v1/remediations")).toHaveLength(2);
  });

  it("says Still there, with the job's own error and the next step, when the fix fails", async () => {
    const failing = { ...exfat, manual: "Plug the drive in again, then try again." };
    server({ scans: [scan([failing])], finished: () => ({ state: "failed", error: "/mnt/the-dump is still in use by smbd (4242), so it was left mounted as it was", result: null }) });
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Let apps write to the drive: / }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Still there")).toBeTruthy();
    // Said at the head of the card's run, and again by the job's own log view below it.
    expect(screen.getByText("/mnt/the-dump is still in use by smbd (4242), so it was left mounted as it was", { selector: ".rp-run__head > span:last-child" })).toBeTruthy();
    expect(screen.getByText(/Plug the drive in again, then try again\./, { selector: ".rp-run__next" })).toBeTruthy();
    // Its log is right there in the card.
    expect(await screen.findByLabelText("Output for Let apps write to the drive")).toBeTruthy();
  });

  it("shows the last failed try on its finding, and its fix as Try again", async () => {
    const tried = { ...exfat, lastAttempt: { jobId: "job-0", state: "failed", error: "umount: /mnt/the-dump: target is busy", at: "2026-09-29T10:00:00.000Z", title: "Let apps write to a drive", operationId: "storage.writable", label: "Let apps write to the drive" } };
    server({ scans: [scan([tried])], finished: () => ({ state: "failed" }) });
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText(/umount: \/mnt\/the-dump: target is busy/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Try again: Let apps write to the drive: / })).toBeTruthy();
  });

  it("offers the place a failed try names, not Try again, when the same fix would stop the same way", async () => {
    const tried = { ...exfat, lastAttempt: { jobId: "job-0", state: "failed", error: "tar failed: No space left on device", at: "2026-09-29T10:00:00.000Z", title: "Let apps write to a drive", operationId: "storage.writable", label: "Let apps write to the drive" } };
    server({ scans: [scan([tried])], finished: () => ({ state: "failed" }) });
    const onNavigate = vi.fn();
    render(<RepairCenter csrfToken="csrf-token" onNavigate={onNavigate} />);
    expect(await screen.findByText(/Trying again would stop the same way/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Try again: / })).toBeNull();
    // The fix itself stays, under its own name; the way to what comes first leads.
    expect(screen.getByRole("button", { name: /^Let apps write to the drive: / })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Free up space: / }));
    expect(onNavigate).toHaveBeenCalledWith("system", { tab: "housekeeping" });
  });

  it("says the fix is on this page when a failed try names Repair itself, rather than a button that goes nowhere", async () => {
    const tried = { ...exfat, lastAttempt: { jobId: "job-0", state: "failed", error: "fsck.exfat is not installed, so nothing was stopped or unmounted. Install the drive check tools from Repair first.", at: "2026-09-29T10:00:00.000Z", title: "Let apps write to a drive", operationId: "storage.writable", label: "Let apps write to the drive" } };
    server({ scans: [scan([tried])], finished: () => ({ state: "failed" }) });
    render(<RepairCenter csrfToken="csrf-token" onNavigate={vi.fn()} />);
    expect(await screen.findByText(/the fix it names is on this page/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open Repair/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Try again: / })).toBeNull();
  });

  it("runs every low-risk fix after one confirmation that lists them, and leaves the rest to their own buttons", async () => {
    const restart = (id: string) => ({ id: `stale-bind:bp-${id}`, severity: "warning", title: `${id} is still using the old copy of its folder`, detail: "", evidence: [], fix: { operationId: "app.action", parameters: { id, action: "restart" }, label: `Restart ${id}`, preview: `Restarts ${id}.`, risk: "low" }, fixes: [{ operationId: "app.action", parameters: { id, action: "restart" }, label: `Restart ${id}`, preview: `Restarts ${id}.`, risk: "low" }], manual: null, fingerprint: "0123456789abcdef" });
    const { requests } = server({ scans: [scan([restart("plex"), restart("jellyfin"), exfat]), scan([exfat])], finished: () => ({ state: "completed", error: null, result: { id: "x", status: "running" } }) });
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fix the safe ones (2)" }));
    const dialog = await screen.findByRole("dialog", { name: "Fix the safe ones" });
    expect(dialog.textContent).toContain("Restart plex");
    expect(dialog.textContent).toContain("Restart jellyfin");
    expect(dialog.textContent).not.toContain("Let apps write to the drive");
    fireEvent.click(screen.getByRole("button", { name: "Run all 2" }));
    await waitFor(() => expect(requests.filter((entry) => entry.url === "/api/v1/remediations")).toHaveLength(2));
    const staging = requests.filter((entry) => entry.method === "POST" && /\/operations\/[^/]+\/jobs$/.test(entry.url));
    expect(staging.map((entry) => [entry.url, entry.body])).toEqual([
      ["/api/v1/operations/app.action/jobs", { parameters: { id: "plex", action: "restart" } }],
      ["/api/v1/operations/app.action/jobs", { parameters: { id: "jellyfin", action: "restart" } }],
    ]);
    // Each is approved as its own job with one click: no password rides along.
    expect(requests.filter((entry) => entry.url.endsWith("/approve")).map((entry) => entry.body)).toEqual([{}, {}]);
    expect(await screen.findAllByText("Fixed")).toHaveLength(2);
  });

  it("stops the batch where the server wants more than one click, and runs nothing it did not approve", async () => {
    const restart = { id: "stale-bind:bp-plex", severity: "warning", title: "plex is still using the old copy", detail: "", evidence: [], fix: { operationId: "app.action", parameters: { id: "plex", action: "restart" }, label: "Restart plex", preview: "Restarts plex.", risk: "low" }, manual: null, fingerprint: "0123456789abcdef" };
    const { requests } = server({ scans: [scan([restart])], finished: () => ({ state: "completed" }) });
    // Approvals set to always ask: every job wants the password, low risk included.
    const base = (globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!/\/operations\/app\.action\/jobs$/.test(input.toString())) return base(input, init);
      await base(input, init);   // recorded like any other request
      return staged("job-9", "app.action", "low", true);
    }));
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fix the safe ones (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run it" }));
    expect(await screen.findByText(/Approvals ask for your password on every job right now/)).toBeTruthy();
    expect(requests.some((entry) => entry.url.endsWith("/approve"))).toBe(false);
    expect(requests.some((entry) => entry.method === "DELETE" && entry.url === "/api/v1/jobs/job-9")).toBe(true);
  });

  it("sets a finding aside with a reason, and never offers that for a critical one", async () => {
    const critical = { ...exfat, id: "read-only-remount:the-dump", severity: "critical", title: "/mnt/the-dump has gone read-only" };
    const { requests } = server({ scans: [scan([critical, exfat]), scan([critical], { dismissed: [{ ...exfat, dismissal: { reason: "Only a camera card", at: "2026-09-29T11:00:00.000Z", by: "owner-1" } }] })], finished: () => ({ state: "completed" }) });
    render(<RepairCenter csrfToken="csrf-token" />);
    await screen.findByText("/mnt/the-dump has gone read-only");
    expect(screen.queryByRole("button", { name: "Dismiss: /mnt/the-dump has gone read-only" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Only root can write to /mnt/the-dump" }));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);   // a reason first
    fireEvent.change(screen.getByLabelText(/Why\?/), { target: { value: "Only a camera card" } });
    fireEvent.click(dismiss);
    await waitFor(() => expect(requests.find((entry) => entry.url === "/api/v1/remediations/dismissals")?.body).toEqual({ id: "permissionless-mount:the-dump", fingerprint: "0123456789abcdef", severity: "warning", reason: "Only a camera card" }));
    // It moves to Dismissed, with the reason, where it can be brought back.
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect(screen.getByText("Only a camera card")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bring back: Only root can write to /mnt/the-dump" })).toBeTruthy();
  });

  it("creates the nightly schedules Back up nightly lists, after saying what they are", async () => {
    const nightly = { kind: "schedule", operationId: "app.backup", label: "Back up nightly", preview: "Schedules a nightly backup of AuDHDMAP and Protec.", risk: "medium", schedules: [{ parameters: { id: "audhdmap" }, frequency: "daily", hour: 2, minute: 0 }, { parameters: { id: "protec" }, frequency: "daily", hour: 3, minute: 0 }] };
    const now = { operationId: "app.backup.many", parameters: { ids: ["audhdmap", "protec"] }, label: "Back up now", preview: "Backs up both.", risk: "medium" };
    const due = { id: "backups-due", severity: "warning", title: "AuDHDMAP and Protec have not been backed up recently", detail: "", evidence: [], fix: now, fixes: [now, nightly], manual: null, fingerprint: "0123456789abcdef" };
    const posted: unknown[] = [];
    server({ scans: [scan([due])], finished: () => ({ state: "completed" }) });
    const base = (globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() === "/api/v1/schedules" && init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return json({ schedule: { id: "s1" } }, 201); }
      return base(input, init);
    }));
    render(<RepairCenter csrfToken="csrf-token" />);
    const button = await screen.findByRole("button", { name: /^Back up nightly: / });
    expect(button.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(button);
    expect(await screen.findByText(/every night at 02:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create 2 schedules" }));
    await waitFor(() => expect(posted).toEqual([
      { operationId: "app.backup", parameters: { id: "audhdmap" }, frequency: "daily", minute: 0, hour: 2, weekday: null },
      { operationId: "app.backup", parameters: { id: "protec" }, frequency: "daily", minute: 0, hour: 3, weekday: null },
    ]));
    expect(await screen.findByText(/Scheduled 2 nightly backups; the first runs tonight/)).toBeTruthy();
  });

  it("offers no fix buttons, and no dismissing, to a viewer", async () => {
    server({ scans: [scan([exfat])], finished: () => ({ state: "completed" }) });
    render(<RepairCenter csrfToken="csrf-token" role="viewer" />);
    await screen.findByText("Only root can write to /mnt/the-dump");
    expect(screen.queryByRole("button", { name: /^Let apps write to the drive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Dismiss/ })).toBeNull();
  });
});
