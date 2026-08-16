import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VmMediaLibrary from "./VmMediaLibrary";

const candidate = {
  name: "ubuntu.iso",
  sizeBytes: 4096,
  sha256: "a".repeat(64),
  uploadedAt: "2026-08-16T20:00:00.000Z",
  modifiedAt: "2026-08-16T20:00:00.000Z",
  revision: "b".repeat(64),
};

const inventory = {
  inbox: { path: "/fixed/inbox", candidates: [candidate] },
  library: { path: "/var/lib/libvirt/boot", images: [] },
  limits: { maximumIsoBytes: 16 * 1024 ** 3 },
  boundary: { browserPathAccepted: false, arbitraryDestinationAccepted: false, checksumVerifiedDuringImport: true, existingMediaOverwritten: false, mutationPerformed: false },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VM media library", () => {
  it("reviews and stages an exact uploaded ISO import", async () => {
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/v1/virtualization/media") return new Response(JSON.stringify(inventory));
      if (url === "/api/v1/virtualization/media/import-plans") return new Response(JSON.stringify({ plan: {
        id: "plan-one", revision: "plan-revision", status: "draft", expiresAt: "2026-08-16T21:00:00.000Z", executable: true,
        input: { importId: "77777777-7777-4777-8777-777777777777", filename: candidate.name, expectedSizeBytes: candidate.sizeBytes, expectedSha256: candidate.sha256, expectedRevision: candidate.revision },
        candidate, destination: "/var/lib/libvirt/boot", changes: ["Copy exact ISO"], verification: ["Rehash source and destination"], boundaries: ["No existing ISO is overwritten"], recovery: "Remove only generated import state.", adapterRevision: candidate.revision,
      } }), { status: 201 });
      if (url === "/api/v1/virtualization/media/import-plans/plan-one/stage") {
        expect(init).toMatchObject({ method: "POST" });
        return new Response(JSON.stringify({ job: { id: "job-one", state: "awaiting_approval", title: "Import ubuntu.iso" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
    }));
    render(<VmMediaLibrary csrfToken="csrf-one" onOpenRepair={onOpenRepair} />);
    expect(await screen.findByText("Awaiting import approval")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(await screen.findByRole("heading", { name: "Import ubuntu.iso" })).toBeTruthy();
    expect(screen.getByText(candidate.sha256)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledOnce());
  });

  it("uploads raw ISO bytes before any import plan exists", async () => {
    let inventoryReads = 0;
    const fetchMock = vi.fn(async (url, init) => {
      if (url === "/api/v1/virtualization/media") {
        inventoryReads += 1;
        return new Response(JSON.stringify({ ...inventory, inbox: { ...inventory.inbox, candidates: inventoryReads > 1 ? [candidate] : [] } }));
      }
      if (url === "/api/v1/virtualization/media/uploads") {
        expect(init).toMatchObject({ method: "POST", body: expect.any(File) });
        expect(new Headers(init?.headers).get("X-BoxPilot-Filename")).toBe("ubuntu.iso");
        return new Response(JSON.stringify({ upload: candidate }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<VmMediaLibrary csrfToken="csrf-one" onOpenRepair={() => {}} />);
    await screen.findByText("0 usable ISOs");
    const file = new File(["iso bytes"], "ubuntu.iso", { type: "application/x-iso9660-image" });
    fireEvent.change(screen.getByLabelText("Select ISO"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload to staging" }));
    expect(await screen.findByText(/Uploaded ubuntu\.iso/)).toBeTruthy();
    expect(await screen.findByText("Awaiting import approval")).toBeTruthy();
  });
});
