import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VmPlanner from "./VmPlanner";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VM planner", () => {
  it("loads managed media and generates a non-executable reviewed plan", async () => {
    const options = {
      mediaRoot: "/var/lib/libvirt/boot",
      mediaError: null,
      isoImages: [{ name: "ubuntu.iso", sizeBytes: 5 * 1024 * 1024 * 1024, modifiedAt: "2026-08-14T12:00:00Z" }],
      hostCapacity: { cpuThreads: 8, memoryMiB: 32768 },
      limits: {
        vcpus: { minimum: 1, maximum: 32 },
        memoryMiB: { minimum: 1024, maximum: 131072 },
        diskGiB: { minimum: 8, maximum: 4096 },
      },
      profiles: [{ id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04", minimumMemoryMiB: 2048, minimumDiskGiB: 20 }],
      networks: [{ name: "default", kind: "NAT", recommended: true }],
      firmware: ["uefi", "bios"],
    };
    const plan = {
      revision: "revision12345678",
      executable: false,
      requiresRestrictedHelper: true,
      createdAt: "2026-08-14T12:00:00Z",
      input: { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false },
      profile: { label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04" },
      media: options.isoImages[0],
      warnings: [],
      command: { program: "virt-install", arguments: [], display: "virt-install --name ubuntu-lab" },
      gates: ["Execute through the restricted libvirt helper"],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = url.endsWith("planning-options") ? options : { ok: true, plan };
      if (init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toMatchObject({ name: "ubuntu-lab", isoFile: "ubuntu.iso" });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<VmPlanner onClose={vi.fn()} />);

    expect(await screen.findByText(/host CPU threads/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("VM name"), { target: { value: "ubuntu-lab" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed plan" }));

    expect(await screen.findByText("Validated, not executable")).toBeTruthy();
    expect(screen.getByText("virt-install --name ubuntu-lab")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply remains locked" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
