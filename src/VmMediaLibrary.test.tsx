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
  it("stages an exact uploaded ISO import through the shared approval dialog", async () => {
    let staged: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/v1/virtualization/media") return new Response(JSON.stringify(inventory));
      if (url === "/api/v1/operations/vm.media.import/jobs") {
        staged = init?.body as string;
        return new Response(JSON.stringify({
          job: { id: "job-one", type: "op:vm.media.import", title: "Import a staged ISO", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] },
          approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
    }));
    render(<VmMediaLibrary csrfToken="csrf-one" />);
    expect(await screen.findByText("Awaiting import approval")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { filename: "ubuntu.iso" } });
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
