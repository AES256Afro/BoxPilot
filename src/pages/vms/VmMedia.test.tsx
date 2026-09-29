import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingOperation } from "../../ApproveDialog";
import { VmMedia } from "./VmMedia";

const candidate = { name: "ubuntu.iso", sizeBytes: 4096, sha256: "a".repeat(64), uploadedAt: "2026-08-16T20:00:00.000Z", modifiedAt: "2026-08-16T20:00:00.000Z", revision: "b".repeat(64) };
const inventory = {
  inbox: { path: "/fixed/inbox", candidates: [candidate] },
  library: { path: "/var/lib/libvirt/boot", images: [{ name: "debian.iso", sizeBytes: 700 * 1024 ** 2, modifiedAt: "2026-08-10T10:00:00.000Z" }] },
  limits: { maximumIsoBytes: 16 * 1024 ** 3 },
  boundary: { browserPathAccepted: false, arbitraryDestinationAccepted: false, checksumVerifiedDuringImport: true, existingMediaOverwritten: false, mutationPerformed: false },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("VM installation media", () => {
  it("lists the library and stages an uploaded ISO's import with its tier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(inventory))));
    const start = vi.fn<(operation: PendingOperation) => void>();
    render(<VmMedia csrfToken="csrf-one" role="owner" start={start} refreshKey={0} />);
    expect(await screen.findByText("debian.iso")).toBeTruthy();
    expect(screen.getByText("Uploaded, not yet added")).toBeTruthy();
    const importButton = screen.getByRole("button", { name: "Import ubuntu.iso" });
    expect(importButton.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(importButton);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "vm.media.import", parameters: { filename: "ubuntu.iso" } }));
  });

  it("uploads raw ISO bytes to staging before any import exists", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/v1/virtualization/media") {
        reads += 1;
        return new Response(JSON.stringify({ ...inventory, library: { ...inventory.library, images: [] }, inbox: { ...inventory.inbox, candidates: reads > 1 ? [candidate] : [] } }));
      }
      if (url === "/api/v1/virtualization/media/uploads") {
        expect(init).toMatchObject({ method: "POST", body: expect.any(File) });
        expect(new Headers(init?.headers).get("X-BoxPilot-Filename")).toBe("ubuntu.iso");
        return new Response(JSON.stringify({ upload: candidate }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
    }));
    render(<VmMedia csrfToken="csrf-one" role="owner" start={vi.fn()} refreshKey={0} />);
    expect(await screen.findByText("No ISO in the library yet")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Select ISO"), { target: { files: [new File(["iso bytes"], "ubuntu.iso", { type: "application/x-iso9660-image" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload to staging" }));
    expect(await screen.findByText(/Uploaded ubuntu\.iso/)).toBeTruthy();
    expect(await screen.findByText("Uploaded, not yet added")).toBeTruthy();
  });

  it("gives a viewer the library and neither the upload nor the import", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(inventory))));
    render(<VmMedia csrfToken="csrf-one" role="viewer" start={vi.fn()} refreshKey={0} />);
    expect(await screen.findByText("debian.iso")).toBeTruthy();
    expect(screen.queryByLabelText("Select ISO")).toBeNull();
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
  });
});
