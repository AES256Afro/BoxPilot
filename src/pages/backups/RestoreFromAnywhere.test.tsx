import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppsTab from "./AppsTab";
import RestoreTab from "./RestoreTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const staging = (id: string) => json({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201);

/** Answers what `answer` knows; the rest fail quietly, as an older server would. */
function serve(answer: (url: string, init?: RequestInit) => Response | null) {
  const bodies: Record<string, string[]> = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const match = url.match(/\/operations\/([a-z.-]+)\/(jobs|run)$/);
    if (match) (bodies[match[1]] ??= []).push(init?.body as string);
    const answered = answer(url, init);
    if (answered) return answered;
    if (match?.[2] === "jobs") return staging(match[1]);
    return json({ error: `unexpected ${url}` }, 404);
  }));
  return bodies;
}

const snapshot = { artifact: "machine-snapshot-20261120T020000Z-11111111.tar.gz", sizeBytes: 41 * 1024 ** 2, createdAt: "2026-11-20T02:00:00.000Z", checksumSha256: "c".repeat(64), apps: 3, withData: 2 };
const sources = { sources: [
  { source: "local", root: "/var/lib/boxpilot-managed/machine-snapshots", available: true, snapshots: [snapshot] },
  { source: "mirror", root: "/mnt/boxpilot/backup/boxpilot-local-mirror/machine-snapshots", available: true, snapshots: [snapshot] },
], mount: { mounted: true, blocker: null } };
const described = (newer: boolean) => ({ source: "local", artifact: snapshot.artifact, createdAt: snapshot.createdAt, system: null, vms: null, apps: [
  newer
    ? { id: "immich", installed: true, newestBackup: "20261116T030000Z.tar.gz", snapshotArchive: "20261116T030000Z.tar.gz", dataAvailable: true, dataLocation: "mirror", dataArchive: "20261124T030000Z.tar.gz", dataNewer: true }
    : { id: "immich", installed: true, newestBackup: "20261116T030000Z.tar.gz", snapshotArchive: "20261116T030000Z.tar.gz", dataAvailable: true, dataLocation: "local", dataArchive: "20261116T030000Z.tar.gz", dataNewer: false },
] });

function restoreWorld() {
  return serve((url, init) => {
    if (url.includes("/api/v1/catalog")) return json({ applications: [] });
    if (url.endsWith("/operations/host.snapshot.sources/inspect")) return json({ result: sources });
    if (url.endsWith("/operations/host.snapshot.discover/inspect")) return json({ result: { locations: [], unanswered: [] } });
    if (url.endsWith("/operations/host.snapshot.describe/run")) return json({ result: described(!String(init?.body).includes("\"dataFrom\":\"snapshot\"")) });
    return null;
  });
}

// M91: a snapshot restore brings back each app's newest data, and lists each snapshot once.
describe("restoring from anywhere", () => {
  it("lists a snapshot on this server and the backup drive once, with how many apps come back with their data", async () => {
    restoreWorld();
    render(<RestoreTab csrfToken="csrf-token" role="owner" restores={[]} onChanged={() => {}} onOpenApps={() => {}} />);
    const buttons = await screen.findAllByRole("button", { name: /^Restore from the snapshot of/ });
    expect(buttons).toHaveLength(1);
    const row = buttons[0].closest("tr")!;
    expect(within(row).getByText("also on the backup drive")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "With their data" })).toBeTruthy();
    expect(within(row).getByText("2")).toBeTruthy();
  });

  it("restores each app's newest data by default, says it is newer than the snapshot, and can be told to use only the snapshot's", async () => {
    const bodies = restoreWorld();
    render(<RestoreTab csrfToken="csrf-token" role="owner" restores={[]} onChanged={() => {}} onOpenApps={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Restore from the snapshot of/ }));
    const sheet = await screen.findByRole("dialog", { name: /^Snapshot of/ });
    expect(await within(sheet).findByText(/^newer, /)).toBeTruthy();
    expect(JSON.parse(bodies["host.snapshot.describe"][0])).toEqual({ parameters: { source: "local", artifact: snapshot.artifact } });

    fireEvent.click(within(sheet).getByLabelText("Use each app's newest backup"));
    await waitFor(() => expect(bodies["host.snapshot.describe"]).toHaveLength(2));
    expect(JSON.parse(bodies["host.snapshot.describe"][1])).toEqual({ parameters: { source: "local", artifact: snapshot.artifact, dataFrom: "snapshot" } });
    await waitFor(() => expect(within(sheet).queryByText(/^newer, /)).toBeNull());
    // The apps chosen stay chosen when the choice of data changes.
    expect((within(sheet).getByLabelText("Restore immich") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Restore 1 app" }));
    await waitFor(() => expect(JSON.parse(bodies["host.snapshot.restore"]?.[0] ?? "{}")).toEqual({ parameters: { source: "local", artifact: snapshot.artifact, apps: ["immich"], restoreData: true, dataFrom: "snapshot" } }));
  });

  // M91 review: a newer archive passed over (an earlier release's, maybe a restore's copy of the app
  // installed empty) read the same as having nothing newer at all.
  it("says which newer backups a restore passes over, and why", async () => {
    const reason = "20261124T030000Z.tar.gz, taken after the snapshot, was written by an earlier BoxPilot whose record cannot say whether it is a restore's copy of the app installed empty, so it was not used.";
    serve((url) => {
      if (url.includes("/api/v1/catalog")) return json({ applications: [] });
      if (url.endsWith("/operations/host.snapshot.sources/inspect")) return json({ result: sources });
      if (url.endsWith("/operations/host.snapshot.discover/inspect")) return json({ result: { locations: [], unanswered: [] } });
      if (url.endsWith("/operations/host.snapshot.describe/run")) return json({ result: { ...described(false), apps: [{ ...described(false).apps[0], dataSkipped: [reason] }] } });
      return null;
    });
    render(<RestoreTab csrfToken="csrf-token" role="owner" restores={[]} onChanged={() => {}} onOpenApps={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Restore from the snapshot of/ }));
    const sheet = await screen.findByRole("dialog", { name: /^Snapshot of/ });
    expect(await within(sheet).findByText("1 newer backup not used")).toBeTruthy();
    expect(within(sheet).getByText(reason)).toBeTruthy();
  });

  it("lists apps that are not installed whose backups are kept, with a way to restore them", async () => {
    serve((url) => (url.endsWith("/operations/app.backups.counts/inspect")
      ? json({ result: { available: true, counts: { paperless: 4 }, notInstalled: [{ id: "paperless", name: "Paperless-ngx", backups: 4, newestAt: new Date().toISOString() }] } })
      : null));
    render(<AppsTab csrfToken="csrf-token" role="operator" protection={{ available: true, verdicts: [] }} protectionError={null} behind={[]} scheduling={null} onSchedule={() => {}} onChanged={() => {}} />);
    const panel = await screen.findByRole("table", { name: "Backups of apps that are not installed" });
    expect(within(panel).getByText("Paperless-ngx")).toBeTruthy();
    expect(within(panel).getByText("4")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Restore Paperless-ngx: open its backups" })).toBeTruthy();
  });
});
