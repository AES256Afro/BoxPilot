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

const catalogImage = {
  id: "ubuntu-server-26.04-amd64", label: "Ubuntu Server 26.04 LTS", release: "26.04", architecture: "amd64", name: "ubuntu-26.04-live-server-amd64.iso",
  sizeBytes: 2918598656, sha256: "c".repeat(64), sourceUrl: "https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso",
  checksumUrl: "https://releases.ubuntu.com/26.04/SHA256SUMS", signatureUrl: "https://releases.ubuntu.com/26.04/SHA256SUMS.gpg", state: "available",
};

const catalog = { revision: "d".repeat(64), images: [catalogImage], boundary: { officialHostOnly: "releases.ubuntu.com", arbitraryUrlAccepted: false, browserDigestAccepted: false, automaticDownload: false, importAutomatic: false } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VM media library", () => {
  it("reviews and stages an exact uploaded ISO import", async () => {
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/v1/virtualization/media") return new Response(JSON.stringify(inventory));
      if (url === "/api/v1/virtualization/media/catalog") return new Response(JSON.stringify(catalog));
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
      if (url === "/api/v1/virtualization/media/catalog") return new Response(JSON.stringify(catalog));
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

  it("reviews and stages one fixed official Ubuntu acquisition", async () => {
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/v1/virtualization/media") return new Response(JSON.stringify({ ...inventory, inbox: { ...inventory.inbox, candidates: [] } }));
      if (url === "/api/v1/virtualization/media/catalog") return new Response(JSON.stringify(catalog));
      if (url === `/api/v1/virtualization/media/catalog/${catalogImage.id}/plans`) return new Response(JSON.stringify({ plan: {
        id: "acquire-plan", revision: "plan-revision", status: "draft", expiresAt: "2026-08-16T22:00:00.000Z", executable: true,
        input: { acquisitionId: "77777777-7777-4777-8777-777777777777", expectedCatalogRevision: catalog.revision, imageId: catalogImage.id },
        artifact: { ...catalogImage, state: undefined }, changes: ["Download one exact ISO"], verification: ["Verify complete SHA-256"], boundaries: ["No browser URL is accepted"], recovery: "Remove only generated state.", catalogRevision: catalog.revision,
      } }), { status: 201 });
      if (url === "/api/v1/virtualization/media/acquisition-plans/acquire-plan/stage") {
        expect(init).toMatchObject({ method: "POST" });
        return new Response(JSON.stringify({ job: { id: "acquire-job", state: "awaiting_approval", title: "Acquire Ubuntu" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
    }));
    render(<VmMediaLibrary csrfToken="csrf-one" onOpenRepair={onOpenRepair} />);
    expect(await screen.findByText("Official Ubuntu Server catalog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review official download" }));
    expect(await screen.findByRole("heading", { name: "Acquire Ubuntu Server 26.04 LTS" })).toBeTruthy();
    expect(screen.getByText(catalogImage.sha256)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage official download approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledOnce());
  });
});
