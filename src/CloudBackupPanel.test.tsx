import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CloudBackupPanel from "./CloudBackupPanel";
import type { PendingOperation } from "./ApproveDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const providers = {
  b2: { label: "Backblaze B2", fields: ["account", "bucket", "path"], secrets: ["key"], help: "Create an application key." },
  s3: { label: "S3-compatible", fields: ["endpoint", "region", "bucket", "path", "accessKeyId"], secrets: ["secretAccessKey"], help: "S3 help." },
  drive: { label: "Google Drive", fields: ["path"], secrets: ["token"], help: "Run rclone authorize." },
};
function setup(inspect: unknown, settings: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith("/operations/backup.cloud.inspect/inspect")) return json({ operation: "backup.cloud.inspect", result: inspect });
    if (url.endsWith("/settings/cloud-destination")) return json(settings);
    return json({ error: "unexpected" });
  }));
  const start = vi.fn<(operation: PendingOperation) => void>();
  render(<CloudBackupPanel start={start} />);
  return start;
}

describe("Cloud backup panel", () => {
  it("offers rclone installation and stages the destination with its secret once complete", async () => {
    const start = setup({ rcloneInstalled: false, configured: false, provider: null, providers }, { destination: null, lastSync: null });
    fireEvent.click(await screen.findByRole("button", { name: "Install rclone" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "apt.install", parameters: { packages: ["rclone"] } }));
    cleanup();

    const start2 = setup({ rcloneInstalled: true, configured: false, provider: null, providers }, { destination: null, lastSync: null });
    await screen.findByLabelText("Cloud provider");
    expect((screen.getByRole("button", { name: "Save destination" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Key ID"), { target: { value: "0012abc" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "home-backups" } });
    fireEvent.change(screen.getByLabelText("Application key"), { target: { value: "K123" } });
    expect((screen.getByRole("button", { name: "Save destination" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
    expect(start2).toHaveBeenCalledWith(expect.objectContaining({ operationId: "backup.cloud.setup", parameters: { provider: "b2", account: "0012abc", bucket: "home-backups", key: "K123" } }));
  });

  it("shows the saved destination with test and mirror actions, and switches providers", async () => {
    const start = setup({ rcloneInstalled: true, configured: true, provider: "b2", providers }, { destination: { provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox" }, lastSync: { completedAt: "2026-08-21T21:30:00.000Z", filesTransferred: 7, bytesTransferred: "1.2 GiB", destination: "boxpilot:home-backups/homebox" } });
    expect(await screen.findByText(/last mirrored/)).toBeTruthy();
    expect((screen.getByLabelText("Bucket") as HTMLInputElement).value).toBe("home-backups");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "backup.cloud.test", parameters: {} }));
    fireEvent.click(screen.getByRole("button", { name: "Mirror now" }));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "backup.cloud.sync", parameters: {} }));
    fireEvent.change(screen.getByLabelText("Cloud provider"), { target: { value: "drive" } });
    expect(screen.getByLabelText("Token (from rclone authorize)")).toBeTruthy();
  });
});
